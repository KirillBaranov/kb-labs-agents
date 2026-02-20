/**
 * Core types and interfaces for agents
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */
// Using import() in type signatures to avoid circular dependencies

// ═══════════════════════════════════════════════════════════════════════
// Agent Modes (Extensible System)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Agent execution modes - extensible for future modes
 */
export type AgentMode = 'execute' | 'plan' | 'edit' | 'debug';

/**
 * Mode-specific configuration
 */
export interface ModeConfig {
  mode: AgentMode;
  context?: ModeContext;
}

/**
 * Context for different modes (discriminated union)
 */
export type ModeContext = ExecuteContext | PlanContext | EditContext | DebugContext;

/**
 * Execute mode - standard task execution
 */
export interface ExecuteContext {
  mode: 'execute';
  task: string;
}

/**
 * Plan mode - generate execution plan without running
 */
export interface PlanContext {
  mode: 'plan';
  task: string;
  complexity?: 'simple' | 'medium' | 'complex';
}

/**
 * Edit mode - modify existing code/files
 */
export interface EditContext {
  mode: 'edit';
  task: string;
  targetFiles?: string[];
  dryRun?: boolean;
}

/**
 * Debug mode - analyze errors with trace context
 */
export interface DebugContext {
  mode: 'debug';
  task: string;
  errorTrace?: string;
  relevantFiles?: string[];
  traceFile?: string; // Path to agent trace file
}

// ═══════════════════════════════════════════════════════════════════════
// Core Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * LLM tier for model selection
 */
export type LLMTier = 'small' | 'medium' | 'large';

export interface AgentSmartTieringConfig {
  enabled?: boolean;
  nodes?: {
    intentInference?: boolean;
    searchAssessment?: boolean;
    taskValidation?: boolean;
  };
  auditTasksPreferMedium?: boolean;
  minEvidenceDensityForSmallValidation?: number;
  maxIterationsWithoutProgressForMediumSearch?: number;
  intentInferenceMinTaskCharsForMedium?: number;
}

/**
 * Response verbosity/rigor mode for final answers.
 * - auto: adapt format by question complexity (default)
 * - brief: concise output for simple questions
 * - deep: thorough structured output for complex questions
 */
export type AgentResponseMode = 'auto' | 'brief' | 'deep';

/**
 * Task complexity classification
 *
 * - simple: Single lookup, one action (e.g., "What is X?")
 * - research: Information gathering + synthesis (e.g., "Explain architecture")
 * - complex: Multi-step task with actions (e.g., "Implement feature X")
 *
 * @deprecated No longer used after orchestrator simplification (2026-02-18).
 * All tasks now execute with single-agent mode. This type is kept for backward compatibility.
 */
export type TaskComplexity = 'simple' | 'research' | 'complex';

/**
 * Task type for decomposition decision (Phase 0: Smart Decomposition)
 *
 * - research: Parallel exploration of different aspects (easy to parallelize)
 * - implementation-single-domain: Implementation in one domain (prefer single agent - high coupling)
 * - implementation-cross-domain: Implementation across domains (parallelize by domain - backend/frontend/CLI)
 * - simple: Trivial task (single agent - overhead dominates)
 */
export type DecompositionTaskType =
  | 'research'
  | 'implementation-single-domain'
  | 'implementation-cross-domain'
  | 'simple'
  | 'single-agent'; // Added: no classification, direct agent execution

/**
 * Decomposition decision result
 */
export interface DecompositionDecision {
  taskType: DecompositionTaskType;
  shouldDecompose: boolean;
  reason: string;
  estimatedIterations?: number; // LLM estimate: 10-15 for research, 30-80 for implementation, 100+ for large projects
  subtasks?: Array<{
    description: string;
    domain?: string; // backend, frontend, cli, db, etc.
    estimatedMinutes?: number;
  }>;
}

/**
 * Execution mode for plan
 */
export type ExecutionMode = 'single-agent' | 'sequential' | 'parallel' | 'mixed';

