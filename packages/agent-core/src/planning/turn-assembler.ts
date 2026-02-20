/**
 * @module @kb-labs/agent-core/planning/turn-assembler
 * Assembles Turn snapshots from raw AgentEvent stream
 */

import type {
  AgentEvent,
  Turn,
  TurnStep,
  ThinkingStep,
  ToolUseStep,
  TextStep,
  ErrorStep,
} from '@kb-labs/agent-contracts';

/**
 * Assembles Turn snapshots from raw AgentEvent stream.
 * Maintains state for in-progress turns and emits snapshots on updates.
 */
export class TurnAssembler {
  /** Active turns being assembled (turnId -> Turn) */
  private activeTurns = new Map<string, Turn>();

  /** Event buffer for each turn (for replay/debugging) */
  private eventBuffers = new Map<string, AgentEvent[]>();

  /** Next sequence number per session */
  private sequenceCounters = new Map<string, number>();

  /**
   * Process an event and return updated Turn snapshot if changed.
   * Returns null if no snapshot update needed.
   */
  processEvent(event: AgentEvent): Turn | null {
    // Determine turn ID from event
    const turnId = this.getTurnId(event);
    if (!turnId) return null; // Event doesn't belong to a turn

    // Get or create turn
    let turn = this.activeTurns.get(turnId);
    if (!turn) {
      turn = this.createTurn(event, turnId);
      this.activeTurns.set(turnId, turn);
    }

    // Buffer event for debugging
    const buffer = this.eventBuffers.get(turnId) ?? [];
    buffer.push(event);
    this.eventBuffers.set(turnId, buffer);

    // Update turn based on event type
    const updated = this.updateTurn(turn, event);

    // Check if turn completed
    let completed = false;
    if (this.isTurnComplete(event)) {
      turn.status = 'completed';
      turn.completedAt = event.timestamp;
      this.activeTurns.delete(turnId);
      this.eventBuffers.delete(turnId);
      completed = true;
    }

    // Return turn if updated OR if it just completed (so caller can persist final status)
    return (updated || completed) ? turn : null;
  }

  /**
   * Async version of processEvent that uses external sequence generator.
   * Used when sequence needs to be persistent across SessionManager instances.
   */
  async processEventAsync(
    event: AgentEvent,
    getSequence: (sessionId: string) => Promise<number>
  ): Promise<Turn | null> {
    // Determine turn ID from event
    const turnId = this.getTurnId(event);
    if (!turnId) return null;

    // Get or create turn
    let turn = this.activeTurns.get(turnId);
    if (!turn) {
      turn = await this.createTurnAsync(event, turnId, getSequence);
      this.activeTurns.set(turnId, turn);
    }

    // Buffer event for debugging
    const buffer = this.eventBuffers.get(turnId) ?? [];
    buffer.push(event);
    this.eventBuffers.set(turnId, buffer);

    // Update turn based on event type
    const updated = this.updateTurn(turn, event);

    // Check if turn completed
    let completed = false;
    if (this.isTurnComplete(event)) {
      turn.status = 'completed';
      turn.completedAt = event.timestamp;
      this.activeTurns.delete(turnId);
      this.eventBuffers.delete(turnId);
      completed = true;
    }

    return (updated || completed) ? turn : null;
  }

  /**
   * Derive turn ID from event.
   * For root agents: use agentId
   * For sub-agents: return null (handled separately)
   */
  private getTurnId(event: AgentEvent): string | null {
    switch (event.type) {
      case 'agent:start':
      case 'agent:end':
      case 'agent:error':
        // Root agent events = turn boundaries
        return event.parentAgentId ? null : `turn-${event.agentId}`;

      case 'llm:start':
      case 'llm:stream':
      case 'llm:end':
      case 'tool:start':
      case 'tool:end':
      case 'tool:error':
      case 'status:change':
      case 'thinking:start':
      case 'thinking:chunk':
      case 'thinking:end':
        // Associate with current turn (assume belongs to most recent active turn)
        // In production, this should use event.metadata.turnId or similar
        const activeTurnIds = Array.from(this.activeTurns.keys());
        return activeTurnIds[activeTurnIds.length - 1] ?? null;

      default:
        return null;
    }
  }

