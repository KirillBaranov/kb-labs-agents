/**
 * @module @kb-labs/agent-contracts/outcome
 * Agent execution outcomes with failure handling
 *
 * Phase 3: Error Handling & Retry
 *
 * Provides structured outcomes for agent execution:
 * - Success with result and metadata
 * - Failure with classified error and partial results
 * - Retry suggestions based on failure kind
 */

/**
 * LLM model tier
 *
 * Abstract tiers for model selection:
 * - `small`: Fast, cheap models (e.g., gpt-4o-mini)
 * - `medium`: Balanced models (e.g., claude-sonnet-4-5)
 * - `large`: Powerful models (e.g., claude-opus-4-5)
 */
export type LLMTier = "small" | "medium" | "large";

/**
 * Runtime metadata for agent execution
 */
export interface RunMeta {
  /** Total execution duration in milliseconds */
  durationMs: number;

  /** Token usage breakdown */
  tokenUsage: {
    /** Tokens used in prompts */
    prompt: number;
    /** Tokens used in completions */
    completion: number;
  };

  /** Total number of tool calls made */
  toolCalls: number;

  /** Model tier used for execution */
  modelTier: LLMTier;
}

/**
 * Failure report with classification and retry suggestion
 */
export interface FailureReport {
  /**
   * Classified failure kind
   *
   * - `tool_error`: Tool execution failed (fs:write error, etc.)
   * - `timeout`: Execution exceeded time limit
   * - `validation_failed`: Output schema validation failed
   * - `stuck`: Detected infinite loop or stuck behavior
   * - `policy_denied`: Budget limit or permission denied
   * - `unknown`: Unexpected error
   */
  kind:
    | "tool_error"
    | "timeout"
    | "validation_failed"
    | "stuck"
    | "policy_denied"
    | "unknown";

  /** Human-readable error message */
  message: string;

  /**
   * Last few tool calls before failure (for debugging)
   */
  lastToolCalls?: Array<{
    tool: string;
    args: unknown;
    error?: string;
  }>;

  /**
   * Suggestion: should this be retried?
   *
   * - `true`: Transient error, retry recommended
   * - `false`: Permanent failure, retry won't help
   */
  suggestedRetry?: boolean;
}

/**
 * Agent execution outcome
 *
 * Phase 3: Discriminated union for success/failure with partial results
 *
 * Success:
 * ```typescript
 * { ok: true, result: AgentResult, meta: RunMeta }
 * ```
 *
 * Failure (with partial result):
 * ```typescript
 * { ok: false, failure: FailureReport, partial?: AgentResult, meta: RunMeta }
 * ```
 *
 * **Key feature:** Partial results preserved even on failure!
 * Prevents loss of work when agent partially completes task.
 */
export type AgentOutcome<TResult = unknown> =
  | {
      ok: true;
      result: TResult;
      meta: RunMeta;
    }
  | {
      ok: false;
      failure: FailureReport;
      partial?: TResult;
      meta: RunMeta;
    };
