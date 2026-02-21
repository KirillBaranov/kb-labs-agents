/**
 * @module task-classifier
 *
 * LLM-based task classification: intent, budget, and scope extraction.
 */
export {
  TaskClassifier,
  buildClassifyPrompt,
  buildClassifyTaskTool,
  buildSelectScopeTool,
  parseClassificationResult,
  parseScopeResult,
} from './task-classifier.js';

export type {
  ClassificationResult,
  TaskClassifierConfig,
  ClassifierLLMProvider,
} from './task-classifier.js';
