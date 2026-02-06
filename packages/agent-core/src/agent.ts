/**
 * Base agent implementation with LLM tool calling
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  TaskResult,
  TraceEntry,
  LLMTier,
  Tracer,
  AgentMemory,
  AgentEvent,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import {
  useLLM,
  type ILLM,
  type LLMMessage,
  type LLMTool,
  type LLMToolCall,
  type LLMToolCallResponse,
} from '@kb-labs/sdk';

/**
 * Tool execution result
 */
interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}
import { createEventEmitter } from './events/event-emitter.js';
import { SessionManager } from './planning/session-manager.js';

/**
 * Default instruction file names to scan (in order of priority)
 */
const INSTRUCTION_FILE_NAMES = ['AGENT.md', 'KB_AGENT.md', '.agent.md'];

/**
 * Generate unique agent ID
 */
function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Base Agent with LLM tool calling
 */
export class Agent {
  private config: AgentConfig;
  private toolRegistry: ToolRegistry;
  private filesCreated: Set<string> = new Set();
  private filesModified: Set<string> = new Set();
  private filesRead: Set<string> = new Set();
  private trace: TraceEntry[] = [];
  private totalTokens = 0;
  private tracer?: Tracer;
  private memory?: AgentMemory;
  private currentTask?: string;
  private eventEmitter = createEventEmitter();
  private startTime = 0;
  private startTimestamp = ''; // ISO string for startedAt in agent:end events

  /** Unique ID for this agent instance (for event correlation) */
  public readonly agentId: string;

  /**
   * User context injected during execution (corrections, feedback)
   * Will be included in the next LLM call
   */
  private injectedUserContext: string[] = [];

  constructor(config: AgentConfig, toolRegistry: ToolRegistry) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.tracer = config.tracer;
    this.memory = config.memory;

    // Generate unique ID for this agent instance
    this.agentId = config.agentId || generateAgentId();

