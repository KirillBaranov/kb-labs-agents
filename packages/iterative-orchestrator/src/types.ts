/**
 * Iterative Orchestrator Types
 *
 * Manager-Worker Architecture:
 * - Orchestrator (Opus): THINKS, DECIDES, DELEGATES, STOPS, ESCALATES
 * - Agents (Haiku): Execute tools, return results
 */

/**
 * Orchestrator decision - what to do next
 */
export type OrchestratorDecision =
  | CompleteDecision
  | DelegateDecision
  | DelegateParallelDecision
  | EscalateDecision
  | AbortDecision;

export interface CompleteDecision {
  type: "COMPLETE";
  answer: string;
  confidence: number;
}

export interface DelegateDecision {
  type: "DELEGATE";
  agentId: string;
  task: string;
}

export interface DelegateParallelDecision {
  type: "DELEGATE_PARALLEL";
  tasks: Array<{ agentId: string; task: string }>;
}

export interface EscalateDecision {
  type: "ESCALATE";
  reason: string;
  question: string;
  options?: string[];
}

export interface AbortDecision {
  type: "ABORT";
  reason: string;
}

/**
 * LLM response with reasoning
 */
export interface OrchestratorResponse {
  reasoning: string;
  decision: OrchestratorDecision;
}

/**
 * Result from agent execution
 */
export interface AgentResult {
  agentId: string;
  task: string;
  result: string;
  success: boolean;
  iteration: number;
  durationMs: number;
  tokens?: number;
  error?: string;
}

/**
 * Orchestration context - accumulated state
 */
export interface OrchestrationContext {
  task: string;
  iteration: number;
  results: AgentResult[];
  startTime: number;
  totalTokens: number;
  totalCost: number;
}

/**
 * Final orchestration result
 */
export interface OrchestrationResult {
  success: boolean;
  answer?: string;
  confidence?: number;
  escalation?: {
    reason: string;
    question: string;
    options?: string[];
  };
  abort?: {
    reason: string;
  };
  stats: {
    iterations: number;
    agentCalls: number;
    durationMs: number;
    totalTokens: number;
    estimatedCost: number;
  };
}

/**
 * Configuration for iterative orchestrator
 */
export interface IterativeOrchestratorConfig {
  /** Maximum iterations before forced escalation */
  maxIterations: number;
  /** Maximum iterations without progress before escalation */
  maxIterationsWithoutProgress: number;
  /** Confidence threshold for early completion */
  confidenceThreshold: number;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Token budget (0 = unlimited) */
  tokenBudget: number;
}

/**
 * Available agent definition
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
}

/**
 * Callbacks for progress reporting
 */
export interface OrchestratorCallbacks {
  onIteration?: (iteration: number, decision: OrchestratorDecision) => void;
  onAgentStart?: (agentId: string, task: string) => void;
  onAgentComplete?: (result: AgentResult) => void;
  onEscalate?: (
    reason: string,
    question: string,
  ) => Promise<string | undefined>;
}
