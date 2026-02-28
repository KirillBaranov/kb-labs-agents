/**
 * ContextFilter - Fast context filtering with zero-risk optimizations
 *
 * Features:
 * - Output truncation (large tool outputs → 500 chars)
 * - Tool call deduplication (cache identical calls)
 * - Sliding window (last N iterations)
 * - Thread-safe history management
 */

import type { LLMMessage } from '@kb-labs/sdk';

// Type alias for clarity in this module
type Message = LLMMessage;

export interface TruncationMetadata {
  truncated: boolean;
  originalLength: number;
  retrievable: boolean;
}

export interface ContextFilterConfig {
  /** Max characters for tool output before truncation */
  maxOutputLength?: number;
  /** Number of iterations to keep in sliding window */
  slidingWindowSize?: number;
  /** Enable tool call deduplication */
  enableDeduplication?: boolean;
}

export class ContextFilter {
  private fullHistory: Message[] = [];
  private dedupCache = new Map<string, Map<string, { iteration: number; result: any }>>();
  private config: Required<ContextFilterConfig>;
  private isAppending = false; // Simple lock for thread safety

  constructor(config: ContextFilterConfig = {}) {
    this.config = {
      maxOutputLength: config.maxOutputLength ?? 8000,
      slidingWindowSize: config.slidingWindowSize ?? 10,
      enableDeduplication: config.enableDeduplication ?? true,
    };
  }

  /**
   * Build default context for agent (fast, no LLM)
   * Returns: system + task + summaries (if any) + last N iterations (truncated)
   */
  buildDefaultContext(
    systemPrompt: Message,
    taskMessage: Message,
    currentIteration: number,
    summaries: string[] = []
  ): Message[] {
    const context: Message[] = [systemPrompt, taskMessage];

    // Add summaries if available (from Phase 2)
    if (summaries.length > 0) {
      context.push({
        role: 'system',
        content: `Previous Work Summary:\n${summaries.join('\n\n')}`,
      });
    }

    // Get last N iterations (sliding window) with pair-aware boundary
    const recentHistory = this.getRecentHistoryWithPairBoundary(this.config.slidingWindowSize);

    // Truncate large outputs
    const truncatedHistory = recentHistory.map((msg) => this.truncateMessage(msg));

    context.push(...truncatedHistory);

    return context;
  }

  /**
   * Get recent history based on iteration count (not message count).
   * Keeps messages from the last N unique iterations.
   * Messages without iteration metadata (user/system injected messages) are
   * always included. Ensures tool result messages are never orphaned from
   * their assistant message (required by OpenAI/Anthropic APIs).
   */
  private getRecentHistoryWithPairBoundary(windowSize: number): Message[] {
    if (this.fullHistory.length === 0) {
      return [];
    }

    // Collect unique iterations present in history
    const iterationsInHistory = new Set<number>();
    for (const msg of this.fullHistory) {
      const iter = (msg as Record<string, unknown>).iteration as number | undefined;
      if (iter !== undefined) {
        iterationsInHistory.add(iter);
      }
    }

    // If no iteration metadata at all, fall back to keeping all messages
    if (iterationsInHistory.size === 0) {
      return this.fullHistory.slice();
    }

    // Keep last N iterations
    const sortedIters = Array.from(iterationsInHistory).sort((a, b) => a - b);
    const keepIters = new Set(sortedIters.slice(-windowSize));
    const minKeepIter = Math.min(...keepIters);

    // Find index of first message belonging to a kept iteration
    let windowStart = 0;
    for (let i = 0; i < this.fullHistory.length; i++) {
      const msg = this.fullHistory[i];
      const iter = (msg as Record<string, unknown>).iteration as number | undefined;
      if (iter !== undefined && iter >= minKeepIter) {
        windowStart = i;
        break;
      }
    }

    // Walk backward to avoid cutting inside an assistant+tool group
    while (windowStart > 0) {
      const currentMsg = this.fullHistory[windowStart];
      if (currentMsg?.role !== 'tool') {
        break;
      }
      // Current message is a tool result — find its preceding assistant message
      let checkIdx = windowStart - 1;
      while (checkIdx >= 0) {
        const checkMsg = this.fullHistory[checkIdx];
        if (!checkMsg) { break; }
        if (checkMsg.role === 'assistant' && checkMsg.toolCalls && checkMsg.toolCalls.length > 0) {
          windowStart = checkIdx;
          break;
        } else if (checkMsg.role === 'tool') {
          checkIdx--;
        } else {
          break;
        }
      }
      break;
    }

    return this.fullHistory.slice(windowStart);
  }

