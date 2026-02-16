/**
 * Agent Event System
 *
 * Simple callback-based event streaming for agents.
 * Client decides how to handle events (CLI, WebSocket, SSE, etc.)
 */

/**
 * All possible agent event types
 */
export type AgentEventType =
  // Lifecycle
  | 'agent:start'
  | 'agent:end'
  | 'agent:error'
  // Iterations
  | 'iteration:start'
  | 'iteration:end'
  // LLM
  | 'llm:start'
  | 'llm:chunk' // For streaming responses
  | 'llm:end'
  // Tools
  | 'tool:start'
  | 'tool:end'
  | 'tool:error'
  // Orchestrator
  | 'orchestrator:start'
  | 'orchestrator:plan'    // Execution plan with LLM-estimated iterations
  | 'orchestrator:answer'  // Synthesized answer for user
  | 'orchestrator:end'
  | 'subtask:start'
  | 'subtask:end'
  // Synthesis (forced on last iteration)
  | 'synthesis:forced'
  | 'synthesis:start'
  | 'synthesis:complete'
  // Memory
  | 'memory:read'
  | 'memory:write'
  // Verification (Anti-Hallucination)
  | 'verification:start'
  | 'verification:complete'
  // Progress
  | 'progress:update'
  | 'status:change';

/**
 * Base event structure
 *
 * Hierarchical Event Correlation:
 * - agentId: unique ID for each agent instance
 * - parentAgentId: for child agents, the ID of parent (orchestrator)
 * - toolCallId: for tool events, correlates start/end/error for same tool call
 * - startedAt: for *:end events, timestamp when the operation started (for duration calc)
 */
export interface AgentEventBase {
  type: AgentEventType;
  timestamp: string;
  sessionId?: string;
  taskId?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // Hierarchical Event Correlation
  // ═══════════════════════════════════════════════════════════════════════

  /** Unique ID for this agent instance (e.g., "agent-abc123") */
  agentId?: string;

  /** Parent agent ID for child agents spawned by orchestrator */
  parentAgentId?: string;

  /** For tool events: correlates tool:start → tool:end/tool:error */
  toolCallId?: string;

  /** For *:end events: when the operation started (ISO string) */
  startedAt?: string;

  /** Monotonic sequence number for event ordering (assigned by RunManager) */
  seq?: number;
}

/**
 * Agent lifecycle events
 */
export interface AgentStartEvent extends AgentEventBase {
  type: 'agent:start';
  data: {
    task: string;
    tier: string;
    maxIterations: number;
    toolCount: number;
  };
}

export interface AgentEndEvent extends AgentEventBase {
  type: 'agent:end';
  data: {
    success: boolean;
    summary: string;
    iterations: number;
    tokensUsed: number;
    durationMs: number;
    filesCreated: string[];
    filesModified: string[];
  };
}

export interface AgentErrorEvent extends AgentEventBase {
  type: 'agent:error';
  data: {
    error: string;
    iteration?: number;
    recoverable: boolean;
  };
}

/**
 * Iteration events
 */
export interface IterationStartEvent extends AgentEventBase {
  type: 'iteration:start';
  data: {
    iteration: number;
    maxIterations: number;
  };
}

export interface IterationEndEvent extends AgentEventBase {
  type: 'iteration:end';
  data: {
    iteration: number;
    hadToolCalls: boolean;
    toolCallCount: number;
  };
}

/**
 * LLM events
 */
export interface LLMStartEvent extends AgentEventBase {
  type: 'llm:start';
  data: {
    tier: string;
    messageCount: number;
  };
}

export interface LLMChunkEvent extends AgentEventBase {
  type: 'llm:chunk';
  data: {
    chunk: string;
    index: number;
  };
}

export interface LLMEndEvent extends AgentEventBase {
  type: 'llm:end';
  data: {
    tokensUsed: number;
    durationMs: number;
    hasToolCalls: boolean;
    content?: string;
  };
}

/**
 * Tool events
 *
 * Flexible structure for any tool:
 * - input: always present, contains tool arguments
 * - output: result string (for tool:end)
 * - metadata: optional extra data for UI (diff, fileContent, etc.)
 */
export interface ToolStartEvent extends AgentEventBase {
  type: 'tool:start';
  data: {
    /** Tool name (e.g., 'fs:edit', 'mind:rag-query') */
    toolName: string;
    /** Tool input arguments */
    input: Record<string, unknown>;
    /** Optional metadata for UI (e.g., file preview before edit) */
    metadata?: ToolEventMetadata;
  };
}

