/**
 * @module @kb-labs/task-classifier
 * Task complexity classifier for adaptive orchestration.
 *
 * Provides three classification strategies:
 * - **Heuristic**: Fast, rule-based, free
 * - **LLM**: Accurate, LLM-based, cheap (~$0.002/task)
 * - **Hybrid**: Best-of-both (recommended) ⭐
 *
 * @example
 * ```typescript
 * import { HybridComplexityClassifier } from '@kb-labs/task-classifier';
 * import { useLLM } from '@kb-labs/sdk';
 *
 * const llm = useLLM({ tier: 'small' }); // Use cheap model
 * const classifier = new HybridComplexityClassifier(llm);
 *
 * const result = await classifier.classify({
 *   taskDescription: 'Implement user authentication'
 * });
 *
 * console.log(result.tier);        // 'medium'
 * console.log(result.confidence);  // 'high'
 * console.log(result.method);      // 'heuristic' or 'llm'
 * ```
 */

export { HeuristicComplexityClassifier } from './heuristic-classifier.js';
export { LLMComplexityClassifier } from './llm-classifier.js';
export { HybridComplexityClassifier } from './hybrid-classifier.js';

export type {
  ClassifyInput,
  ClassificationResult,
  ITaskClassifier,
  HeuristicRule,
} from './types.js';
