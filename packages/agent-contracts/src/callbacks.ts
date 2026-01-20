/**
 * @module @kb-labs/agent-contracts/callbacks
 * Progress tracking callbacks for V2 orchestrator
 *
 * Phase 5: Progress Tracking
 *
 * Provides callback interfaces for real-time progress updates:
 * - Plan created
 * - Subtask start/complete/failed
 * - Plan adaptation
 * - Final completion with stats
 */

import type { AgentOutcome } from './outcome.js';

/**
 * Subtask definition
 *
 * Represents a single unit of work in the execution plan
 */
export interface SubTask {
  /** Unique subtask ID */
  id: string;
  /** Agent ID to execute this subtask */
  agentId: string;
  /** Task description */
  description: string;
  /** Priority (1-10, lower = higher priority) */
  priority?: number;
  /** Dependencies on other subtasks (by ID) */
  dependencies?: string[];
  /** Estimated complexity */
  estimatedComplexity?: 'low' | 'medium' | 'high';
}

/**
 * Execution plan
 *
 * Ordered list of subtasks with dependencies
 */
export interface ExecutionPlan {
  /** List of subtasks */
  subtasks: SubTask[];
  /** Estimated total duration in milliseconds */
  estimatedDurationMs?: number;
}

/**
 * Execution statistics
 *
 * Summary of orchestrator execution
 */
export interface ExecutionStats {
  /** Total number of subtasks in plan */
  totalSubtasks: number;
  /** Number of successful subtasks */
  successfulSubtasks: number;
  /** Number of failed subtasks */
  failedSubtasks: number;
  /** Total execution duration in milliseconds */
  totalDurationMs: number;
  /** Total tokens used across all agents */
  totalTokensUsed: number;
  /** Total estimated cost in USD */
  totalCostUsd: number;
}

/**
 * Progress information
 *
 * Current position in execution plan
 */
export interface Progress {
  /** Current subtask number (1-based) */
  current: number;
  /** Total number of subtasks */
  total: number;
}

/**
 * Delegated result from agent execution
 *
 * This is what orchestrator receives from agents.
 * Note: Full AgentResult includes steps, but orchestrator only needs summary.
 */
export interface DelegatedResult {
  /** Subtask ID */
  subtaskId: string;
  /** Agent ID */
  agentId: string;
  /** Whether execution was successful */
  success: boolean;
  /** Structured output (if schema defined) */
  output: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Tokens used */
  tokensUsed: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Tool trace reference */
  traceRef?: string;
  /** Findings summary (Phase 2) */
  findingsSummary?: {
    total: number;
    bySeverity: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
    };
    actionable: number;
  };
  /** Findings reference (Phase 2) */
  findingsRef?: string;
}

/**
 * Orchestrator callbacks for progress tracking
 *
 * Phase 5: Enables real-time UI updates during orchestrator execution
 *
 * All callbacks are optional. Orchestrator will call them if provided.
 *
 * @example
 * ```typescript
 * const callbacks: OrchestratorCallbacks = {
 *   onPlanCreated: (plan) => {
 *     console.log(`📋 Plan created: ${plan.subtasks.length} subtasks`);
 *   },
 *   onSubtaskStart: (subtask, progress) => {
 *     console.log(`⏳ [${progress.current}/${progress.total}] Starting ${subtask.agentId}...`);
 *   },
 *   onSubtaskComplete: (subtask, result, progress) => {
 *     console.log(`✅ [${progress.current}/${progress.total}] Completed in ${result.durationMs}ms`);
 *   },
 *   onSubtaskFailed: (subtask, error, progress) => {
 *     console.log(`❌ [${progress.current}/${progress.total}] Failed: ${error.message}`);
 *   },
 *   onComplete: (finalResult, stats) => {
 *     console.log(`🎉 Done! ${stats.successfulSubtasks}/${stats.totalSubtasks} succeeded`);
 *   },
 * };
 *
 * await orchestrator.execute(task, callbacks);
 * ```
 */
export interface OrchestratorCallbacks {
  /**
   * Called after execution plan is created
   *
   * @param plan - Execution plan with subtasks
   */
  onPlanCreated?: (plan: ExecutionPlan) => void;

  /**
   * Called when subtask starts execution
   *
   * @param subtask - Subtask being executed
   * @param progress - Current progress (current/total)
   */
  onSubtaskStart?: (subtask: SubTask, progress: Progress) => void;

  /**
   * Called when subtask completes successfully
   *
   * @param subtask - Subtask that completed
   * @param result - Delegated result from agent
   * @param progress - Current progress (current/total)
   */
  onSubtaskComplete?: (subtask: SubTask, result: DelegatedResult, progress: Progress) => void;

  /**
   * Called when subtask fails (after all retries + escalation)
   *
   * @param subtask - Subtask that failed
   * @param result - Delegated result with error
   * @param progress - Current progress (current/total)
   */
  onSubtaskFailed?: (subtask: SubTask, result: DelegatedResult, progress: Progress) => void;

  /**
   * Called when plan is adapted (new subtasks added dynamically)
   *
   * @param reason - Why plan was adapted
   * @param newSubtasks - New subtasks added to plan
   * @param currentProgress - Current progress before adaptation
   */
  onAdaptation?: (reason: string, newSubtasks: SubTask[], currentProgress: Progress) => void;

  /**
   * Called when orchestrator completes execution
   *
   * @param finalResult - Synthesized final answer
   * @param stats - Execution statistics
   */
  onComplete?: (finalResult: string, stats: ExecutionStats) => void;
}