export interface ToolEndEvent extends AgentEventBase {
  type: 'tool:end';
  data: {
    /** Tool name */
    toolName: string;
    /** Whether tool execution succeeded */
    success: boolean;
    /** Tool output (result string) */
    output?: string;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Optional metadata for UI (e.g., diff, structured result) */
    metadata?: ToolEventMetadata;
  };
}

export interface ToolErrorEvent extends AgentEventBase {
  type: 'tool:error';
  data: {
    /** Tool name */
    toolName: string;
    /** Error message */
    error: string;
    /** Optional metadata for UI (e.g., stack trace, context) */
    metadata?: ToolEventMetadata;
  };
}

/**
 * Tool event metadata for UI display
 *
 * This is intentionally flexible - each tool can add its own data.
 * UI clients can check for specific fields and render accordingly.
 */
export interface ToolEventMetadata {
  // ═══════════════════════════════════════════════════════════════════════
  // File operations (fs:read, fs:edit, fs:write)
  // ═══════════════════════════════════════════════════════════════════════

  /** File path being operated on */
  filePath?: string;
  /** File content (for read operations) */
  fileContent?: string;
  /** Diff output (for edit operations) - can be unified diff format */
  diff?: string;
  /** Old content before edit */
  oldContent?: string;
  /** New content after edit */
  newContent?: string;
  /** Lines changed count */
  linesChanged?: number;
  /** Lines added count */
  linesAdded?: number;
  /** Lines removed count */
  linesRemoved?: number;

  // ═══════════════════════════════════════════════════════════════════════
  // Search operations (mind:rag-query, fs:grep, fs:glob)
  // ═══════════════════════════════════════════════════════════════════════

  /** Search query used */
  query?: string;
  /** Number of results found */
  resultCount?: number;
  /** Search results array (flexible structure) */
  results?: Array<{
    file?: string;
    line?: number;
    content?: string;
    score?: number;
    [key: string]: unknown;
  }>;
  /** Confidence score (0-1) for RAG queries */
  confidence?: number;

  // ═══════════════════════════════════════════════════════════════════════
  // Command execution (bash, shell)
  // ═══════════════════════════════════════════════════════════════════════

  /** Command executed */
  command?: string;
  /** Exit code */
  exitCode?: number;
  /** stdout output */
  stdout?: string;
  /** stderr output */
  stderr?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // Memory operations
  // ═══════════════════════════════════════════════════════════════════════

  /** Memory entry type */
  memoryType?: string;
  /** Memory scope */
  memoryScope?: 'session' | 'shared';

  // ═══════════════════════════════════════════════════════════════════════
  // Generic/Extensible
  // ═══════════════════════════════════════════════════════════════════════

  /** Structured data for any tool (for new tools without specific fields) */
  structured?: Record<string, unknown>;
  /** Raw JSON for complex outputs */
  rawJson?: string;
  /** Human-readable summary for UI */
  summary?: string;
  /** UI hint for how to render this event */
  uiHint?: 'code' | 'diff' | 'table' | 'json' | 'markdown' | 'plain';
}

/**
 * Orchestrator events
 */
export interface OrchestratorStartEvent extends AgentEventBase {
  type: 'orchestrator:start';
  data: {
    task: string;
    complexity: 'simple' | 'research' | 'complex';
  };
}

export interface OrchestratorPlanEvent extends AgentEventBase {
  type: 'orchestrator:plan';
  data: {
    /** Execution mode (single agent or multi-agent decomposition) */
    executionMode?: string;
    /** Task type from decomposition analysis */
    taskType?: string;
    /** Why this decomposition approach was chosen */
    decompositionReason?: string;
    /** LLM-estimated iterations needed for child agents (Phase 0) */
    estimatedIterations?: number;
    /** Number of subtasks (1 for single agent, N for decomposed) */
    subtaskCount: number;
    /** Subtask descriptions */
    subtasks: Array<{
      id: string;
      description: string;
    }>;
  };
}

export interface OrchestratorAnswerEvent extends AgentEventBase {
  type: 'orchestrator:answer';
  data: {
    /** The synthesized answer/response for the user */
    answer: string;
    /** Confidence level (0-1) from verification */
    confidence?: number;
    /** Completeness level (0-1) from verification */
    completeness?: number;
    /** Gaps in the answer (from verification) */
    gaps?: string[];
    /** Unverified mentions (potential hallucinations) */
    unverifiedMentions?: string[];
    /** Sources used to generate the answer */
    sources?: string[];
  };
}

export interface OrchestratorEndEvent extends AgentEventBase {
  type: 'orchestrator:end';
  data: {
    success: boolean;
    subtaskCount: number;
    completedCount: number;
    /** Duration in milliseconds */
    durationMs?: number;
  };
}

