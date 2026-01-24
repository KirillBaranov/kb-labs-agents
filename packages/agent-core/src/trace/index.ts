/**
 * Tool Trace Module
 *
 * Runtime truth system for verification and anti-hallucination.
 */

export {
  InMemoryToolTraceStore,
  createToolTraceStore,
} from "./tool-trace-store.js";
export type { IToolTraceStore } from "./tool-trace-store.js";

export {
  ToolTraceRecorder,
  createToolTraceRecorder,
} from "./tool-trace-recorder.js";
export type { ToolTraceRecorderConfig } from "./tool-trace-recorder.js";

export {
  NoOpSchemaValidator,
  ZodSchemaValidator,
  createSchemaValidator,
  validateToolResult,
} from "./schema-validator.js";
export type {
  ISchemaValidator,
  ValidationResult,
  ValidationError,
} from "./schema-validator.js";
