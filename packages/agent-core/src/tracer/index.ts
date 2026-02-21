/**
 * Tracer re-exports — all tracing is now in @kb-labs/agent-tracing.
 * Kept for backward compatibility: anything importing from @kb-labs/agent-core
 * still gets the same API.
 */
export {
  FileTracer,
  IncrementalTraceWriter,
  DEFAULT_TRACE_CONFIG,
  loadTrace,
  formatTraceLoadError,
  TRACE_DIR_RELATIVE,
  redactTraceEvent,
  redactSecretsFromString,
  redactPaths,
  redactValue,
  createDefaultPrivacyConfig,
  createIterationDetailEvent,
  createLLMCallEvent,
  createToolExecutionEvent,
  createMemorySnapshotEvent,
  createDecisionPointEvent,
  createSynthesisForcedEvent,
  createErrorCapturedEvent,
  createPromptDiffEvent,
  createToolFilterEvent,
  createContextTrimEvent,
  createStoppingAnalysisEvent,
  createLLMValidationEvent,
} from '@kb-labs/agent-tracing';
export type {
  TraceConfig,
  TraceIndex,
  TraceLoadResult,
  TraceLoadError,
} from '@kb-labs/agent-tracing';