/**
 * Task execution status
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * Plan update action (Phase 3: Orchestrator Observation)
 */
export type PlanUpdateAction = 'add' | 'remove' | 'reorder' | 'modify';

/**
 * Plan update event (Phase 3: Orchestrator Observation)
 */
export interface PlanUpdate {
  /** Type of update */
  action: PlanUpdateAction;
  /** Reason for the update */
  reason: string;
  /** Subtask being modified (for add/remove/modify) */
  subtaskId?: string;
  /** New subtask to add */
  newSubtask?: {
    id: string;
    description: string;
    status: TaskStatus;
  };
  /** New order of subtask IDs (for reorder) */
  newOrder?: string[];
  /** Timestamp when update was made */
  timestamp: string;
}

/**
 * Agent event callback type (imported from events.ts)
 */
export type { AgentEventCallback, AgentEvent, AgentEventEmitter } from './events.js';

/**
 * Agent configuration
 */
export interface AgentConfig {
  workingDir: string;
  maxIterations: number;
  temperature: number;
  verbose: boolean;
  sessionId?: string;
  tier?: LLMTier;
  responseMode?: AgentResponseMode;
  enableEscalation?: boolean;
  smartTiering?: AgentSmartTieringConfig;
  /** Mode configuration (execute/plan/edit/debug) */
  mode?: ModeConfig;
  /** Tracer for recording execution (optional) */
  tracer?: Tracer;
  /** Memory system for context management (optional) */
  memory?: AgentMemory;
  /** Result processors for post-processing (optional) */
  resultProcessors?: ResultProcessor[];
  /** Event callback for streaming agent execution events to UI (optional) */
  onEvent?: import('./events.js').AgentEventCallback;

  // ═══════════════════════════════════════════════════════════════════════
  // Hierarchical Event Correlation
  // ═══════════════════════════════════════════════════════════════════════

  /** Unique ID for this agent instance (auto-generated if not provided) */
  agentId?: string;
  /** Parent agent ID (for child agents spawned by orchestrator) */
  parentAgentId?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 1: Agent → Orchestrator Communication
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Callback for ask_parent tool calls.
   * When sub-agent calls ask_parent, this callback is invoked.
   * The parent agent can provide guidance, hints, or alter execution.
   */
  onAskParent?: (request: {
    question: string;
    reason: 'stuck' | 'uncertain' | 'blocker' | 'clarification';
    context?: Record<string, unknown>;
    iteration: number;
    subtask?: string;
  }) => Promise<{
    answer: string;
    action?: 'continue' | 'skip' | 'retry_with_hint';
    hint?: string;
  }>;
}

/**
 * Task result from agent execution
 */
export interface TaskResult {
  success: boolean;
  summary: string;
  filesCreated: string[];
  filesModified: string[];
  filesRead: string[];
  iterations: number;
  tokensUsed: number;
  error?: string;
  trace?: TraceEntry[];
  /** Enhanced summary from SummaryEnhancerProcessor */
  enhancedSummary?: string;
  /** Metrics from MetricsCollectorProcessor */
  metrics?: Record<string, unknown>;
  /** Trace file path from TraceSaverProcessor */
  traceFile?: string;
  /** Session ID for this execution */
  sessionId?: string;
  /** Generated plan (only in plan mode) */
  plan?: TaskPlan;
  /** Plan ID (if executing from plan) */
  planId?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // Verification (Anti-Hallucination)
  // ═══════════════════════════════════════════════════════════════════════

  /** Verification result from cross-tier verifier */
  verification?: import('./verification.js').VerificationResult;
  /** Quality metrics from verification */
  qualityMetrics?: import('./verification.js').QualityMetrics;
}

/**
 * Trace entry for debugging and analytics
 */
