/**
 * ContextFilterMiddleware — sliding window + output truncation for LLM calls.
 *
 * Wraps ContextFilter logic as an AgentMiddleware.
 *
 * Hook points:
 * - afterToolExec: append assistant + tool messages to internal history
 * - beforeLLMCall: return LLMCallPatch with filtered message window
 *
 * Design:
 *   - order = 15 (after budget=10, so budget's convergence nudge is already appended)
 *   - failPolicy = 'fail-open' (never breaks execution)
 *   - The middleware maintains a full history of assistant+tool messages,
 *     then slices the last N iterations on each LLM call.
 *   - System messages and the initial user task are ALWAYS preserved
 *     (they are identified by position: everything before the first assistant turn).
 *   - Tool outputs longer than maxOutputLength are truncated.
 */

import type { LLMCtx, LLMCallPatch, ToolExecCtx, ToolOutput } from '@kb-labs/agent-sdk';
import type { LLMMessage } from '@kb-labs/sdk';

export interface ContextFilterMwConfig {
  /** Max characters for tool output before truncation (default: 8000) */
  maxOutputLength?: number;
  /** Number of most-recent assistant+tool-result "rounds" to keep (default: 10) */
  slidingWindowSize?: number;
}

export class ContextFilterMiddleware {
  readonly name = 'context-filter';
  readonly order = 15;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 1000 };

  private readonly maxOutputLength: number;
  private readonly slidingWindowSize: number;

  // Accumulated assistant + tool messages from all iterations.
  // We do NOT store system/user prefix here — that comes from ctx.messages.
  private readonly rounds: Array<LLMMessage[]> = [];

  constructor(config: ContextFilterMwConfig = {}) {
    this.maxOutputLength = config.maxOutputLength ?? 8000;
    this.slidingWindowSize = config.slidingWindowSize ?? 10;
  }

  // ── afterToolExec: record completed round ──────────────────────────────────

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    // Find the latest assistant message from ctx.run that triggered this tool call.
    // We don't have direct access to messages here — we'll collect rounds in beforeLLMCall.
    // So this hook is intentionally empty: rounds are extracted from ctx.messages in beforeLLMCall.
    void ctx;
    void result;
  }

  // ── beforeLLMCall: apply sliding window + truncation ──────────────────────

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    const msgs = ctx.messages;

    // Find the boundary between "prefix" (system+task) and "conversation rounds"
    const prefixEnd = findPrefixEnd(msgs);

    if (prefixEnd >= msgs.length) {
      // No rounds yet — nothing to filter
      return undefined;
    }

    const prefix = msgs.slice(0, prefixEnd);
    const rounds = splitIntoRounds(msgs.slice(prefixEnd));

    // If we're within window — just truncate outputs, no messages removed
    if (rounds.length <= this.slidingWindowSize) {
      const truncated = rounds.flatMap((r) => r.map((m) => this.truncate(m)));
      if (!hasAnyTruncation(truncated, msgs.slice(prefixEnd))) {
        return undefined; // Nothing changed
      }
      return { messages: [...prefix, ...truncated] };
    }

    // Slice to last N rounds
    const kept = rounds.slice(-this.slidingWindowSize);
    const truncated = kept.flatMap((r) => r.map((m) => this.truncate(m)));

    const dropped = rounds.length - this.slidingWindowSize;
    const dropNote: LLMMessage = {
      role: 'system',
      content: `[Context filter: ${dropped} earlier iteration(s) removed to stay within context window]`,
    };

    return { messages: [...prefix, dropNote, ...truncated] };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private truncate(msg: LLMMessage): LLMMessage {
    if (msg.role !== 'tool') {return msg;}

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length <= this.maxOutputLength) {return msg;}

    const truncated = content.slice(0, this.maxOutputLength);
    const remaining = content.length - this.maxOutputLength;
    return {
      ...msg,
      content: `${truncated}\n\n... (${remaining} more characters truncated)`,
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
    if (msgs[i]?.role === 'assistant') {return i;}
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
  if (after.length !== before.length) {return true;}
  for (let i = 0; i < after.length; i++) {
    if (after[i]?.content !== before[i]?.content) {return true;}
  }
  return false;
}
