/**
 * Phase 3: Universal Task Runner - Type Definitions
 *
 * These types support end-to-end task execution from any source
 * (ClickUp, GitHub, Jira, user text input, etc.)
 */

/**
 * Input to TaskRunner - universal interface for any task source
 */
export interface TaskInput {
  /**
   * Unique task identifier (from platform or generated)
   */
  id: string;

  /**
   * Main task description (from user/ClickUp/GitHub/etc.)
   * This is the primary input - TaskRunner works with text description
   */
  description: string;

  /**
   * Optional source identifier (e.g., "clickup", "github", "manual")
   * Platform uses this to handle source-specific logic
   * TaskRunner treats this as metadata only
   */
  source?: string;

  /**
   * Optional additional context (files, links, related tasks)
   */
  context?: {
    files?: string[]; // Relevant file paths
    links?: string[]; // Related URLs
    relatedTasks?: string[]; // IDs of related tasks
    metadata?: Record<string, unknown>; // Source-specific metadata
  };

  /**
   * Optional constraints
   */
  constraints?: {
    maxDuration?: number; // Max execution time in milliseconds
    budget?: number; // Max cost in USD
    requiresApproval?: boolean; // Must ask user before each step
  };
}

/**
 * Execution plan created by Planner from task description
 */
export interface ExecutionPlan {
  /**
   * Original task ID
   */
  taskId: string;

  /**
   * Plan creation timestamp
   */
  createdAt: string;

  /**
   * High-level summary of what will be done
   */
  summary: string;

  /**
   * Ordered list of steps (3-7 steps)
   */
  steps: PlanStep[];

  /**
   * Estimated total duration (milliseconds)
   */
  estimatedDuration?: number;

  /**
   * Estimated total cost (USD)
   */
  estimatedCost?: number;

  /**
   * Success criteria for entire plan
   */
  successCriteria: string[];
}

/**
 * Single step in execution plan
 */
export interface PlanStep {
  /**
   * Step number (1-based)
   */
  stepNumber: number;

  /**
   * What this step accomplishes
   */
  description: string;

  /**
   * Specific actions to take
   */
  actions: string[];

  /**
   * What defines success for this step
   */
  successCriteria: string[];

  /**
   * Dependencies on previous steps (step numbers)
   */
  dependsOn?: number[];

  /**
   * Estimated duration (milliseconds)
   */
  estimatedDuration?: number;
}

/**
 * Result of executing a single step
 */
export interface StepResult {
  /**
   * Step number
   */
  stepNumber: number;

  /**
   * Execution status
   */
  status: 'success' | 'partial' | 'failed';

  /**
   * What was accomplished
   */
  output: string;

  /**
   * Files created/modified
   */
  filesAffected?: string[];

  /**
   * Tool calls made during this step
   */
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;

  /**
   * Execution time (milliseconds)
   */
  durationMs: number;

  /**
   * Estimated cost (USD)
   */
  costUsd?: number;

  /**
   * Any errors or warnings
   */
  errors?: string[];
  warnings?: string[];
}

/**
 * Verification decision after checking step result
 */
export interface VerificationDecision {
  /**
   * Overall assessment
   */
  verdict: 'proceed' | 'retry' | 'escalate' | 'abort';

  /**
   * Confidence in the result (0.0-1.0)
   */
  confidence: number;

  /**
   * Reasoning behind the decision
   */
  reasoning: string;

  /**
   * If retry: what to do differently
   */
  retryStrategy?: {
    modifications: string[];
    maxRetries: number;
  };

  /**
   * If escalate: what human needs to decide
   */
  escalationReason?: string;

  /**
   * If proceed: any adjustments to remaining plan
   */
  planAdjustments?: {
    skipSteps?: number[];
    addSteps?: PlanStep[];
    modifySteps?: Array<{ stepNumber: number; changes: Partial<PlanStep> }>;
  };
}

/**
 * Checkpoint for recovery
 */
export interface TaskCheckpoint {
  /**
   * Task ID
   */
  taskId: string;

  /**
   * Checkpoint timestamp
   */
  timestamp: string;

  /**
   * Current execution plan
   */
  plan: ExecutionPlan;

  /**
   * Results of completed steps
   */
  completedSteps: StepResult[];

  /**
   * Current step number (or null if not started)
   */
  currentStep: number | null;

  /**
   * Total execution time so far (milliseconds)
   */
  elapsedMs: number;

  /**
   * Total cost so far (USD)
   */
  costUsd: number;

  /**
   * Can be resumed from this checkpoint
   */
  canResume: boolean;
}

/**
 * Final task result
 */
export interface TaskResult {
  /**
   * Task ID
   */
  taskId: string;

  /**
   * Overall status
   */
  status: 'success' | 'partial' | 'failed' | 'aborted';

  /**
   * Human-readable summary
   */
  summary: string;

  /**
   * All step results
   */
  steps: StepResult[];

  /**
   * Final checkpoint (for recovery)
   */
  checkpoint: TaskCheckpoint;

  /**
   * Total execution time (milliseconds)
   */
  totalDurationMs: number;

  /**
   * Total cost (USD)
   */
  totalCostUsd: number;

  /**
   * Success criteria met
   */
  criteriaMet: string[];

  /**
   * Success criteria not met
   */
  criteriaNotMet: string[];
}

/**
 * Escalation trigger rules
 */
export interface EscalationRules {
  /**
   * Max retries before escalation
   */
  maxRetries: number;

  /**
   * Max cost before requiring approval (USD)
   */
  costThreshold: number;

  /**
   * Max duration before requiring approval (milliseconds)
   */
  durationThreshold: number;

  /**
   * Min confidence required to proceed (0.0-1.0)
   */
  minConfidence: number;

  /**
   * Patterns that always require human approval
   */
  alwaysEscalate: string[];
}
