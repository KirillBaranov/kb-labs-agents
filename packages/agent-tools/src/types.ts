/**
 * Tool types and interfaces
 */

import type { ToolDefinition, ToolResult } from '@kb-labs/agent-contracts';

/**
 * Tool executor function
 */
export type ToolExecutor = (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/**
 * Tool registration
 */
export interface Tool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/**
 * Tool context (working directory, etc.)
 */
export interface ToolContext {
  workingDir: string;
  sessionId?: string;
  verbose?: boolean;
}
