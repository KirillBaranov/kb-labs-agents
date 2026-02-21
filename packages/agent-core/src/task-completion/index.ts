/**
 * @module task-completion
 *
 * Task completion validation: heuristic fast-paths and LLM-based evaluation.
 */
export {
  TaskCompletionEvaluator,
  isInformationalTask,
  looksLikeNoResultConclusion,
  responseHasEvidence,
  buildValidationPrompt,
  buildValidationTool,
  parseValidationResult,
  heuristicValidation,
  getHistoricalChangesForSimilarTask,
} from './task-completion-evaluator.js';

export type {
  CompletionEvaluationContext,
  HistoricalChanges,
  CompletionResult,
  CompletionLLMProvider,
  FileReader,
  HistoricalChangesLoader,
  HistoricalChangesConfig,
} from './task-completion-evaluator.js';