    // Subscribe external callback if provided
    if (config.onEvent) {
      this.eventEmitter.on(config.onEvent);
    }
  }

  /**
   * Emit event to all listeners
   * Automatically adds agentId and parentAgentId for event correlation
   */
  private emit(event: AgentEvent): void {
    // Add hierarchical correlation IDs to all events
    const enrichedEvent = {
      ...event,
      agentId: this.agentId,
      parentAgentId: this.config.parentAgentId,
    };
    this.eventEmitter.emit(enrichedEvent);
  }

  /**
   * Inject user context (correction/feedback) into the running agent
   * This context will be included in the next LLM call as a system message
   *
   * @param message - User message to inject (correction, feedback, etc.)
   */
  injectUserContext(message: string): void {
    this.injectedUserContext.push(message);
    this.log(`💬 User context injected: ${message.slice(0, 100)}...`);

    // Emit event for UI
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: 'Processing user feedback...',
      },
    });
  }

  /**
   * Get and clear injected user context
   * Called before each LLM call to include user feedback
   */
  private consumeInjectedContext(): string | null {
    if (this.injectedUserContext.length === 0) {
      return null;
    }

    const context = this.injectedUserContext
      .map((msg, i) => `[User Feedback ${i + 1}]: ${msg}`)
      .join('\n\n');

    this.injectedUserContext = [];
    return context;
  }

  /**
   * Execute task with LLM tool calling
   */
  async execute(task: string): Promise<TaskResult> {
    // Check if mode-based execution is requested
    if (this.config.mode && this.config.mode.mode !== 'execute') {
      const { getModeHandler } = await import('./modes/mode-handler');
      const handler = await getModeHandler(this.config.mode);
      return handler.execute(task, this.config, this.toolRegistry);
    }

    // Standard execution
    if (!this.config.enableEscalation) {
      return this.executeWithTier(task, this.config.tier || 'small');
    }

    // Tier escalation enabled
    const tiers: LLMTier[] = ['small', 'medium', 'large'];
    const startTierIndex = tiers.indexOf(this.config.tier || 'small');

    for (let i = startTierIndex; i < tiers.length; i++) {
      const tier = tiers[i]!;
      this.log(`\n🎯 Trying with tier: ${tier}`);

      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential tier escalation required: must try each tier in order and await result before trying next
        const result = await this.executeWithTier(task, tier);
        if (result.success) {
          if (tier !== this.config.tier) {
            this.log(`✅ Succeeded after escalation to ${tier} tier`);
          }
          return result;
        }

        if (i < tiers.length - 1) {
          this.log(
            `⚠️  Failed with ${tier} tier, escalating to ${tiers[i + 1]}...`
          );
        }
      } catch (error) {
        this.log(`❌ Error with ${tier} tier: ${error}`);
        if (i === tiers.length - 1) {
          throw error;
        }
      }
    }

    return this.executeWithTier(task, 'large');
  }

  /**
   * Execute with specific tier
   */
  private async executeWithTier(
    task: string,
    tier: LLMTier
  ): Promise<TaskResult> {
    this.logTaskHeader(task, tier);
    this.resetState();
    this.currentTask = task;
    this.startTime = Date.now();
    this.startTimestamp = new Date().toISOString();

    // Emit agent:start event
    this.emit({
      type: 'agent:start',
      timestamp: this.startTimestamp,
      sessionId: this.config.sessionId,
      data: {
        task,
        tier,
        maxIterations: this.config.maxIterations,
        toolCount: this.toolRegistry.getDefinitions().length,
      },
    });

    // Emit status change
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: 'Starting task execution',
      },
    });

    // Record task start in memory
    if (this.memory) {
      await this.memory.add({
        content: `Task started: ${task}`,
        type: 'task',
        metadata: {
          taskId: `task-${Date.now()}`,
        },
      });
    }

    const systemPrompt = await this.buildSystemPrompt();

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
    ];

    // Load conversation history from previous runs in this session
    // Uses only agent:end summaries (truncated to 500 chars) to prevent token overflow
    if (this.config.sessionId && this.config.workingDir) {
      const sessionManager = new SessionManager(this.config.workingDir);
      const previousTurns = await sessionManager.getConversationHistory(this.config.sessionId, 3);

      if (previousTurns.length > 0) {
        this.log(`📜 Loaded ${previousTurns.length} previous turn(s) from session history`);

        for (const turn of previousTurns) {
          // Ensure non-empty content for all messages
          if (turn.userTask?.trim()) {
            messages.push({ role: 'user', content: turn.userTask });
          }
          if (turn.agentResponse?.trim()) {
            messages.push({ role: 'assistant', content: turn.agentResponse });
          }
        }
      }
    }

    // Add current task
    messages.push({
      role: 'user',
      content: task,
    });

    const llm = useLLM({ tier });
    if (!llm || !llm.chatWithTools) {
      return this.createFailureResult('LLM or chatWithTools not available', 0);
    }

    const tools = this.convertToolDefinitions();

    // Trace task start with system prompt and available tools
    this.recordTrace({
      iteration: 0,
      timestamp: new Date().toISOString(),
      type: 'task_start',
      data: {
        task,
        tier,
        systemPrompt,
        availableTools: tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      },
      durationMs: 0,
    });

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      this.logIterationHeader(iteration);

      const iterationStartTimestamp = new Date().toISOString();

      // Emit iteration:start
      this.emit({
        type: 'iteration:start',
        timestamp: iterationStartTimestamp,
        sessionId: this.config.sessionId,
        data: {
          iteration,
          maxIterations: this.config.maxIterations,
        },
      });

      try {
        // eslint-disable-next-line no-await-in-loop -- Agent iteration loop requires sequential LLM calls: each response depends on previous tool results
        const response = await this.callLLMWithTools(llm, messages, tools, tier, iteration);

        // Check if done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // Emit iteration:end (no tool calls = done) with startedAt
          this.emit({
            type: 'iteration:end',
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            startedAt: iterationStartTimestamp,
            data: {
              iteration,
              hadToolCalls: false,
              toolCallCount: 0,
            },
          } as AgentEvent);

          // eslint-disable-next-line no-await-in-loop -- Final validation in iteration loop before returning result
          const validation = await this.validateTaskCompletion(task, response.content);
          // eslint-disable-next-line no-await-in-loop -- Creating success result in iteration loop: must await memory recording
          return await this.createSuccessResult(validation, iteration);
        }

        // Execute tools and update messages
        // eslint-disable-next-line no-await-in-loop -- Tool execution in iteration loop: must wait for all tools to complete before next iteration
        const toolResults = await this.executeToolCalls(response.toolCalls, iteration);
        this.appendToolMessagesToHistory(messages, response, toolResults);

        // Emit iteration:end (with tool calls) with startedAt
        this.emit({
          type: 'iteration:end',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          startedAt: iterationStartTimestamp,
          data: {
            iteration,
            hadToolCalls: true,
            toolCallCount: response.toolCalls.length,
          },
        } as AgentEvent);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`\n❌ Error in iteration ${iteration}: ${errorMsg}\n`);

        // Emit agent:error
        this.emit({
          type: 'agent:error',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          data: {
            error: errorMsg,
            iteration,
            recoverable: false,
          },
        });

         
        return this.createFailureResult(`Failed: ${errorMsg}`, iteration, errorMsg);
      }
    }

    return this.createFailureResult(
      `Max iterations (${this.config.maxIterations}) reached without completion`,
      this.config.maxIterations
    );
  }

  /**
   * Log task header
   */
  private logTaskHeader(task: string, tier: LLMTier): void {
    this.log(`\n${'='.repeat(60)}`);
    this.log(`🤖 Agent executing task (tier: ${tier})`);
    this.log(`${'='.repeat(60)}\n`);
    this.log(`📋 Task: ${task}\n`);
  }

  /**
   * Reset agent state
   */
  private resetState(): void {
    this.filesCreated.clear();
    this.filesModified.clear();
    this.filesRead.clear();
    this.trace = [];
    this.totalTokens = 0;
  }

  /**
   * Convert tool definitions to LLM format
   */
  private convertToolDefinitions(): LLMTool[] {
    const toolDefinitions = this.toolRegistry.getDefinitions();
    return toolDefinitions.map(td => ({
      name: td.function.name,
      description: td.function.description,
      inputSchema: td.function.parameters as Record<string, unknown>,
    }));
  }

  /**
   * Log iteration header
   */
  private logIterationHeader(iteration: number): void {
    this.log(`\n${'─'.repeat(60)}`);
    this.log(`📍 Iteration ${iteration}/${this.config.maxIterations}`);
    this.log(`${'─'.repeat(60)}\n`);
  }

  /**
   * Call LLM with tools and track metrics
   */
  private async callLLMWithTools(
    llm: ILLM,
    messages: LLMMessage[],
    tools: LLMTool[],
    tier: LLMTier,
    iteration: number
  ): Promise<LLMToolCallResponse> {
    const startTime = Date.now();

    // Check for injected user context and add to messages
    const injectedContext = this.consumeInjectedContext();
    if (injectedContext) {
      messages.push({
        role: 'user',
        content: `⚠️ **Important User Feedback (received during execution):**\n\n${injectedContext}\n\nPlease take this feedback into account for your next actions.`,
      });
      this.log(`📨 Injected user context into LLM call`);
    }

    const llmStartTimestamp = new Date().toISOString();

    // Emit llm:start
    this.emit({
      type: 'llm:start',
      timestamp: llmStartTimestamp,
      sessionId: this.config.sessionId,
      data: {
        tier,
        messageCount: messages.length,
      },
    });

    // Emit status change
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: `Calling LLM (tier: ${tier})`,
      },
    });

    const response = await llm.chatWithTools!(messages, {
      tools,
      temperature: this.config.temperature,
    });

    const durationMs = Date.now() - startTime;

    // Track tokens
    const tokensUsed = response.usage
      ? (response.usage.promptTokens + response.usage.completionTokens) || 0
      : 0;

    if (response.usage) {
      this.totalTokens += tokensUsed;
    }

    // Emit llm:end with startedAt
    this.emit({
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: llmStartTimestamp,
      data: {
        tokensUsed,
        durationMs,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
        content: response.content || undefined,
      },
    } as AgentEvent);

    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'llm_call',
      data: {
        tier,
        tokensUsed,
      },
      durationMs,
    });

    // Record LLM response details
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'llm_response',
      data: {
        content: response.content || '',
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
        toolCallsCount: response.toolCalls?.length || 0,
      },
      durationMs: 0,
    });

    return response;
  }

  /**
   * Execute all tool calls sequentially
   */
  private async executeToolCalls(toolCalls: LLMToolCall[], iteration: number): Promise<LLMMessage[]> {
    const toolResults: LLMMessage[] = [];

    // Emit status change
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'executing',
        message: `Executing ${toolCalls.length} tool(s)`,
      },
    });

    for (const toolCall of toolCalls) {
      this.log(
        `🔧 ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}...)`
      );

      const toolStartTime = Date.now();
      const input = toolCall.input as Record<string, unknown>;

      const toolStartTimestamp = new Date().toISOString();

      // Emit tool:start with input and toolCallId for correlation
      this.emit({
        type: 'tool:start',
        timestamp: toolStartTimestamp,
        sessionId: this.config.sessionId,
        toolCallId: toolCall.id, // For correlating start/end/error events
        data: {
          toolName: toolCall.name,
          input,
          metadata: this.buildToolStartMetadata(toolCall.name, input),
        },
      } as AgentEvent);

      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential tool execution required: tools may have side effects and depend on order
        const result = await this.toolRegistry.execute(toolCall.name, input);

        const toolDurationMs = Date.now() - toolStartTime;

        this.trackFileOperation(toolCall.name, input);
        this.logToolResult(result);
        this.recordToolTrace(toolCall, result, iteration, toolDurationMs);

        // Emit tool:end with output, metadata, and correlation IDs
        this.emit({
          type: 'tool:end',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          toolCallId: toolCall.id, // Correlates with tool:start
          startedAt: toolStartTimestamp, // When tool started (for duration calc in UI)
          data: {
            toolName: toolCall.name,
            success: result.success,
            output: result.output,
            durationMs: toolDurationMs,
            metadata: this.buildToolEndMetadata(toolCall.name, input, result),
          },
        } as AgentEvent);

        toolResults.push(this.createToolResultMessage(toolCall.id, toolCall.name, result));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`  ✗ Tool error: ${errorMsg}`);

        // Emit tool:error with correlation IDs
        this.emit({
          type: 'tool:error',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          toolCallId: toolCall.id, // Correlates with tool:start
          startedAt: toolStartTimestamp, // When tool started
          data: {
            toolName: toolCall.name,
            error: errorMsg,
            metadata: {
              filePath: input.path as string | undefined,
            },
          },
        } as AgentEvent);

        toolResults.push(this.createToolResultMessage(toolCall.id, toolCall.name, { success: false, error: errorMsg }));
      }
    }

    return toolResults;
  }

  /**
   * Build metadata for tool:start event
   */
  private buildToolStartMetadata(
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    // File operations
    if (toolName === 'fs_read' || toolName === 'fs_edit' || toolName === 'fs_write') {
      return {
        filePath: input.path as string,
        uiHint: toolName === 'fs_edit' ? 'diff' : 'code',
      };
    }

    // Search operations
    if (toolName === 'grep_search' || toolName === 'glob_search') {
      return {
        query: input.pattern as string || input.query as string,
        uiHint: 'table',
      };
    }

    // Shell
    if (toolName === 'shell_exec') {
      return {
        command: input.command as string,
        uiHint: 'code',
      };
    }

    // Memory
    if (toolName.startsWith('memory_')) {
      return {
        memoryType: toolName.replace('memory_', ''),
        memoryScope: toolName === 'memory_preference' || toolName === 'memory_constraint' ? 'shared' : 'session',
      };
    }

    return undefined;
  }

  /**
   * Build metadata for tool:end event with result data
   */
  private buildToolEndMetadata(
    toolName: string,
    input: Record<string, unknown>,
    result: { success: boolean; output?: string; error?: string }
  ): Record<string, unknown> | undefined {
    // File read - include content
    if (toolName === 'fs_read' && result.success) {
      return {
        filePath: input.path as string,
        fileContent: result.output,
        uiHint: 'code',
      };
    }

    // File edit - include diff info
    if (toolName === 'fs_edit' && result.success) {
      return {
        filePath: input.path as string,
        oldContent: input.oldText as string,
        newContent: input.newText as string,
        summary: result.output,
        uiHint: 'diff',
      };
    }

    // File write
    if (toolName === 'fs_write' && result.success) {
      return {
        filePath: input.path as string,
        newContent: input.content as string,
        uiHint: 'code',
      };
    }

    // Search results
    if ((toolName === 'grep_search' || toolName === 'glob_search') && result.success) {
      return {
        query: input.pattern as string || input.query as string,
        summary: result.output?.slice(0, 500),
        uiHint: 'table',
      };
    }

    // Shell execution
    if (toolName === 'shell_exec') {
      return {
        command: input.command as string,
        exitCode: result.success ? 0 : 1,
        stdout: result.success ? result.output : undefined,
        stderr: result.success ? undefined : result.error,
        uiHint: 'code',
      };
    }

    return undefined;
  }

  /**
   * Log tool execution result
   */
  private logToolResult(result: ToolResult): void {
    this.log(
      result.success
        ? `  ✓ ${result.output?.slice(0, 200) || 'Success'}`
        : `  ✗ ${result.error}`
    );
  }

  /**
   * Record tool execution in trace
   */
  private recordToolTrace(
    toolCall: LLMToolCall,
    result: ToolResult,
    iteration: number,
    durationMs: number
  ): void {
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'tool_call',
      data: {
        toolName: toolCall.name,
        input: toolCall.input,
      },
      durationMs,
    });

    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      data: {
        toolName: toolCall.name,
        success: result.success,
        output: result.output,
        error: result.error,
      },
      durationMs: 0,
    });
  }

  /**
   * Create tool result message for LLM
   * Truncates long outputs to prevent token overflow
   *
   * Uses proper OpenAI tool response format:
   * - role: 'tool' (not 'user')
   * - toolCallId: matches the id from the tool_call
   */
  private createToolResultMessage(toolCallId: string, _toolName: string, result: ToolResult): LLMMessage {
    const MAX_TOOL_OUTPUT_CHARS = 8000; // ~2000 tokens per tool result

    let output = result.success
      ? result.output || 'Success'
      : `Error: ${result.error}`;

    // Truncate if too long
    if (output.length > MAX_TOOL_OUTPUT_CHARS) {
      output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n\n[...output truncated, showing first 8000 chars...]';
    }

    return {
      role: 'tool',
      content: output,
      toolCallId,
    };
  }

  /**
   * Append tool calls and results to message history
   */
  private appendToolMessagesToHistory(
    messages: LLMMessage[],
    response: LLMToolCallResponse,
    toolResults: LLMMessage[]
  ): void {
    // Note: When LLM returns tool calls, content may be empty or null
    // We need to ensure non-empty content for the message
    // Use a placeholder if no content but has tool calls
    const content = response.content?.trim()
      || (response.toolCalls?.length ? '[Executing tools...]' : '');

    messages.push({
      role: 'assistant',
      content,
      toolCalls: response.toolCalls,
    });

    messages.push(...toolResults);
  }

  /**
   * Create success result
   */
  private async createSuccessResult(
    validation: { success: boolean; summary: string },
    iteration: number
  ): Promise<TaskResult> {
    const durationMs = Date.now() - this.startTime;

    // Record in memory
    if (this.memory && this.currentTask) {
      await this.memory.add({
        content: `Task completed: ${this.currentTask}\nResult: ${validation.summary}`,
        type: 'result',
        metadata: {
          taskId: `task-${Date.now()}`,
          importance: 0.8,
        },
      });
    }

    // Emit agent:end with startedAt for duration calculation in UI
    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp, // When agent started
      data: {
        success: validation.success,
        summary: validation.summary,
        iterations: iteration,
        tokensUsed: this.totalTokens,
        durationMs,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
      },
    } as AgentEvent);

    // Emit status change
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'done',
        message: validation.summary,
      },
    });

    // Trace task end
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: validation.success,
        summary: validation.summary,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration,
        totalTokens: this.totalTokens,
      },
      durationMs: 0,
    });

    return {
      success: validation.success,
      summary: validation.summary,
      filesCreated: Array.from(this.filesCreated),
      filesModified: Array.from(this.filesModified),
      filesRead: Array.from(this.filesRead),
      iterations: iteration,
      tokensUsed: this.totalTokens,
      trace: this.trace,
    };
  }

  /**
   * Create failure result
   */
  private async createFailureResult(
    summary: string,
    iteration: number,
    error?: string
  ): Promise<TaskResult> {
    const durationMs = Date.now() - this.startTime;

    // Record in memory
    if (this.memory && this.currentTask) {
      await this.memory.add({
        content: `Task failed: ${this.currentTask}\nError: ${error || summary}`,
        type: 'result',
        metadata: {
          taskId: `task-${Date.now()}`,
          importance: 0.9,
        },
      });
    }

    // Emit agent:end (failure) with startedAt for duration calculation in UI
    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp, // When agent started
      data: {
        success: false,
        summary,
        iterations: iteration,
        tokensUsed: this.totalTokens,
        durationMs,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
      },
    } as AgentEvent);

    // Emit status change
    this.emit({
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'error',
        message: error || summary,
      },
    });

    // Trace task end
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: false,
        summary,
        error,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration,
        totalTokens: this.totalTokens,
      },
      durationMs: 0,
    });

    return {
      success: false,
      summary,
      filesCreated: Array.from(this.filesCreated),
      filesModified: Array.from(this.filesModified),
      filesRead: Array.from(this.filesRead),
      iterations: iteration,
      tokensUsed: this.totalTokens,
      error: error || summary,
      trace: this.trace,
    };
  }

  /**
   * Track file operations
   */
  private trackFileOperation(toolName: string, input: Record<string, unknown>): void {
    const filePath = input.path as string | undefined;

    if (!filePath) {
      return;
    }

    if (toolName === 'fs_write') {
      if (!this.filesModified.has(filePath)) {
        this.filesCreated.add(filePath);
      }
    } else if (toolName === 'fs_edit') {
      this.filesModified.add(filePath);
      this.filesCreated.delete(filePath);
    } else if (toolName === 'fs_read') {
      this.filesRead.add(filePath);
    }
  }

  /**
   * Validate task completion using LLM
   */
  private async validateTaskCompletion(
    task: string,
    agentResponse?: string
  ): Promise<{ success: boolean; summary: string }> {
    const llm = useLLM({ tier: 'small' });

    // Read content of modified/created files for validation
    let fileContents = '';
    if (this.filesModified.size > 0 || this.filesCreated.size > 0) {
      const filesToCheck = [
        ...Array.from(this.filesModified),
        ...Array.from(this.filesCreated),
      ].slice(0, 3);

      for (const file of filesToCheck) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Reading files sequentially for validation context, small bounded loop (max 3 files)
          const result = await this.toolRegistry.execute('fs_read', {
            path: file,
          });
          if (result.success && result.output) {
            fileContents += `\n--- ${file} ---\n${result.output.slice(0, 1000)}\n`;
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // For informational/research tasks, return the agent response directly as summary
    // This includes questions (what/how/why) AND research verbs (analyze/scan/inspect/review/identify/check)
    const isInformationalTask = /^(what|how|why|explain|tell|describe|show|list|find|search|where|when|who|analyze|scan|inspect|review|identify|check|examine|investigate|explore|map|determine)/i.test(task.trim());

    if (isInformationalTask && agentResponse && agentResponse.trim().length > 50) {
      // For questions, the agent's response IS the answer - use it directly
      return {
        success: true,
        summary: agentResponse,
      };
    }

    const prompt = `You are validating if an agent task was successfully completed.

**Original Task:** ${task}

**Files Created:** ${Array.from(this.filesCreated).join(', ') || 'None'}
**Files Modified:** ${Array.from(this.filesModified).join(', ') || 'None'}
**Files Read:** ${Array.from(this.filesRead).join(', ') || 'None'}

**Modified/Created Files Content:**${fileContents || '\n(No files to show)'}

${agentResponse ? `**Agent Response:**\n${agentResponse}\n` : ''}

**Validation Rules:**

1. **For informational/question tasks** (starting with "What", "How", "Why", "Explain", "Tell me", etc.):
   - SUCCESS if agent provided a text response (even if no files were created/modified)
   - The agent response answers the question, even if it references past actions
   - File operations are NOT required for these tasks
   - Example: "What did I write?" → agent says "You wrote X" = SUCCESS

2. **For action tasks** (create, edit, delete, run, etc.):
   - SUCCESS if appropriate files were created/modified/read
   - Example: "Create file.txt" → file.txt created = SUCCESS

IMPORTANT: If there is an Agent Response and the task is a question, consider it SUCCESS even if no files were modified.

**CRITICAL for summary field:**
- For research/informational tasks: Include ACTUAL FINDINGS - specific file paths, package names, code details discovered
- For action tasks: Describe what was done specifically
- NEVER write meta-descriptions like "The agent successfully provided..." - include the actual discovered content
- If Agent Response exists, extract and include the key information from it

Respond ONLY with valid JSON:
{"success": true/false, "summary": "actual findings with specific details"}`;

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      const response = await llm.complete(prompt, {
        temperature: 0,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        return {
          success: parsed.success === true,
          summary: parsed.summary || 'Task completed',
        };
      }
    } catch (error) {
      this.log(`⚠️  Validation error: ${error}`);
    }

    // Fallback: consider successful if files were modified/created OR agent provided a response
    const hasFileChanges =
      this.filesCreated.size > 0 || this.filesModified.size > 0;
    const hasResponse = Boolean(agentResponse && agentResponse.trim().length > 0);

    return {
      success: hasFileChanges || hasResponse,
      summary: hasFileChanges
        ? `Modified ${this.filesModified.size} file(s), created ${this.filesCreated.size} file(s)`
        : hasResponse
          ? agentResponse!.slice(0, 200)
          : 'Task completed without file changes',
    };
  }

  /**
   * Load project-specific agent instructions from AGENT.md or similar files
   * Scans working directory for instruction files in priority order
   */
  private loadProjectInstructions(): string | null {
    const workingDir = this.config.workingDir || process.cwd();

    for (const fileName of INSTRUCTION_FILE_NAMES) {
      const filePath = path.join(workingDir, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.trim().length > 0) {
            this.log(`📋 Loaded project instructions from ${fileName}`);
            return content;
          }
        }
      } catch {
        // Ignore read errors, try next file
      }
    }

    return null;
  }

  /**
   * Build system prompt with memory context and project instructions
   */
  private async buildSystemPrompt(): Promise<string> {
    let basePrompt = `You are an autonomous agent that helps users complete tasks.

**Available Tools:**
You have access to ${this.toolRegistry.getDefinitions().length} tools:
- Filesystem: fs_write, fs_read, fs_edit, fs_list
- Search: glob_search, grep_search
- Shell: shell_exec
- Memory: memory_get, memory_preference, memory_constraint, memory_correction, memory_finding, memory_blocker
- Session: session_save
- TODO (optional): todo_create, todo_update, todo_get
- Interaction: ask_user

**⚠️ CRITICAL RULES - MUST FOLLOW:**

1. **NEVER answer questions from general knowledge.** You MUST use tools to research the codebase first.
   - For "What is X?" → Use grep_search or glob_search to find X, then fs_read to understand it
   - For "How does X work?" → Find and read the actual implementation files
   - For "Explain X" → Search for X in the codebase and read relevant files

2. **Always show your research.** Before answering any informational question:
   - FIRST: Use search tools (glob_search, grep_search) to find relevant files
   - THEN: Use fs_read to read the actual code
   - FINALLY: Synthesize your answer based on what you found

3. **If you cannot find information, say so.** Never hallucinate or guess.

**Task Completion Criteria:**
- For code tasks: write, test, and verify the code works
- For information tasks: SEARCH → READ → SYNTHESIZE (not from memory!)
- For complex tasks: break down into steps and execute systematically

**Tool Usage Order for Questions:**
1. memory_get - check for relevant context
2. glob_search / grep_search - find relevant files
3. fs_read - read the actual code
4. (Only then) Provide your answer based on what you found

**Best Practices:**
- Use memory_preference to save user preferences (persistent)
- Use memory_constraint to save project rules (persistent)
- Use memory_correction when user corrects your understanding (session)
- Use memory_finding to save discoveries with confidence level (session)

**When Done:**
- Respond with a summary that includes WHAT FILES YOU READ and WHAT YOU FOUND
- Include file paths in your answer to show your research

Work systematically: SEARCH → READ → ANSWER.`;

    // Add project-specific instructions from AGENT.md (truncated to prevent overflow)
    const projectInstructions = this.loadProjectInstructions();
    if (projectInstructions) {
      const MAX_INSTRUCTIONS_CHARS = 4000; // ~1000 tokens
      const truncated = projectInstructions.length > MAX_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n\n[...instructions truncated...]'
        : projectInstructions;
      basePrompt += `\n\n**Project Instructions (from AGENT.md):**\n${truncated}`;
    }

    // Add memory context if available (already token-limited internally)
    if (this.memory) {
      const memoryContext = await this.memory.getContext(2000); // Reduced from 4000
      if (memoryContext.trim().length > 0) {
        basePrompt += `\n\n**Previous Context from Memory:**\n${memoryContext}`;
      }
    }

    return basePrompt;
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }

  /**
   * Record trace entry
   */
  private recordTrace(entry: TraceEntry): void {
    this.trace.push(entry);
    if (this.tracer) {
      this.tracer.trace(entry);
    }
  }
}