  /**
   * Create initial Turn snapshot from agent:start event.
   */
  private createTurn(event: AgentEvent, turnId: string): Turn {
    const sessionId = (event.metadata?.sessionId as string) ?? 'unknown';

    // Use getNextSequence to properly increment counter
    // This ensures user turns and assistant turns have correct sequence order
    const sequence = this.getNextSequence(sessionId);

    return {
      id: turnId,
      type: 'assistant',
      sequence,
      startedAt: event.timestamp,
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: {
        agentId: event.agentId,
        agentName: (event.metadata?.agentName as string | undefined),
        taskId: (event.metadata?.taskId as string | undefined),
      },
    };
  }

  /**
   * Async version of createTurn that uses external sequence generator.
   */
  private async createTurnAsync(
    event: AgentEvent,
    turnId: string,
    getSequence: (sessionId: string) => Promise<number>
  ): Promise<Turn> {
    const sessionId = (event.metadata?.sessionId as string) ?? 'unknown';

    // Get sequence from external source (file system)
    const sequence = await getSequence(sessionId);

    return {
      id: turnId,
      type: 'assistant',
      sequence,
      startedAt: event.timestamp,
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: {
        agentId: event.agentId,
        agentName: (event.metadata?.agentName as string | undefined),
        taskId: (event.metadata?.taskId as string | undefined),
      },
    };
  }

