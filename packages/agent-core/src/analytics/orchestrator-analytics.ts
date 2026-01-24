/**
 * Orchestrator Analytics (V2 Architecture)
 *
 * Tracks orchestrator execution events:
 * - Task started/completed/failed
 * - Planning phase
 * - Agent delegation
 * - Result synthesis
 * - Cost and token usage
 */

import type { IAnalytics } from "@kb-labs/sdk";
import type { LLMTier } from "@kb-labs/agent-contracts";
import type {
  SubTask,
  DelegatedResult,
  OrchestratorResult,
} from "../executor/types.js";

/**
 * Analytics event names for V2 orchestrator
 */
export const ORCHESTRATOR_EVENTS = {
  // Task lifecycle
  TASK_STARTED: "orchestrator.task.started",
  TASK_COMPLETED: "orchestrator.task.completed",
  TASK_FAILED: "orchestrator.task.failed",

  // Planning phase
  PLANNING_STARTED: "orchestrator.planning.started",
  PLANNING_COMPLETED: "orchestrator.planning.completed",

  // Agent delegation
  SPECIALIST_DELEGATED: "orchestrator.specialist.delegated",
  SPECIALIST_COMPLETED: "orchestrator.specialist.completed",
  SPECIALIST_FAILED: "orchestrator.specialist.failed",

  // Synthesis phase
  SYNTHESIS_STARTED: "orchestrator.synthesis.started",
  SYNTHESIS_COMPLETED: "orchestrator.synthesis.completed",
} as const;

/**
 * Orchestrator Analytics
 *
 * Provides structured tracking for all orchestrator operations.
 * Safe to use even if analytics is not configured (no-op).
 */
export class OrchestratorAnalytics {
  private totalCostUsd = 0;

  constructor(private analytics?: IAnalytics) {}