export interface TraceEntry {
  iteration: number;
  timestamp: string;
  type: 'llm_call' | 'llm_response' | 'tool_call' | 'tool_result' | 'tool_cache_hit' | 'task_start' | 'task_end' | 'subtask_start' | 'subtask_end' | 'plan_generated' | 'phase_start' | 'phase_end' | 'step_start' | 'step_end';
  data: Record<string, unknown>;
  durationMs?: number;
}

/**
 * Tracer interface for recording execution traces
 */
export interface Tracer {
  /**
   * Record a trace entry
   * Accepts both old TraceEntry format and new DetailedTraceEntry format
   */
  trace(entry: TraceEntry | Partial<import('./detailed-trace-types.js').DetailedTraceEntry>): void;

  /**
   * Get all trace entries
   */
  getEntries(): TraceEntry[];

  /**
   * Save trace to file (backward compat - alias for flush)
   */
  save(filePath: string): Promise<void>;

  /**
   * Clear all entries
   */
  clear(): void;

  // ═══════════════════════════════════════════════════════════════════════
  // Incremental Tracing (NEW - for IncrementalTraceWriter)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Finalize trace (flush, generate index, cleanup old traces)
   * Call this when agent execution completes
   */
  finalize?(): Promise<void>;

  /**
   * Create index file for fast CLI queries
   * Called automatically by finalize()
   */
  createIndex?(): Promise<void>;
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool definition for LLM (OpenAI Function Calling format)
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  errorDetails?: {
    code: string;
    message: string;
    retryable?: boolean;
    hint?: string;
    details?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Memory category
 */
export type MemoryCategory =
  // Existing categories
  | 'architecture'
  | 'decision'
  | 'learning'
  | 'pattern'
  | 'config'
  // New categories
  | 'user_input' // Everything from user (corrections, preferences)
  | 'project_rules' // Project constraints and rules
  | 'agent_state'; // Agent state (blockers, progress)

/**
 * Reflection result from agent self-analysis
 */
export interface ReflectionResult {
  /** What the agent has found so far */
  findingsSummary: string;
  /** Confidence in current answer (0.0-1.0) */
  confidence: number;
  /** Questions that remain unanswered */
  questionsRemaining: string[];
  /** Whether agent should continue searching */
  shouldContinue: boolean;
  /** Reason for continue/stop decision */
  reason: string;
}

/**
 * Memory entry (extended for agent memory system)
 */
export interface MemoryEntry {
  /** Unique identifier */
  id?: string;
  /** The actual content */
  content: string;
  /** Category of memory */
  category?: MemoryCategory;
  /** Timestamp when this memory was created */
  timestamp: string;
  /** Type of memory entry */
  type?:
    // Existing types
    | 'task'
    | 'observation'
    | 'action'
    | 'result'
    | 'reflection'
    | 'user_feedback'
    // New types
    | 'user_correction' // "No, class X is actually in file Y"
    | 'user_preference' // "Always use TypeScript strict mode"
    | 'constraint' // "Don't touch files in /legacy/"
    | 'finding' // Structured research result
    | 'blocker'; // "Can't continue without X"
  /** Additional metadata */
  metadata?: {
    /** Session this memory belongs to */
    sessionId?: string;
    /** Task this memory is related to */
    taskId?: string;
    /** Importance score (0-1) for summarization priority */
    importance?: number;
    /** Tags for categorization */
    tags?: string[];
    /** Related memory IDs */
    relatedTo?: string[];
    // New metadata fields
    /** Who created this entry */
    source?: 'agent' | 'user' | 'system';
    /** Confidence level 0-1 (for findings) */
    confidence?: number;
    /** ID of memory entry this supersedes (for corrections) */
    supersedes?: string;
    /** Scope of this memory */
    scope?: 'session' | 'project' | 'global';
    /** When this memory expires */
    expiresAt?: string;
    /** Flag indicating this is the original user task (from orchestrator) */
    isOriginalUserTask?: boolean;
    /** Global context extracted by orchestrator from original task */
    globalContext?: {
      /** Target directory where files should be created */
      targetDirectory?: string;
      /** Constraints extracted from task (NEVER, MUST NOT, etc.) */
      constraints: string[];
      /** Requirements extracted from task (numbered lists, bullets) */
      requirements: string[];
    };
  };
}

/**
 * Session entry in memory
 */
export interface SessionEntry {
  sessionId: string;
  timestamp: string;
  tasks: string[];
  learnings: string;
}

/**
 * Project context
 */
export interface ProjectContext {
  name: string;
  description: string;
  technologies: string[];
  structure: string;
}

/**
 * Persistent memory
 */
export interface PersistentMemory {
  facts: MemoryEntry[];
  sessions: SessionEntry[];
  projectContext: ProjectContext;
}

/**
 * Session memory (shared between agents)
 */
export interface SessionMemory {
  sessionId: string;
  timestamp: string;
  facts: MemoryEntry[];
  sharedContext: Record<string, unknown>;
}

/**
 * TODO item status
 */
export type TodoStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

/**
 * TODO item priority
 */
export type TodoPriority = 'low' | 'medium' | 'high';

/**
 * TODO item
 */
export interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  notes?: string;
}

/**
 * TODO list
 */
export interface TodoList {
  sessionId: string;
  items: TodoItem[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Execution plan subtask
 */
export interface Subtask {
  id: string;
  description: string;
  status: TaskStatus;
  result?: TaskResult;
  isAlternative?: boolean;
  originalTaskId?: string;
}

/**
 * Execution plan
 */
export interface ExecutionPlan {
  originalTask: string;
  subtasks: Subtask[];
  createdAt: string;
  /** Execution mode (Phase 0: Smart Decomposition) */
  executionMode?: ExecutionMode;
  /** Reason for decomposition decision (Phase 0) */
  decompositionReason?: string;
  /** Task type classification (Phase 0) */
  taskType?: DecompositionTaskType;
  /** LLM-estimated max iterations needed (Phase 0) */
  estimatedIterations?: number;
}

/**
 * Result processor interface for post-processing task results
 */
export interface ResultProcessor {
  /**
   * Process task result (e.g., add summary, collect metrics, save artifacts)
   */
  process(result: TaskResult): Promise<TaskResult>;
}

// ═══════════════════════════════════════════════════════════════════════
// Agent Memory System
// ═══════════════════════════════════════════════════════════════════════

/**
 * Memory summary - condensed version of multiple memories
 */
export interface MemorySummary {
  /** Unique identifier */
  id: string;
  /** Timestamp when this summary was created */
  timestamp: string;
  /** Number of memories that were summarized */
  memoryCount: number;
  /** Time range covered by this summary */
  timeRange: {
    start: string;
    end: string;
  };
  /** The summarized content */
  content: string;
  /** Original memory IDs that were summarized */
  originalMemoryIds: string[];
}

/**
 * Agent memory interface - manages short-term and long-term memory
 */
export interface AgentMemory {
  /**
   * Add a new memory entry
   */
  add(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry>;

  /**
   * Get recent memories (short-term memory)
   * @param limit - Maximum number of entries to return
   */
  getRecent(limit?: number): Promise<MemoryEntry[]>;

  /**
   * Search memories by query
   * @param query - Search query
   * @param limit - Maximum number of results
   */
  search(query: string, limit?: number): Promise<MemoryEntry[]>;

  /**
   * Get memories by session ID
   */
  getBySession(sessionId: string): Promise<MemoryEntry[]>;

  /**
   * Get memories by task ID
   */
  getByTask(taskId: string): Promise<MemoryEntry[]>;

  /**
   * Get current context (for LLM prompt)
   * Returns formatted string with recent memories + summaries
   */
  getContext(maxTokens?: number): Promise<string>;

  /**
   * Summarize old memories to save space
   * Returns the created summary
   */
  summarize(): Promise<MemorySummary>;

  /**
   * Clear all memories (use with caution!)
   */
  clear(): Promise<void>;

  /**
   * Get memory statistics
   */
  getStats(): Promise<{
    totalMemories: number;
    totalSummaries: number;
    oldestMemory: string | null;
    newestMemory: string | null;
    estimatedTokens: number;
  }>;

  // ═══════════════════════════════════════════════════════════════════════
  // Structured Memory Methods (optional - implementations may not support)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add a user correction (highest priority)
   * @param content - The correction content
   * @param supersedes - Optional ID of memory entry this corrects
   */
  addUserCorrection?(content: string, supersedes?: string): Promise<MemoryEntry>;

  /**
   * Add a user preference
   * @param content - The preference content
   * @param scope - Scope of the preference (session or project)
   */
  addUserPreference?(
    content: string,
    scope?: 'session' | 'project'
  ): Promise<MemoryEntry>;

  /**
   * Add a constraint (rule that must be followed)
   * @param content - The constraint content
   */
  addConstraint?(content: string): Promise<MemoryEntry>;

  /**
   * Add a finding (agent discovery)
   * @param content - What was found
   * @param confidence - Confidence level 0-1
   * @param sources - Source file paths
   */
  addFinding?(content: string, confidence: number, sources: string[]): Promise<MemoryEntry>;

  /**
   * Add a blocker (something preventing progress)
   * @param content - What's blocking
   * @param taskId - Optional task ID this blocks
   */
  addBlocker?(content: string, taskId?: string): Promise<MemoryEntry>;

  /**
   * Get all user corrections
   */
  getUserCorrections?(): Promise<MemoryEntry[]>;

  /**
   * Get active constraints
   */
  getActiveConstraints?(): Promise<MemoryEntry[]>;

  /**
   * Get current blockers
   */
  getBlockers?(): Promise<MemoryEntry[]>;

  /**
   * Get user preferences
   */
  getUserPreferences?(): Promise<MemoryEntry[]>;

  /**
   * Get structured context with sections for corrections, constraints, etc.
   * @param maxTokens - Maximum tokens for context
   */
  getStructuredContext?(maxTokens?: number): Promise<string>;

  // ═══════════════════════════════════════════════════════════════════════
  // Last Answer Memory (never summarized - always available in full)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Save the orchestrator's last answer (NEVER summarized)
   * This is stored separately and always returned in full for follow-up questions.
   *
   * @param answer - The full answer text
   * @param task - The original task/question
   * @param metadata - Optional metadata (confidence, completeness, sources)
   */
  saveLastAnswer?(
    answer: string,
    task: string,
    metadata?: {
      confidence?: number;
      completeness?: number;
      sources?: string[];
      filesCreated?: string[];
      filesModified?: string[];
    }
  ): Promise<void>;

  /**
   * Get the last orchestrator answer (full, unsummarized)
   * Returns null if no previous answer exists.
   */
  getLastAnswer?(): Promise<{
    answer: string;
    task: string;
    timestamp: string;
    metadata?: {
      confidence?: number;
      completeness?: number;
      sources?: string[];
      filesCreated?: string[];
      filesModified?: string[];
    };
  } | null>;

  /**
   * Clear the last answer (e.g., when starting a completely new topic)
   */
  clearLastAnswer?(): Promise<void>;
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  /** Session ID for this memory instance */
  sessionId?: string;
  /** Maximum number of memories to keep in short-term (before summarization) */
  maxShortTermMemories?: number;
  /** Maximum tokens for context (when to trigger summarization) */
  maxContextTokens?: number;
  /** Storage key prefix for cache */
  keyPrefix?: string;
  /** TTL for memories in milliseconds (optional, for auto-cleanup) */
  ttl?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Task Planning (for plan mode)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Task execution plan
 */
export interface TaskPlan {
  /** Unique plan identifier */
  id: string;
  /** Session this plan belongs to */
  sessionId: string;
  /** Original task description */
  task: string;
  /** Mode this plan was generated for */
  mode: AgentMode;
  /** Execution phases */
  phases: Phase[];
  /** Estimated duration (human-readable, e.g. "30 minutes") */
  estimatedDuration?: string;
  /** Complexity assessment */
  complexity: 'simple' | 'medium' | 'complex';
  /** When plan was created */
  createdAt: string;
  /** Last update time */
  updatedAt: string;
  /** Plan status */
  status: 'draft' | 'approved' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
}

/**
 * Execution phase (group of related steps)
 */
export interface Phase {
  /** Unique phase identifier */
  id: string;
  /** Phase name (e.g., "Setup", "Implementation", "Testing") */
  name: string;
  /** Phase description */
  description: string;
  /** Steps in this phase */
  steps: Step[];
  /** Phase IDs that must complete before this one */
  dependencies: string[];
  /** Phase status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  /** When phase started */
  startedAt?: string;
  /** When phase completed */
  completedAt?: string;
  /** Error if failed */
  error?: string;
}

/**
 * Execution step (atomic action)
 */
export interface Step {
  /** Unique step identifier */
  id: string;
  /** Step description */
  action: string;
  /** Tool to use (if applicable) */
  tool?: string;
  /** Tool arguments */
  args?: Record<string, unknown>;
  /** Expected outcome */
  expectedOutcome: string;
  /** Step status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  /** Result (if completed) */
  result?: string;
  /** Error (if failed) */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Session Management
// ═══════════════════════════════════════════════════════════════════════

/**
 * Agent session metadata
 */
export interface AgentSession {
  /** Unique session identifier */
  id: string;
  /** Mode for this session */
  mode: AgentMode;
  /** Task description */
  task: string;
  /** Associated plan ID (if any) */
  planId?: string;
  /** Working directory */
  workingDir: string;
  /** Session creation time */
  createdAt: string;
  /** Last update time */
  updatedAt: string;
  /** Session status */
  status: 'active' | 'completed' | 'failed' | 'cancelled';
}

/**
 * Session progress tracking
 */
export interface SessionProgress {
  /** Session ID */
  sessionId: string;
  /** Plan ID (if executing from plan) */
  planId?: string;
  /** Current phase being executed */
  currentPhaseId?: string;
  /** Current step being executed */
  currentStepId?: string;
  /** Number of completed phases */
  completedPhases: number;
  /** Total number of phases */
  totalPhases: number;
  /** Number of completed steps */
  completedSteps: number;
  /** Total number of steps */
  totalSteps: number;
  /** Progress percentage (0-100) */
  percentage: number;
  /** When execution started */
  startedAt: string;
  /** Last update time */
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Session REST API Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extended session for Studio UI (includes run count, last message, etc.)
 */
export interface AgentSessionInfo extends AgentSession {
  /** Agent ID this session belongs to */
  agentId: string;
  /** Human-readable session name (auto-generated or user-provided) */
  name?: string;
  /** Number of runs in this session */
  runCount: number;
  /** Last message preview (truncated) */
  lastMessage?: string;
  /** Last activity timestamp */
  lastActivityAt: string;
}

/**
 * Request to list sessions
 */
export interface ListSessionsRequest {
  /** Filter by agent ID */
  agentId?: string;
  /** Maximum number of sessions to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter by status */
  status?: 'active' | 'completed' | 'failed' | 'cancelled';
}

/**
 * Response with sessions list
 */
export interface ListSessionsResponse {
  /** List of sessions */
  sessions: AgentSessionInfo[];
  /** Total count for pagination */
  total: number;
}

/**
 * Request to get session details
 */
export interface GetSessionRequest {
  /** Session ID */
  sessionId: string;
}

/**
 * Response with session details
 */
export interface GetSessionResponse {
  /** Session details */
  session: AgentSessionInfo;
}

/**
 * Request to create a new session
 */
export interface CreateSessionRequest {
  /** Agent ID for this session */
  agentId: string;
  /** Optional session name */
  name?: string;
  /** Initial task (optional, can start empty) */
  task?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Response after creating a session
 */
export interface CreateSessionResponse {
  /** Created session */
  session: AgentSessionInfo;
}
