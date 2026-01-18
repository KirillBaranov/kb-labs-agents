/**
 * @module @kb-labs/adaptive-orchestrator
 * Adaptive agent orchestrator with tier-based model selection and cost optimization.
 *
 * Provides intelligent task orchestration with:
 * - Automatic complexity classification
 * - Tier-based model selection
 * - Automatic escalation on failure
 * - Real-time progress feedback
 * - Cost optimization (70-80% savings)
 *
 * @example
 * ```typescript
 * import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
 * import { useLogger } from '@kb-labs/sdk';
 *
 * const logger = useLogger();
 *
 * // Create orchestrator
 * const orchestrator = new AdaptiveOrchestrator(logger);
 *
 * // Execute task
 * const result = await orchestrator.execute('Implement user authentication');
 *
 * console.log(result.result);
 * console.log(`Cost: ${result.costBreakdown.total}`);
 * console.log(`Status: ${result.status}`);
 *
 * // With progress callback for Web UI
 * const orchestrator = new AdaptiveOrchestrator(
 *   logger,
 *   (event) => ws.send(JSON.stringify(event))
 * );
 * ```
 */

export { AdaptiveOrchestrator } from './orchestrator.js';
export { OrchestrationAnalytics, ORCHESTRATION_EVENTS } from './analytics.js';
export { OrchestratorAgentRegistry } from './agent-registry.js';
export { FileHistoryStorage } from './history-storage.js';
export { executeWithAgent } from './agent-execution-helper.js';

export type {
  Subtask,
  ExecutionPlan,
  SubtaskResult,
  OrchestratorResult,
  OrchestratorConfig,
} from './types.js';

export type {
  OrchestrationHistory,
  SubtaskTrace,
  ToolCallRecord,
  LLMInteraction,
  IHistoryStorage,
} from './history-types.js';