export interface SubtaskStartEvent extends AgentEventBase {
  type: 'subtask:start';
  data: {
    subtaskId: string;
    description: string;
    index: number;
    total: number;
  };
}

export interface SubtaskEndEvent extends AgentEventBase {
  type: 'subtask:end';
  data: {
    subtaskId: string;
    success: boolean;
    summary?: string;
  };
}

/**
 * Synthesis events (forced answer synthesis on last iteration)
 */
export interface SynthesisForcedEvent extends AgentEventBase {
  type: 'synthesis:forced';
  data: {
    iteration: number;
    reason: string;
    messagesCount: number;
  };
}

export interface SynthesisStartEvent extends AgentEventBase {
  type: 'synthesis:start';
  data: {
    iteration: number;
    promptLength: number;
  };
}

export interface SynthesisCompleteEvent extends AgentEventBase {
  type: 'synthesis:complete';
  data: {
    iteration: number;
    contentLength: number;
    hasContent: boolean;
    tokensUsed: number;
    previewFirst200: string;
  };
}

/**
 * Memory events
 */
export interface MemoryReadEvent extends AgentEventBase {
  type: 'memory:read';
  data: {
    source: 'shared' | 'session';
    entryCount: number;
  };
}

export interface MemoryWriteEvent extends AgentEventBase {
  type: 'memory:write';
  data: {
    target: 'shared' | 'session';
    entryType: string;
    content: string;
  };
}

/**
 * Verification events (Anti-Hallucination)
 */
export interface VerificationStartEvent extends AgentEventBase {
  type: 'verification:start';
  data: {
    /** What is being verified */
    target: 'subtask' | 'synthesis';
    /** Subtask ID (if verifying subtask) */
    subtaskId?: string;
    /** Executor tier */
    executorTier: 'small' | 'medium' | 'large';
    /** Verifier tier (one level above executor) */
    verifierTier: 'small' | 'medium' | 'large';
  };
}

export interface VerificationCompleteEvent extends AgentEventBase {
  type: 'verification:complete';
  data: {
    /** What was verified */
    target: 'subtask' | 'synthesis';
    /** Subtask ID (if verifying subtask) */
    subtaskId?: string;
    /** Overall confidence (0-1) */
    confidence: number;
    /** Completeness (0-1) */
    completeness: number;
    /** Verified mentions */
    verifiedMentions: string[];
    /** Unverified mentions (potential hallucinations) */
    unverifiedMentions: string[];
    /** Gaps in the answer */
    gaps: string[];
    /** Verification warnings */
    warnings: string[];
    /** Duration in milliseconds */
    durationMs: number;
    /** Action taken based on verification */
    action?: 'accepted' | 'retry' | 'reformulate' | 'follow_up';
  };
}

/**
 * Progress events
 */
export interface ProgressUpdateEvent extends AgentEventBase {
  type: 'progress:update';
  data: {
    phase: string;
    progress: number; // 0-100
    message?: string;
  };
}

export interface StatusChangeEvent extends AgentEventBase {
  type: 'status:change';
  data: {
    status: 'idle' | 'thinking' | 'executing' | 'waiting' | 'done' | 'error' | 'analyzing' | 'planning' | 'researching' | 'finalizing';
    message?: string;
    toolName?: string; // For 'executing' status with specific tool
  };
}

/**
 * Union of all event types
 */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentErrorEvent
  | IterationStartEvent
  | IterationEndEvent
  | LLMStartEvent
  | LLMChunkEvent
  | LLMEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | ToolErrorEvent
  | OrchestratorStartEvent
  | OrchestratorPlanEvent
  | OrchestratorAnswerEvent
  | OrchestratorEndEvent
  | SubtaskStartEvent
  | SubtaskEndEvent
  | SynthesisForcedEvent
  | SynthesisStartEvent
  | SynthesisCompleteEvent
  | MemoryReadEvent
  | MemoryWriteEvent
  | VerificationStartEvent
  | VerificationCompleteEvent
  | ProgressUpdateEvent
  | StatusChangeEvent;

/**
 * Event callback type
 */
export type AgentEventCallback = (event: AgentEvent) => void;

/**
 * Event emitter interface
 */
export interface AgentEventEmitter {
  /**
   * Emit an event to all listeners
   */
  emit(event: AgentEvent): void;

  /**
   * Subscribe to events
   */
  on(callback: AgentEventCallback): () => void;

  /**
   * Subscribe to specific event type
   */
  onType<T extends AgentEventType>(
    type: T,
    callback: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void;
}
