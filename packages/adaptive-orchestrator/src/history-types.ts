/**
 * @module @kb-labs/adaptive-orchestrator/history-types
 * Types for execution history tracking.
 *
 * Enables:
 * - Full replay of orchestration sessions
 * - Diff analysis between runs
 * - Debugging agent behavior
 * - Performance analytics
 */

import type { LLMTier } from '@kb-labs/sdk';
import type { ExecutionPlan, SubtaskResult, OrchestratorResult } from './types.js';

/**
 * Tool call record from agent execution.
 */
export interface ToolCallRecord {
  /** Tool name (e.g., 'fs:read', 'mind:rag-query') */
  name: string;
  /** Tool input parameters */
  input: unknown;
  /** Tool output/result */
  output?: unknown;
  /** Error if tool call failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp when tool was called */
  timestamp: number;
}

/**
 * LLM interaction record.
 */
export interface LLMInteraction {
  /** Type of LLM call */
  type: 'complete' | 'chat' | 'chatWithTools';
  /** LLM tier used */
  tier: LLMTier;
  /** Input prompt or messages */
  input: string | unknown[];
  /** LLM response */
  output: string;
  /** Tokens used (estimated or actual) */
  tokens: number;
  /** Tool calls made (if chatWithTools) */
  toolCalls?: ToolCallRecord[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Subtask execution trace.
 */
export interface SubtaskTrace {
  /** Subtask ID */
  id: number;
  /** Subtask description */
  description: string;
  /** Tier used for execution */
  tier: LLMTier;
  /** Agent used (if any) */
  agentId?: string;
  /** LLM interactions during execution */
  llmInteractions: LLMInteraction[];
  /** Tool calls (if agent was used) */
  toolCalls?: ToolCallRecord[];
  /** Result */
  result: SubtaskResult;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Orchestration session history.
 */
export interface OrchestrationHistory {
  /** Unique session ID */
  sessionId: string;
  /** Original task description */
  task: string;
  /** Classified tier */
  classifiedTier: LLMTier;
  /** Classification confidence */
  classificationConfidence: 'high' | 'low';
  /** Classification method */
  classificationMethod: 'llm' | 'heuristic' | 'hybrid';
  /** Execution plan created */
  plan: ExecutionPlan;
  /** Number of specialist agents loaded */
  agentsLoadedCount: number;
  /** Agent IDs that were available */
  availableAgents: string[];
  /** Subtask execution traces */
  subtaskTraces: SubtaskTrace[];
  /** Final orchestrator result */
  result: OrchestratorResult;
  /** Session start timestamp */
  startTime: number;
  /** Session end timestamp */
  endTime: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Whether session succeeded or failed */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * History storage interface.
 */
export interface IHistoryStorage {
  /**
   * Save orchestration history to storage.
   */
  save(history: OrchestrationHistory): Promise<void>;

  /**
   * Load orchestration history by session ID.
   */
  load(sessionId: string): Promise<OrchestrationHistory | null>;

  /**
   * List all session IDs.
   */
  list(): Promise<string[]>;

  /**
   * Delete history for a session.
   */
  delete(sessionId: string): Promise<void>;
}