  /**
   * Track orchestrator task start
   */
  trackTaskStarted(task: string): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.TASK_STARTED, {
      task_length: task.length,
      task_preview: task.substring(0, 100),
      timestamp: Date.now(),
    });
  }

  /**
   * Track orchestrator task completion
   */
  trackTaskCompleted(task: string, result: OrchestratorResult): void {
    if (!this.analytics) {
      return;
    }

    // Calculate agent distribution
    const agentCounts: Record<string, number> = {};
    for (const delegated of result.delegatedResults) {
      agentCounts[delegated.agentId] =
        (agentCounts[delegated.agentId] || 0) + 1;
    }

    // Calculate success rate
    const successCount = result.delegatedResults.filter(
      (r) => r.success,
    ).length;
    const totalCount = result.delegatedResults.length;
    const successRate = totalCount > 0 ? (successCount / totalCount) * 100 : 0;

    this.analytics.track(ORCHESTRATOR_EVENTS.TASK_COMPLETED, {
      task_length: task.length,
      success: result.success,
      subtask_count: result.plan.length,
      delegated_count: result.delegatedResults.length,
      success_rate: successRate,
      agent_distribution: agentCounts,
      tokens_total: result.tokensUsed,
      duration_ms: result.durationMs,
      answer_length: result.answer.length,
      timestamp: Date.now(),
    });
  }

  /**
   * Track orchestrator task failure
   */
  trackTaskFailed(
    task: string,
    error: string,
    durationMs: number,
    tokensUsed: number,
  ): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.TASK_FAILED, {
      task_length: task.length,
      error_message: error.substring(0, 200),
      duration_ms: durationMs,
      tokens_used: tokensUsed,
      timestamp: Date.now(),
    });
  }

  /**
   * Track planning phase start
   */
  trackPlanningStarted(task: string): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.PLANNING_STARTED, {
      task_length: task.length,
      timestamp: Date.now(),
    });
  }

  /**
   * Track planning phase completion
   */
  trackPlanningCompleted(
    plan: SubTask[],
    tokensUsed: number,
    durationMs: number,
  ): void {
    if (!this.analytics) {
      return;
    }

    // Calculate agent distribution in plan
    const agentCounts: Record<string, number> = {};
    const prioritySum = plan.reduce((sum, s) => sum + (s.priority || 5), 0);
    const avgPriority = plan.length > 0 ? prioritySum / plan.length : 0;

    for (const subtask of plan) {
      agentCounts[subtask.agentId] = (agentCounts[subtask.agentId] || 0) + 1;
    }

    // Count dependencies
    const dependencyCount = plan.reduce(
      (sum, s) => sum + (s.dependencies?.length || 0),
      0,
    );

    this.analytics.track(ORCHESTRATOR_EVENTS.PLANNING_COMPLETED, {
      subtask_count: plan.length,
      agent_distribution: agentCounts,
      agents_used: Object.keys(agentCounts).length,
      dependency_count: dependencyCount,
      avg_priority: avgPriority,
      tokens_used: tokensUsed,
      duration_ms: durationMs,
      timestamp: Date.now(),
    });
  }

  /**
   * Track agent delegation start
   */
  trackSpecialistDelegated(subtask: SubTask): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.SPECIALIST_DELEGATED, {
      subtask_id: subtask.id,
      agent_id: subtask.agentId,
      description_length: subtask.description.length,
      priority: subtask.priority || 5,
      complexity: subtask.estimatedComplexity || "medium",
      has_dependencies: (subtask.dependencies?.length || 0) > 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Track agent completion
   */
  trackSpecialistCompleted(subtask: SubTask, result: DelegatedResult): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.SPECIALIST_COMPLETED, {
      subtask_id: subtask.id,
      agent_id: subtask.agentId,
      success: result.success,
      tokens_used: result.tokensUsed,
      duration_ms: result.durationMs,
      output_type: typeof result.output,
      output_length: this.getOutputLength(result.output),
      timestamp: Date.now(),
    });
  }

  /**
   * Track agent failure
   */
  trackSpecialistFailed(subtask: SubTask, result: DelegatedResult): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.SPECIALIST_FAILED, {
      subtask_id: subtask.id,
      agent_id: subtask.agentId,
      error_message: result.error?.substring(0, 200) || "unknown",
      tokens_used: result.tokensUsed,
      duration_ms: result.durationMs,
      priority: subtask.priority || 5,
      timestamp: Date.now(),
    });
  }

  /**
   * Track synthesis phase start
   */
  trackSynthesisStarted(resultsCount: number): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.SYNTHESIS_STARTED, {
      results_count: resultsCount,
      timestamp: Date.now(),
    });
  }

  /**
   * Track synthesis phase completion
   */
  trackSynthesisCompleted(
    answerLength: number,
    tokensUsed: number,
    durationMs: number,
  ): void {
    if (!this.analytics) {
      return;
    }

    this.analytics.track(ORCHESTRATOR_EVENTS.SYNTHESIS_COMPLETED, {
      answer_length: answerLength,
      tokens_used: tokensUsed,
      duration_ms: durationMs,
      timestamp: Date.now(),
    });
  }

  /**
   * Get output length for analytics
   */
  private getOutputLength(output: unknown): number {
    if (output === null || output === undefined) {
      return 0;
    }
    if (typeof output === "string") {
      return output.length;
    }
    if (typeof output === "object") {
      try {
        return JSON.stringify(output).length;
      } catch {
        return 0;
      }
    }
    return String(output).length;
  }

  /**
   * Estimate cost for LLM usage (Phase 4)
   *
   * Based on OpenAI pricing as baseline:
   * - small (gpt-4o-mini): $0.15/M prompt, $0.60/M completion
   * - medium (claude-sonnet-4-5): $2.50/M prompt, $10.00/M completion
   * - large (claude-opus-4-5): $15.00/M prompt, $60.00/M completion
   *
   * @param tier - Model tier
   * @param promptTokens - Tokens in prompt
   * @param completionTokens - Tokens in completion
   * @returns Estimated cost in USD
   */
  estimateCost(
    tier: LLMTier,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const rates = {
      small: { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
      medium: { prompt: 2.5 / 1_000_000, completion: 10.0 / 1_000_000 },
      large: { prompt: 15.0 / 1_000_000, completion: 60.0 / 1_000_000 },
    };

    const rate = rates[tier];
    return promptTokens * rate.prompt + completionTokens * rate.completion;
  }

  /**
   * Track agent run cost (Phase 4)
   *
   * Accumulates cost for agent execution.
   *
   * @param tier - Model tier used
   * @param promptTokens - Tokens in prompt
   * @param completionTokens - Tokens in completion
   * @returns Estimated cost in USD
   */
  trackSpecialistCost(
    tier: LLMTier,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const cost = this.estimateCost(tier, promptTokens, completionTokens);
    this.totalCostUsd += cost;
    return cost;
  }

  /**
   * Get total accumulated cost (Phase 4)
   *
   * @returns Total cost in USD
   */
  getTotalCost(): number {
    return this.totalCostUsd;
  }

  /**
   * Reset cost tracking (Phase 4)
   *
   * Called at start of new orchestrator run.
   */
  resetCost(): void {
    this.totalCostUsd = 0;
  }
}
