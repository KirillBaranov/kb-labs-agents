/**
 * Tool types and interfaces
 */

import type { ToolDefinition, ToolResult, SpawnAgentRequest, SpawnAgentResult, AsyncTask } from '@kb-labs/agent-contracts';
import type { ICache } from '@kb-labs/core-platform';

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
 * Interface for ArchiveMemory (Tier 2: Cold Storage).
 * Defined here to avoid circular dependency: agent-tools cannot import agent-core.
 */
export interface IArchiveMemory {
  recallByFilePath(filePath: string): { fullOutput: string; iteration: number; toolName: string } | null;
  recallByToolName(toolName: string, limit?: number): Array<{ fullOutput: string; iteration: number; toolName: string; filePath?: string }>;
  recallByIteration(iteration: number): Array<{ fullOutput: string; iteration: number; toolName: string; filePath?: string }>;
  search(keyword: string, limit?: number): Array<{ fullOutput: string; toolName: string; iteration: number; filePath?: string }>;
  getArchivedFilePaths(): string[];
  hasFile(filePath: string): boolean;
  getSummaryHint(): string;
}

/**
 * Tool context (working directory, etc.)
 */
export interface ToolContext {
  workingDir: string;
  sessionId?: string;
  verbose?: boolean;
  /** Shared platform cache adapter (optional) */
  cache?: ICache;
  /** Files that were read in this session (for edit protection) */
  filesRead?: Set<string>;
  /** File content hashes from when files were read (for change detection) */
  filesReadHash?: Map<string, string>;
  /** Agent ID for attribution */
  agentId?: string;
  /** Archive memory for cold storage recall (Tier 2) */
  archiveMemory?: IArchiveMemory;
  /**
   * If set, only tools whose names are in this set will be registered.
   * Used by plan mode to restrict both the plan-writer and any sub-agents
   * it spawns to read-only tools — without touching AgentConfig.
   */
  allowedTools?: Set<string>;
  /** Async task manager for sub-agent delegation (submit/status/collect). */
  taskManager?: ITaskManager;
  /**
   * Set to true by plan_validate tool when the plan passes the quality gate.
   * Checked by report tool in plan mode — report is blocked until this is set.
   */
  planValidationPassed?: boolean;
}

/**
 * Interface for async task management.
 * Defined here to avoid circular dependency: agent-tools cannot import agent-core.
 * Implemented by TaskMiddleware in agent-core.
 */
export interface ITaskManager {
  submit(description: string, request: SpawnAgentRequest): Promise<AsyncTask>;
  getStatus(taskId?: string): AsyncTask | AsyncTask[] | null;
  collect(taskId: string): Promise<SpawnAgentResult>;
}
