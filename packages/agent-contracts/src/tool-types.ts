/**
 * Tool System Types
 *
 * Defines types for tool discovery, execution, and results
 */

/**
 * JSON Schema for tool input
 *
 * This is the schema that LLM sees and uses to generate tool calls
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Tool definition (what LLM sees)
 */
export interface ToolDefinition {
  /** Unique tool name (e.g., "fs:read", "mind:rag-query", "shell:pnpm") */
  name: string;
  /** Human-readable description for LLM */
  description: string;
  /** JSON Schema for tool input */
  inputSchema: ToolInputSchema;
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  /** Tool name to execute */
  name: string;
  /** Tool input (validated against inputSchema) */
  input: unknown;
  /** Optional tool call ID (for tracking) */
  id?: string;
}

/**
 * Tool execution error
 */
export interface ToolError {
  /** Error code (e.g., "FS_ERROR", "PERMISSION_DENIED", "INVALID_INPUT") */
  code: string;
  /** Error message */
  message: string;
  /** Additional error details */
  details?: unknown;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  /** Whether tool execution succeeded */
  success: boolean;
  /** Tool output (if success = true) */
  output?: string;
  /** Error details (if success = false) */
  error?: ToolError;
  /** Execution metadata (duration, tokens used, etc.) */
  metadata?: {
    /** Execution duration in milliseconds */
    durationMs?: number;
    /** Tokens used (for LLM-based tools) */
    tokensUsed?: number;
    [key: string]: unknown;
  };
}

/**
 * Tool category
 */
export type ToolCategory = "filesystem" | "shell" | "kb-labs" | "builtin";

/**
 * Tool metadata (for internal use)
 */
export interface ToolMetadata {
  /** Tool name */
  name: string;
  /** Tool category */
  category: ToolCategory;
  /** Whether tool requires confirmation */
  requiresConfirmation?: boolean;
  /** Whether tool is destructive (modifies state) */
  isDestructive?: boolean;
  /** Source plugin ID (for kb-labs tools) */
  sourcePlugin?: string;
}
