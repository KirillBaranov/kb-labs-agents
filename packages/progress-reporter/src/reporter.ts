/**
 * @module @kb-labs/progress-reporter/reporter
 * Progress reporter for adaptive orchestration.
 *
 * UX-only component - events are NOT visible to the orchestrator.
 * Used for real-time progress feedback in CLI and Web UI.
 */

import type { ILogger, LLMTier } from '@kb-labs/sdk';
import type { ProgressEvent, ProgressCallback } from './types.js';

/**
 * Progress reporter - emits UX-only progress events.
 *
 * Key design principles:
 * - **UX-only**: Events are invisible to orchestrator logic
 * - **Real-time**: Immediate feedback for user experience
 * - **Visual**: Tier color coding (🟢🟡🔴) for quick status understanding
 * - **Cost-aware**: Tracks and displays cost breakdown
 *
 * @example
 * ```typescript
 * import { ProgressReporter } from '@kb-labs/progress-reporter';
 * import { useLogger } from '@kb-labs/sdk';
 *
 * const logger = useLogger();
 * const reporter = new ProgressReporter(logger, (event) => {
 *   // Stream to Web UI via WebSocket/SSE
 *   ws.send(JSON.stringify(event));
 * });
 *
 * reporter.start('Implement user authentication');
 * reporter.classified('medium', 'high', 'heuristic');
 * // ... rest of orchestration
 * reporter.complete('success', { total: '$0.05', ... });
 * ```
 */
export class ProgressReporter {
  private events: ProgressEvent[] = [];
  private startTime: number = 0;

  constructor(
    private logger: ILogger,
    private onProgress?: ProgressCallback
  ) {}

  /**
   * Start tracking a new task.
   */
  start(taskDescription: string): void {
    this.startTime = Date.now();
    this.emit({
      type: 'task_started',
      timestamp: this.startTime,
      data: { taskDescription },
    });
    this.logger.info(`🎯 Task started: ${taskDescription}`);
  }

  /**
   * Report task classification result.
   */
  classified(
    tier: LLMTier,
    confidence: 'high' | 'low',
    method: 'heuristic' | 'llm'
  ): void {
    const emoji = this.getTierEmoji(tier);
    this.emit({
      type: 'task_classified',
      timestamp: Date.now(),
      data: { tier, confidence, method },
    });
    this.logger.info(
      `${emoji} Classified as '${tier}' tier (${confidence} confidence, ${method})`
    );
  }

  /**
   * Report planning phase status.
   */
  planning(phase: 'started' | 'completed', data?: { subtaskCount?: number }): void {
    this.emit({
      type: phase === 'started' ? 'planning_started' : 'planning_completed',
      timestamp: Date.now(),
      data: data || {},
    });

    if (phase === 'started') {
      this.logger.info('📋 Planning subtasks...');
    } else {
      this.logger.info(`📋 Plan ready: ${data?.subtaskCount || 0} subtasks`);
    }
  }

  /**
   * Report subtask status.
   */
  subtask(
    subtaskId: number,
    description: string,
    tier: LLMTier,
    phase: 'started' | 'progress' | 'completed' | 'failed',
    extra?: { progress?: number; error?: string }
  ): void {
    const emoji = this.getTierEmoji(tier);

    this.emit({
      type: `subtask_${phase}` as any,
      timestamp: Date.now(),
      data: {
        subtaskId,
        description,
        tier,
        ...(extra || {}),
      },
    });

    switch (phase) {
      case 'started':
        this.logger.info(`${emoji} [${subtaskId}] Starting: ${description}`);
        break;
      case 'progress':
        this.logger.info(`${emoji} [${subtaskId}] Progress: ${extra?.progress || 0}%`);
        break;
      case 'completed':
        this.logger.info(`✅ [${subtaskId}] Completed: ${description}`);
        break;
      case 'failed':
        this.logger.error(`❌ [${subtaskId}] Failed: ${extra?.error || 'Unknown error'}`);
        break;
    }
  }

  /**
   * Report tier escalation.
   */
  escalated(
    subtaskId: number,
    fromTier: LLMTier,
    toTier: LLMTier,
    reason: string
  ): void {
    this.emit({
      type: 'tier_escalated',
      timestamp: Date.now(),
      data: { subtaskId, fromTier, toTier, reason },
    });
    this.logger.warn(
      `⚠️  [${subtaskId}] Escalating ${fromTier} → ${toTier}: ${reason}`
    );
  }

  /**
   * Report task completion.
   */
  complete(
    status: 'success' | 'failed',
    costBreakdown: {
      total: string;
      small: string;
      medium: string;
      large: string;
    }
  ): void {
    const totalDuration = Date.now() - this.startTime;
    const emoji = status === 'success' ? '✅' : '❌';

    this.emit({
      type: 'task_completed',
      timestamp: Date.now(),
      data: { status, totalDuration, costBreakdown },
    });

    this.logger.info(
      `${emoji} Task ${status} in ${(totalDuration / 1000).toFixed(1)}s`
    );
    this.logger.info(`💰 Cost: ${costBreakdown.total}`);
    this.logger.info(
      `   🟢 Small:  ${costBreakdown.small} | 🟡 Medium: ${costBreakdown.medium} | 🔴 Large:  ${costBreakdown.large}`
    );
  }

  /**
   * Get all emitted events (for debugging/testing).
   */
  getEvents(): readonly ProgressEvent[] {
    return [...this.events];
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = [];
    this.startTime = 0;
  }

  /**
   * Emit event to callback and store in history.
   */
  private emit(event: ProgressEvent): void {
    this.events.push(event);
    if (this.onProgress) {
      this.onProgress(event);
    }
  }

  /**
   * Get emoji for tier.
   */
  private getTierEmoji(tier: LLMTier): string {
    switch (tier) {
      case 'small':
        return '🟢';
      case 'medium':
        return '🟡';
      case 'large':
        return '🔴';
    }
  }
}
