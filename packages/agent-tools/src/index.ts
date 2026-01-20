/**
 * @module @kb-labs/agent-tools
 * Agent management tools for orchestration, planning, and execution.
 *
 * Provides LLM tools for:
 * - Planning: Creating and revising execution plans
 * - Coordination: Delegating tasks and managing agents
 * - Progress: Tracking status and identifying blockers
 * - Quality: Validating outputs and requesting revisions
 * - Knowledge: Sharing findings and capturing learnings
 */

// Planning tools
export {
  createExecutionPlanTool,
  type ExecutionPlan,
  type SubTask,
} from './planning/create-execution-plan.js';

export {
  createReviseExecutionPlanTool,
  type PlanRevision,
  type RevisionAction,
} from './planning/revise-execution-plan.js';

export {
  createEstimateComplexityTool,
  type ComplexityEstimate,
  type ComplexityFactor,
} from './planning/estimate-complexity.js';

// Coordination tools
export {
  createDelegateSubtaskTool,
  type DelegationInstruction,
} from './coordination/delegate-subtask.js';

export {
  createRequestFeedbackTool,
  type FeedbackRequest,
  
} from './coordination/request-feedback.js';

export {
  createMergeResultsTool,
  type MergedResults,
  type ResultToMerge,
} from './coordination/merge-results.js';

// Progress tracking tools
export {
  createUpdateSubtaskStatusTool,
  type SubtaskStatus,
  type StatusUpdate,
} from './progress/update-subtask-status.js';

export {
  createReportProgressTool,
  type ProgressReport,
  type ProgressMetric,
} from './progress/report-progress.js';

export {
  createIdentifyBlockerTool,
  type BlockerIdentification,
  type BlockerSeverity,
  type BlockerType,
} from './progress/identify-blocker.js';

// Quality control tools
export {
  createValidateOutputTool,
  type OutputValidation,
  type ValidationCriterion,
} from './quality/validate-output.js';

export {
  createRequestRevisionTool,
  type RevisionRequest,
} from './quality/request-revision.js';

export {
  createApproveResultTool,
  type ResultApproval,
} from './quality/approve-result.js';

// Knowledge sharing tools
export {
  createShareFindingTool,
  type SharedFinding,
  type FindingCategory,
} from './knowledge/share-finding.js';

export {
  createRequestContextTool,
  type ContextRequest,
} from './knowledge/request-context.js';

export {
  createSummarizeLearningsTool,
  type SummarizedLearnings,
  type Learning,
  type LearningCategory,
} from './knowledge/summarize-learnings.js';
