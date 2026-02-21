/**
 * Agent core constants — single source of truth for tunable values.
 *
 * Grouping rationale:
 * - CONTEXT: Context window management (truncation, sliding window)
 * - SUMMARIZER: Smart summarizer settings
 */

export const AGENT_CONTEXT = {
  /**
   * Maximum characters for a single tool output before truncation.
   * Roughly 2 000 tokens. Prevents individual tool results from flooding the context window.
   */
  maxToolOutputChars: 8_000,

  /**
   * Number of recent iterations to keep in the sliding context window.
   * Older iterations are dropped (but preserved in full history for tracing).
   */
  slidingWindowSize: 20,

  /**
   * Maximum characters for project instructions (CLAUDE.md / AGENT.md).
   * Roughly 3 000 tokens. Prevents large instruction files from consuming the entire budget.
   */
  maxInstructionsChars: 12_000,
} as const;

export const AGENT_SUMMARIZER = {
  /**
   * Run summarization every N iterations to compress old context.
   */
  summarizationInterval: 10,

  /**
   * Token budget for each generated summary.
   */
  maxSummaryTokens: 500,
} as const;

export const AGENT_TOOL_CACHE = {
  /**
   * TTL for tool result cache within a single execution (milliseconds).
   * Prevents duplicate calls from re-executing the same tool with identical args.
   */
  ttlMs: 60_000,

  /**
   * Number of recent iteration signatures kept for loop detection.
   */
  loopDetectionWindowSize: 6,

  /**
   * Minimum repeating iterations required to declare a loop.
   */
  loopDetectionMinRepeats: 3,
} as const;
