/**
 * @module @kb-labs/agent-contracts/context
 * Execution context for agent agents
 *
 * Provides context passing from orchestrator to agents including:
 * - Working directories and output paths
 * - Previous results from dependency agents
 * - Findings to reuse
 * - Available files created by previous agents
 */

import type { DelegatedResult } from './callbacks.js';

/**
 * Execution context passed from orchestrator to agent
 *
 * Contains all necessary information for agent to execute
 * its task with full awareness of previous work and environment.
 */
export interface ExecutionContext {
  /**
   * Current working directory (process.cwd())
   */
  workingDir: string;

  /**
   * Project root directory (git root or package.json location)
   */
  projectRoot: string;

  /**
   * Optional output directory for generated artifacts
   *
   * If specified (extracted from task like "output to ./reports"):
   * - Agent should write artifacts here
   *
   * If undefined:
   * - Agent works directly in projectRoot
   * - Modifies files in place (implementer, reviewer, etc.)
   */
  outputDir?: string;

  /**
   * Task description for this subtask
   */
  taskDescription: string;

  /**
   * Subtask ID
   */
  subtaskId: string;

  /**
   * Results from dependency agents
   * Key: subtask ID, Value: delegated result
   */
  previousResults: Map<string, DelegatedResult>;

  /**
   * Key findings extracted from previous agents
   * (summaries, facts, insights)
   */
  findings: string[];

  /**
   * Files created or modified by previous agents
   */
  availableFiles: {
    /**
     * Newly created files (absolute paths)
     */
    created: string[];

    /**
     * Modified existing files (absolute paths)
     */
    modified: string[];
  };
}