  /**
   * Truncate large tool outputs to save tokens
   * Tier 1 optimization: Zero risk, pure efficiency
   */
  truncateMessage(msg: Message): Message {
    if (msg.role !== 'tool') {return msg;}

    const content = msg.content || '';
    const maxLen = this.config.maxOutputLength;

    // Short output - return as-is
    if (content.length <= maxLen) {return msg;}

    // Long output - truncate with hint
    const truncated = content.slice(0, maxLen);
    const remaining = content.length - maxLen;

    const metadata: TruncationMetadata = {
      truncated: true,
      originalLength: content.length,
      retrievable: true,
    };

    return {
      ...msg,
      content: `${truncated}\n\n... (${remaining} more characters truncated)`,
      metadata: {
        ...msg.metadata,
        ...metadata,
      },
    };
  }

  /**
   * Check if tool call is duplicate (already executed with same args)
   * Tier 1 optimization: Cache identical calls
   */
  isDuplicateToolCall(toolName: string, args: Record<string, any>): boolean {
    if (!this.config.enableDeduplication) {return false;}

    const argsHash = this.hashArgs(args);
    const toolCache = this.dedupCache.get(toolName);

    if (!toolCache) {return false;}
    return toolCache.has(argsHash);
  }

  /**
   * Get cached result for duplicate tool call
   */
  getDuplicateResult(toolName: string, args: Record<string, any>): { iteration: number; result: any } | null {
    if (!this.config.enableDeduplication) {return null;}

    const argsHash = this.hashArgs(args);
    const toolCache = this.dedupCache.get(toolName);

    if (!toolCache) {return null;}
    return toolCache.get(argsHash) || null;
  }

  /**
   * Mark tool call as seen (cache result)
   */
  markToolCallSeen(toolName: string, args: Record<string, any>, iteration: number, result: any): void {
    if (!this.config.enableDeduplication) {return;}

    const argsHash = this.hashArgs(args);

    if (!this.dedupCache.has(toolName)) {
      this.dedupCache.set(toolName, new Map());
    }

    this.dedupCache.get(toolName)!.set(argsHash, { iteration, result });
  }

  /**
   * Format duplicate response message
   */
  formatDuplicateResponse(toolName: string, iteration: number, result: any): string {
    const resultPreview = typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result, null, 2).slice(0, 200);

    return `Tool "${toolName}" was already called in iteration ${iteration} with identical arguments. Cached result:\n\n${resultPreview}`;
  }

  /**
   * Get thread-safe snapshot of full history
   * Returns immutable copy (safe for async operations)
   */
  getHistorySnapshot(): ReadonlyArray<Readonly<Message>> {
    // Deep copy to prevent mutations
    return this.fullHistory.map((msg) => Object.freeze({ ...msg }));
  }

  /**
   * Append messages to history (atomic, thread-safe)
   */
  async appendToHistory(messages: Message[]): Promise<void> {
    // Simple lock mechanism
    while (this.isAppending) {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }

    this.isAppending = true;
    try {
      this.fullHistory.push(...messages);
    } finally {
      this.isAppending = false;
    }
  }

  /**
   * Get full history (for debugging/tracing)
   * WARNING: Returns reference, not copy. Use getHistorySnapshot() for thread safety.
   */
  getFullHistory(): Message[] {
    return this.fullHistory;
  }

  /**
   * Clear deduplication cache (e.g., when context changes significantly)
   */
  clearDedupCache(): void {
    this.dedupCache.clear();
  }

  /**
   * Get deduplication statistics
   */
  getDedupStats(): { totalTools: number; totalCachedCalls: number; cacheByTool: Record<string, number> } {
    const stats = {
      totalTools: this.dedupCache.size,
      totalCachedCalls: 0,
      cacheByTool: {} as Record<string, number>,
    };

    for (const [toolName, cache] of this.dedupCache.entries()) {
      const count = cache.size;
      stats.cacheByTool[toolName] = count;
      stats.totalCachedCalls += count;
    }

    return stats;
  }

  /**
   * Hash args for deduplication
   * Uses JSON.stringify (simple, good enough for now)
   */
  private hashArgs(args: Record<string, any>): string {
    return JSON.stringify(args, Object.keys(args).sort());
  }
}
