/**
 * SmartSummarizer - Async background summarization without blocking agent execution
 *
 * Features:
 * - Async summarization every N iterations
 * - Uses small-tier LLM (fast, cheap)
 * - Thread-safe via immutable snapshots
 * - FIFO queue processing
 * - Summaries cached in memory
 */

import type { LLMMessage, ILLM } from '@kb-labs/sdk';

export interface SummarizerConfig {
  /** Trigger summarization every N iterations */
  summarizationInterval?: number;
  /** LLM tier for summarization */
  llmTier?: 'small' | 'medium';
  /** Max tokens for summary */
  maxSummaryTokens?: number;
}

interface SummarizationTask {
  startIteration: number;
  endIteration: number;
  snapshot: ReadonlyArray<Readonly<LLMMessage>>;
}

/**
 * SmartSummarizer - Async background summarization
 */
export class SmartSummarizer {
  private config: Required<SummarizerConfig>;
  private summaries = new Map<number, string>(); // iteration -> summary
  private queue: SummarizationTask[] = [];
  private isProcessing = false;
  private llm?: ILLM;

  constructor(config: SummarizerConfig = {}) {
    this.config = {
      summarizationInterval: config.summarizationInterval ?? 10,
      llmTier: config.llmTier ?? 'small',
      maxSummaryTokens: config.maxSummaryTokens ?? 500,
    };
  }

  /**
   * Set LLM instance (must be called before triggering summarization)
   */
  setLLM(llm: ILLM): void {
    this.llm = llm;
  }

  /**
   * Trigger summarization (async, non-blocking)
   * @param historySnapshot - Immutable snapshot of full history
   * @param currentIteration - Current iteration number
   */
  async triggerSummarization(
    historySnapshot: ReadonlyArray<Readonly<LLMMessage>>,
    currentIteration: number
  ): Promise<void> {
    // Only summarize at intervals
    if (currentIteration % this.config.summarizationInterval !== 0) {
      return;
    }

    const startIter = currentIteration - this.config.summarizationInterval;
    const endIter = currentIteration;

    // Extract range from snapshot (immutable, thread-safe)
    const rangeSnapshot = historySnapshot.filter(
      (msg) => {
        // Assume messages have iteration metadata
        const iter = (msg as any).iteration;
        return iter !== undefined && iter >= startIter && iter < endIter;
      }
    );

    if (rangeSnapshot.length === 0) {
      return; // No messages in this range
    }

    // Create immutable task
    const task: SummarizationTask = {
      startIteration: startIter,
      endIteration: endIter,
      snapshot: Object.freeze([...rangeSnapshot]),
    };

    // Add to queue
    this.queue.push(task);

    // Process queue (async, don't wait)
    this.processQueue().catch((err) => {
      console.error(`[SmartSummarizer] Queue processing failed: ${err}`);
    });
  }

  /**
   * Process summarization queue (FIFO)
   */
  private async processQueue(): Promise<void> {
    // Already processing
    if (this.isProcessing) return;

    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;

        // Check if already summarized
        if (this.summaries.has(task.startIteration)) {
          continue;
        }

        // Generate summary
        const summary = await this.generateSummary(task);

        // Cache summary
        this.summaries.set(task.startIteration, summary);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Generate summary using LLM
   */
  private async generateSummary(task: SummarizationTask): Promise<string> {
    if (!this.llm) {
      throw new Error('LLM not set. Call setLLM() before triggering summarization.');
    }

    const { startIteration, endIteration, snapshot } = task;

    // Build compressed context (just tool calls and results)
    const compressedContext = snapshot
      .map((msg, idx) => {
        if (msg.role === 'tool') {
          const toolName = (msg as any).name || 'unknown';
          const content = msg.content || '';
          const preview = content.slice(0, 100);
          return `Tool: ${toolName}\nResult: ${preview}${content.length > 100 ? '...' : ''}`;
        }
        if (msg.role === 'assistant') {
          const toolCalls = (msg as any).tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            return `Agent called: ${toolCalls.map((tc: any) => tc.function?.name).join(', ')}`;
          }
        }
        return null;
      })
      .filter((line) => line !== null)
      .join('\n\n');

    // Summarization prompt
    const prompt = `Summarize agent work from iterations ${startIteration} to ${endIteration}.

${compressedContext}

Provide concise summary (≤200 words):
- Files created/modified
- Tools used
- Key accomplishments
- Issues encountered

Format as bullet points.`;

    const messages: LLMMessage[] = [
      { role: 'user', content: prompt },
    ];

    // Call LLM (use small tier for speed)
    const response = await this.llm.chat(messages, {
      temperature: 0.1, // Deterministic
      max_tokens: this.config.maxSummaryTokens,
    });

    return response.content || '(No summary generated)';
  }

  /**
   * Get summary for iteration range
   * @param startIteration - Start of range (e.g., 0 for iterations 0-9)
   */
  getSummary(startIteration: number): string | null {
    return this.summaries.get(startIteration) || null;
  }

  /**
   * Check if summary exists for iteration
   */
  hasSummary(iteration: number): boolean {
    // Check if iteration falls within any summarized range
    for (const key of this.summaries.keys()) {
      if (iteration >= key && iteration < key + this.config.summarizationInterval) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all summaries for current context
   * Returns summaries in chronological order
   */
  getAllSummaries(): Array<{ startIteration: number; summary: string }> {
    const result: Array<{ startIteration: number; summary: string }> = [];

    for (const [startIter, summary] of this.summaries.entries()) {
      result.push({ startIteration: startIter, summary });
    }

    // Sort by iteration
    result.sort((a, b) => a.startIteration - b.startIteration);

    return result;
  }

  /**
   * Clear all summaries (e.g., on new task)
   */
  clearSummaries(): void {
    this.summaries.clear();
    this.queue = [];
  }

  /**
   * Get summarization stats
   */
  getStats(): {
    totalSummaries: number;
    queueLength: number;
    isProcessing: boolean;
    summaryRanges: Array<{ start: number; end: number }>;
  } {
    const ranges = Array.from(this.summaries.keys()).map((start) => ({
      start,
      end: start + this.config.summarizationInterval,
    }));

    return {
      totalSummaries: this.summaries.size,
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      summaryRanges: ranges.sort((a, b) => a.start - b.start),
    };
  }
}
