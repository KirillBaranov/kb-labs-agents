/**
 * Tool types and interfaces
 */

import type { ToolDefinition, ToolResult } from '@kb-labs/agent-contracts';
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
 * Interface for file change tracking (matches FileChangeTracker from agent-core).
 * Defined here to avoid circular dependency: agent-tools cannot import agent-core.
 */
export interface IFileChangeTracker {
  captureChange(
    filePath: string,
    operation: 'write' | 'patch' | 'delete',
    beforeContent: string | null,
    afterContent: string,
    metadata?: Record<string, unknown>,
  ): Promise<unknown>;
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
  /** File change tracker for history (optional - injected by Agent) */
  fileChangeTracker?: IFileChangeTracker;
  /** Agent ID for attribution */
  agentId?: string;
  /** Archive memory for cold storage recall (Tier 2) */
  archiveMemory?: IArchiveMemory;
  /** Spawn sub-agent callback (injected by Agent, not available for sub-agents) */
  spawnAgent?: (request: {
    task: string;
    maxIterations?: number;
    workingDir?: string;
  }) => Promise<{ success: boolean; result: string; iterations: number; tokensUsed: number }>;
}
