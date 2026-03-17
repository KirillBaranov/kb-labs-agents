/**
 * ContextFilterMiddleware — sliding window + output truncation + optional compaction.
 *
 * Hook points:
 * - afterToolExec: (intentionally empty — rounds extracted from ctx.messages in beforeLLMCall)
 * - beforeLLMCall: return LLMCallPatch with filtered message window
 *
 * Design:
 *   - order = 15 (after budget=10, so budget's convergence nudge is already appended)
 *   - failPolicy = 'fail-open' (never breaks execution)
 *   - The middleware slices the last N iterations on each LLM call.
 *   - System messages and the initial user task are ALWAYS preserved.
 *   - Tool outputs longer than maxOutputLength are truncated.
 *   - When enableCompaction is true, dropped rounds are summarized by a small-tier LLM
 *     instead of being silently removed.
 */

import type { LLMCtx, LLMCallPatch, ToolExecCtx, ToolOutput } from '@kb-labs/agent-sdk';
import { useLLM, type ILLM, type LLMMessage } from '@kb-labs/sdk';

export interface ContextFilterMwConfig {
  /** Max characters for tool output before truncation (default: 8000) */
  maxOutputLength?: number;
  /** Number of most-recent assistant+tool-result "rounds" to keep (default: 10) */
  slidingWindowSize?: number;
  /** When true, dropped rounds are summarized by LLM instead of silently removed (default: false) */
  enableCompaction?: boolean;
}

export class ContextFilterMiddleware {
  readonly name = 'context-filter';
  readonly order = 15;
  readonly config: { failPolicy: 'fail-open'; timeoutMs: number };

  private readonly maxOutputLength: number;
  private readonly slidingWindowSize: number;
  private readonly enableCompaction: boolean;

  // Accumulated assistant + tool messages from all iterations.
  // We do NOT store system/user prefix here — that comes from ctx.messages.
  private readonly rounds: Array<LLMMessage[]> = [];

  // Compaction cache: avoid re-summarizing on every LLM call when the dropped
  // set hasn't changed.
  private compactionCache: { boundary: number; summary: string } | null = null;
  private llm: ILLM | null = null;

  constructor(config: ContextFilterMwConfig = {}) {
    this.maxOutputLength = config.maxOutputLength ?? 8000;
    this.slidingWindowSize = config.slidingWindowSize ?? 10;
    this.enableCompaction = config.enableCompaction ?? false;

    // LLM calls for compaction need more time than simple array slicing.
    this.config = {
      failPolicy: 'fail-open',
      timeoutMs: this.enableCompaction ? 15_000 : 1000,
    };
  }

