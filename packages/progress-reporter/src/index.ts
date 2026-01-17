/**
 * @module @kb-labs/progress-reporter
 * UX-only progress feedback system for adaptive orchestration.
 *
 * Provides real-time progress events for CLI and Web UI.
 * Events are invisible to orchestrator logic.
 *
 * @example
 * ```typescript
 * import { ProgressReporter } from '@kb-labs/progress-reporter';
 * import { useLogger } from '@kb-labs/sdk';
 *
 * const logger = useLogger();
 *
 * // CLI usage
 * const reporter = new ProgressReporter(logger);
 * reporter.start('Implement user authentication');
 * reporter.classified('medium', 'high', 'heuristic');
 * reporter.planning('started');
 * reporter.planning('completed', { subtaskCount: 3 });
 * reporter.subtask(1, 'Create auth service', 'medium', 'started');
 * reporter.subtask(1, 'Create auth service', 'medium', 'completed');
 * reporter.complete('success', {
 *   total: '$0.05',
 *   small: '$0.00',
 *   medium: '$0.05',
 *   large: '$0.00'
 * });
 *
 * // Web UI usage (with callback)
 * const reporter = new ProgressReporter(logger, (event) => {
 *   ws.send(JSON.stringify(event));
 * });
 * ```
 */

export { ProgressReporter } from './reporter.js';

export type {
  ProgressEvent,
  ProgressEventType,
  ProgressCallback,
  TaskStartedEvent,
  TaskClassifiedEvent,
  PlanningEvent,
  SubtaskEvent,
  TierEscalatedEvent,
  TaskCompletedEvent,
} from './types.js';