  /**
   * Update turn with new event data.
   * Returns true if turn was modified.
   */
  private updateTurn(turn: Turn, event: AgentEvent): boolean {
    switch (event.type) {
      case 'thinking:start':
      case 'thinking:chunk': {
        // Find or create thinking step
        const lastStep = turn.steps[turn.steps.length - 1];
        const content = (event.data?.content as string) ?? '';

        if (lastStep?.type === 'thinking') {
          // Append to existing thinking
          (lastStep as ThinkingStep).content += content;
          return true;
        } else {
          // Create new thinking step
          const step: ThinkingStep = {
            type: 'thinking',
            id: `step-${turn.steps.length + 1}`,
            timestamp: event.timestamp,
            content,
          };
          turn.steps.push(step);
          return true;
        }
      }

      case 'status:change': {
        const statusPayload = (event.data ?? {}) as {
          status?: string;
          message?: string;
          toolName?: string;
        };
        const content = this.buildPublicStatusReasoning(statusPayload);
        if (!content) {
          return false;
        }

        const lastStep = turn.steps[turn.steps.length - 1];
        if (lastStep?.type === 'thinking' && lastStep.content === content) {
          return false;
        }

        const step: ThinkingStep = {
          type: 'thinking',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          content,
        };
        turn.steps.push(step);
        return true;
      }

      case 'tool:start': {
        const step: ToolUseStep = {
          type: 'tool_use',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          toolName: (event.data?.toolName as string) ?? 'unknown',
          toolCallId: (event.data?.toolCallId as string | undefined),
          input: (event.data?.input as Record<string, unknown>) ?? {},
          status: 'pending',
        };
        turn.steps.push(step);
        return true;
      }

      case 'tool:end': {
        // Find the matching tool_use step and update it in-place
        const toolCallId = event.data?.toolCallId as string | undefined;
        const toolName = (event.data?.toolName as string) ?? 'unknown';
        const existing = turn.steps.find(
          (s): s is ToolUseStep =>
            s.type === 'tool_use' &&
            s.status === 'pending' &&
            (toolCallId ? s.toolCallId === toolCallId : s.toolName === toolName)
        );
        if (existing) {
          existing.status = 'done';
          existing.output = event.data?.output;
          existing.durationMs = event.data?.durationMs as number | undefined;
        }
        return true;
      }

      case 'tool:error': {
        // Find the matching tool_use step and update it in-place
        const toolCallId = event.data?.toolCallId as string | undefined;
        const toolName = (event.data?.toolName as string) ?? 'unknown';
        const existing = turn.steps.find(
          (s): s is ToolUseStep =>
            s.type === 'tool_use' &&
            s.status === 'pending' &&
            (toolCallId ? s.toolCallId === toolCallId : s.toolName === toolName)
        );
        if (existing) {
          existing.status = 'error';
          existing.error = (event.data?.error as string) ?? 'Unknown error';
        }
        return true;
      }

      case 'llm:end': {
        const rawContent = (event.data?.content as string | undefined) ?? '';
        const content = this.sanitizePublicContent(rawContent);
        const hasToolCalls = Boolean((event.data as { hasToolCalls?: boolean } | undefined)?.hasToolCalls);

        if (content) {
          if (hasToolCalls) {
            const step: ThinkingStep = {
              type: 'thinking',
              id: `step-${turn.steps.length + 1}`,
              timestamp: event.timestamp,
              content,
            };
            turn.steps.push(step);
          } else {
            const step: TextStep = {
              type: 'text',
              id: `step-${turn.steps.length + 1}`,
              timestamp: event.timestamp,
              content,
              role: 'assistant',
            };
            turn.steps.push(step);
          }

          // Update metadata
          if (event.data?.usage) {
            const usage = event.data.usage as { total_tokens?: number };
            turn.metadata.totalTokens = (turn.metadata.totalTokens ?? 0) + (usage.total_tokens ?? 0);
          }

          return true;
        }
        return false;
      }

      case 'agent:error': {
        turn.status = 'failed';
        turn.completedAt = event.timestamp;
        turn.error = {
          code: (event.data?.code as string) ?? 'UNKNOWN',
          message: (event.data?.message as string) ?? 'Agent failed',
          details: event.data?.details,
        };
        const step: ErrorStep = {
          type: 'error',
          id: `step-${turn.steps.length + 1}`,
          timestamp: event.timestamp,
          code: turn.error.code,
          message: turn.error.message,
          details: turn.error.details,
        };
        turn.steps.push(step);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Check if event marks turn completion.
   */
  private isTurnComplete(event: AgentEvent): boolean {
    return event.type === 'agent:end' && !event.parentAgentId;
  }

  private sanitizePublicContent(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return '';
    }
    const normalized = trimmed.toLowerCase();
    if (
      normalized === '[executing tools...]' ||
      normalized === '[thinking...]' ||
      normalized === '[planning...]' ||
      normalized === '[analyzing...]'
    ) {
      return '';
    }
    return trimmed;
  }

  private buildPublicStatusReasoning(payload: { status?: string; message?: string; toolName?: string }): string | null {
    const status = (payload.status ?? '').toLowerCase();
    const message = (payload.message ?? '').trim();

    if (status === 'thinking') {
      return 'Analyzing context and choosing the next step.';
    }

    if (status === 'executing' && payload.toolName) {
      return `Checking facts with tool: ${this.formatToolName(payload.toolName)}.`;
    }

    if (!message) {
      return null;
    }

    const normalized = message.toLowerCase();
    if (normalized.includes('calling llm')) {
      return 'Reviewing context and planning the next action.';
    }
    if (normalized.includes('executing')) {
      return payload.toolName
        ? `Running step with tool: ${this.formatToolName(payload.toolName)}.`
        : 'Running the next step and collecting evidence.';
    }

    return null;
  }

  private formatToolName(name: string): string {
    return name
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Get all active turns (for session snapshots).
   */
  getActiveTurns(): Turn[] {
    return Array.from(this.activeTurns.values());
  }

  /**
   * Get next sequence number for a session (for user turns).
   * Also increments the counter so next turn gets a different sequence.
   */
  getNextSequence(sessionId: string): number {
    const current = this.sequenceCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(sessionId, next);
    return next;
  }

  /**
   * Get current sequence counter value (for testing/debugging).
   */
  getCurrentSequence(sessionId: string): number {
    return this.sequenceCounters.get(sessionId) ?? 0;
  }

  /**
   * Clear all state (for testing/cleanup).
   */
  reset(): void {
    this.activeTurns.clear();
    this.eventBuffers.clear();
    this.sequenceCounters.clear();
  }
}
