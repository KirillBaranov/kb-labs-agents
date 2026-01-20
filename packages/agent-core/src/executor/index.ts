// Agent Executor exports
export { LoopDetector } from './loop-detector.js';
export { AgentExecutor } from './agent-executor.js';
export { ReActParser, extractToolCall, hasToolCallIntent } from './react-parser.js';
export type { ParsedReActStep } from './react-parser.js';
export { ContextCompressor } from './context-compressor.js';
export type { Message, CompressionResult } from './context-compressor.js';
export { ExecutionMemory } from './execution-memory.js';
export type { Finding, MemorySummary } from './execution-memory.js';
export { ProgressTracker } from './progress-tracker.js';
export type { ProgressEstimate } from './progress-tracker.js';
export { ErrorRecovery } from './error-recovery.js';
export type { RecoveryAction, RecoveryResult, RecoveryStrategyType } from './error-recovery.js';
export { parseTerminationSignal, shouldGiveUp } from './termination-parser.js';
export type { TerminationSignal } from './termination-parser.js';

// Agent Executor types (V2)
export type { AgentContext, AgentResult } from './agent-executor.js';

// Session State Manager exports (V2)
export { SessionStateManager } from './session-state-manager.js';
export type {
  SessionState,
  SessionFinding,
  Artifact,
  ArtifactReference,
} from './session-state-manager.js';

// Orchestrator Executor exports (V2)
export { OrchestratorExecutor } from './orchestrator-executor.js';

// Phase 2: Adaptive Feedback Loop exports
export { FindingsStore } from './findings-store.js';
export type {
  SubTask,
  DelegatedResult,
  OrchestratorResult,
  AgentFinding,
  FindingsSummary,
  AdaptationDecision,
  StoredFindings,
  FindingsRegistry,
} from './types.js';