  // ── afterToolExec: intentionally empty ──────────────────────────────────────

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    void ctx;
    void result;
  }

  // ── beforeLLMCall: apply sliding window + truncation + optional compaction ──

  async beforeLLMCall(ctx: LLMCtx): Promise<LLMCallPatch | undefined> {
    const msgs = ctx.messages;

    // Find the boundary between "prefix" (system+task) and "conversation rounds"
    const prefixEnd = findPrefixEnd(msgs);

    if (prefixEnd >= msgs.length) {
      return undefined;
    }

    const prefix = msgs.slice(0, prefixEnd);
    const rounds = splitIntoRounds(msgs.slice(prefixEnd));

    // If we're within window — just truncate outputs, no messages removed
    if (rounds.length <= this.slidingWindowSize) {
      const truncated = rounds.flatMap((r) => r.map((m) => this.truncate(m)));
      if (!hasAnyTruncation(truncated, msgs.slice(prefixEnd))) {
        return undefined;
      }
      return { messages: [...prefix, ...truncated] };
    }

    // Rounds exceed window — need to drop older ones
    const kept = rounds.slice(-this.slidingWindowSize);
    const truncated = kept.flatMap((r) => r.map((m) => this.truncate(m)));
    const droppedRounds = rounds.slice(0, rounds.length - this.slidingWindowSize);
    const droppedCount = droppedRounds.length;

    ctx.run.eventBus.emit('middleware:event', {
      name: 'context-filter',
      event: 'trimmed',
      data: { droppedRounds: droppedCount, keptRounds: this.slidingWindowSize },
    });

    // Build summary of dropped rounds (compaction or simple note)
    const summaryContent = await this.buildDropSummary(droppedRounds, droppedCount);
    const summaryMsg: LLMMessage = { role: 'system', content: summaryContent };

    return { messages: [...prefix, summaryMsg, ...truncated] };
  }

  // ── compaction ─────────────────────────────────────────────────────────────

  /**
   * Build a summary for dropped rounds.
   * With compaction enabled: LLM summarization (cached).
   * Without compaction: simple "[N earlier iterations removed]" note.
   */
  private async buildDropSummary(
    droppedRounds: LLMMessage[][],
    droppedCount: number,
  ): Promise<string> {
    if (!this.enableCompaction) {
      return `[Context filter: ${droppedCount} earlier iteration(s) removed to stay within context window]`;
    }

    // Check cache: if boundary hasn't changed, reuse previous summary
    if (this.compactionCache && this.compactionCache.boundary === droppedCount) {
      return this.compactionCache.summary;
    }

    try {
      const summary = await this.summarizeRounds(droppedRounds);
      this.compactionCache = { boundary: droppedCount, summary };
      return summary;
    } catch {
      // Fallback on LLM error — never break execution
      return `[Context filter: ${droppedCount} earlier iteration(s) removed to stay within context window]`;
    }
  }

  /**
   * Call small-tier LLM to summarize dropped rounds into a compact block.
   */
  private async summarizeRounds(rounds: LLMMessage[][]): Promise<string> {
    if (!this.llm) {
      this.llm = useLLM({ tier: 'small' }) ?? null;
    }
    if (!this.llm?.complete) {
      throw new Error('No LLM available for compaction');
    }

    // Flatten rounds into a readable transcript, truncating each message
    const transcript = rounds
      .map((round, i) => {
        const lines = round.map((m) => {
          const content = typeof m.content === 'string'
            ? m.content.slice(0, 2000)
            : JSON.stringify(m.content ?? '').slice(0, 2000);
          return `[${m.role}] ${content}`;
        });
        return `--- Round ${i + 1} ---\n${lines.join('\n')}`;
      })
      .join('\n\n');

    // Cap total input to avoid blowing context on the summarization call itself
    const cappedTranscript = transcript.slice(0, 12_000);

    const prompt = [
      'Summarize the following agent conversation rounds into a concise recap.',
      'Focus on: (1) what tools were called and key results, (2) files read/modified,',
      '(3) key findings and decisions made, (4) any errors encountered.',
      'Output a compact summary (max 500 words). Use bullet points.',
      'Do NOT include raw tool outputs — only summarize key information.',
      '',
      cappedTranscript,
    ].join('\n');

    const response = await this.llm.complete(prompt, {
      maxTokens: 800,
      temperature: 0.1,
    });

    const text = typeof response === 'string' ? response : response?.content ?? '';

    return `[Compacted summary of ${rounds.length} earlier iteration(s)]\n\n${text.trim()}`;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private truncate(msg: LLMMessage): LLMMessage {
    if (msg.role !== 'tool') { return msg; }

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length <= this.maxOutputLength) { return msg; }

    const truncated = content.slice(0, this.maxOutputLength);
    const remaining = content.length - this.maxOutputLength;
    return {
      ...msg,
      content: `${truncated}\n\n[TRUNCATED: ${remaining} more characters not shown — tool output was cut at ${this.maxOutputLength} chars. If the relevant content may be in the truncated part, use a more specific query or request a smaller range.]`,
    };
  }
}

// ── module-level helpers ─────────────────────────────────────────────────────

/**
 * Returns the index of the first message that belongs to a conversation round
 * (i.e., the first 'assistant' message). Everything before that is the prefix.
 */
function findPrefixEnd(msgs: readonly LLMMessage[]): number {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === 'assistant') { return i; }
  }
  return msgs.length;
}

/**
 * Split messages into "rounds". Each round starts with an assistant message
 * (possibly with tool calls) followed by zero or more tool result messages.
 */
function splitIntoRounds(msgs: readonly LLMMessage[]): LLMMessage[][] {
  const rounds: LLMMessage[][] = [];
  let current: LLMMessage[] = [];

  for (const msg of msgs) {
    if (msg.role === 'assistant') {
      if (current.length > 0) {
        rounds.push(current);
      }
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    rounds.push(current);
  }

  return rounds;
}

/**
 * Quick check: did truncation actually change any message content?
 */
function hasAnyTruncation(after: LLMMessage[], before: readonly LLMMessage[]): boolean {
  if (after.length !== before.length) { return true; }
  for (let i = 0; i < after.length; i++) {
    if (after[i]?.content !== before[i]?.content) { return true; }
  }
  return false;
}
