/**
 * @module @kb-labs/adaptive-orchestrator/analytics
 * Analytics tracking for adaptive orchestration.
 *
 * Tracks:
 * - Task classification accuracy
 * - Tier usage distribution
 * - Cost savings vs naive approach
 * - Escalation frequency
 * - Execution time
 */

import type { IAnalytics, LLMTier } from '@kb-labs/sdk';
import type { OrchestratorResult, SubtaskResult } from './types.js';

/**
 * Analytics event names for orchestration.
 */
export const ORCHESTRATION_EVENTS = {
  TASK_STARTED: 'orchestration.task.started',
  TASK_COMPLETED: 'orchestration.task.completed',
  TASK_FAILED: 'orchestration.task.failed',
  CLASSIFICATION: 'orchestration.classification',
  PLANNING_COMPLETED: 'orchestration.planning.completed',
  SUBTASK_EXECUTED: 'orchestration.subtask.executed',
  TIER_ESCALATED: 'orchestration.tier.escalated',
  COST_SAVED: 'orchestration.cost.saved',
} as const;

/**
 * Track orchestration analytics.
 */
export class OrchestrationAnalytics {
  constructor(private analytics?: IAnalytics) {}

  /**
   * Track task start.
   */
  trackTaskStarted(taskDescription: string): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.TASK_STARTED, {
      task_length: taskDescription.length,
      timestamp: Date.now(),
    });
  }

  /**
   * Track task completion.
   */
  trackTaskCompleted(
    taskDescription: string,
    result: OrchestratorResult,
    duration: number
  ): void {
    if (!this.analytics) return;

    // Extract cost values
    const totalCost = this.parseCost(result.costBreakdown.total);
    const smallCost = this.parseCost(result.costBreakdown.small);
    const mediumCost = this.parseCost(result.costBreakdown.medium);
    const largeCost = this.parseCost(result.costBreakdown.large);

    // Calculate naive cost (assume all large)
    const totalTokens = result.subtaskResults?.reduce(
      (sum, r) => sum + (r.tokens || 0),
      0
    ) || 0;
    const naiveCost = totalTokens / 100_000; // Assume large tier pricing

    // Calculate savings
    const saved = naiveCost - totalCost;
    const savingsPercent = naiveCost > 0 ? (saved / naiveCost) * 100 : 0;

    this.analytics.track(ORCHESTRATION_EVENTS.TASK_COMPLETED, {
      status: result.status,
      duration_ms: duration,
      subtask_count: result.subtaskResults?.length || 0,
      cost_total: totalCost,
      cost_small: smallCost,
      cost_medium: mediumCost,
      cost_large: largeCost,
      cost_naive: naiveCost,
      cost_saved: saved,
      savings_percent: savingsPercent,
      timestamp: Date.now(),
    });

    // Track cost savings separately for easy querying
    if (saved > 0) {
      this.trackCostSaved(saved, savingsPercent);
    }
  }

  /**
   * Track task failure.
   */
  trackTaskFailed(taskDescription: string, error: Error, duration: number): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.TASK_FAILED, {
      task_length: taskDescription.length,
      error_message: error.message,
      error_name: error.name,
      duration_ms: duration,
      timestamp: Date.now(),
    });
  }

  /**
   * Track classification result.
   */
  trackClassification(
    tier: LLMTier,
    confidence: 'high' | 'low',
    method: 'heuristic' | 'llm'
  ): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.CLASSIFICATION, {
      tier,
      confidence,
      method,
      timestamp: Date.now(),
    });
  }

  /**
   * Track planning completion.
   */
  trackPlanningCompleted(subtaskCount: number, tierDistribution: Record<LLMTier, number>): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.PLANNING_COMPLETED, {
      subtask_count: subtaskCount,
      tier_small_count: tierDistribution.small || 0,
      tier_medium_count: tierDistribution.medium || 0,
      tier_large_count: tierDistribution.large || 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Track subtask execution.
   */
  trackSubtaskExecuted(result: SubtaskResult): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.SUBTASK_EXECUTED, {
      subtask_id: result.id,
      status: result.status,
      tier: result.tier,
      tokens: result.tokens || 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Track tier escalation.
   */
  trackTierEscalated(
    subtaskId: number,
    fromTier: LLMTier,
    toTier: LLMTier,
    reason: string
  ): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.TIER_ESCALATED, {
      subtask_id: subtaskId,
      from_tier: fromTier,
      to_tier: toTier,
      reason_length: reason.length,
      timestamp: Date.now(),
    });
  }

  /**
   * Track cost savings.
   */
  trackCostSaved(saved: number, savingsPercent: number): void {
    if (!this.analytics) return;

    this.analytics.track(ORCHESTRATION_EVENTS.COST_SAVED, {
      amount_saved: saved,
      savings_percent: savingsPercent,
      timestamp: Date.now(),
    });
  }

  /**
   * Parse cost string to number.
   */
  private parseCost(cost: string): number {
    if (cost === 'N/A') return 0;
    return parseFloat(cost.replace('$', '')) || 0;
  }
}
