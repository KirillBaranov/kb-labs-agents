/**
 * @module @kb-labs/adaptive-orchestrator/types
 * Type definitions for adaptive orchestration.
 */

import type { LLMTier } from '@kb-labs/sdk';

/**
 * Subtask definition from planning phase.
 */
export interface Subtask {
  /** Subtask ID (1-based) */
  id: number;
  /** Description of the subtask */
  description: string;
  /** Recommended complexity tier */
  complexity: LLMTier;
  /** Dependencies (IDs of subtasks that must complete first) */
  dependencies?: number[];
  /** Optional: Specialist agent to handle this subtask */
  agentId?: string;
  /** Optional: Reasoning for agent selection */
  reasoning?: string;
}

/**
 * Execution plan from planning phase.
 */
export interface ExecutionPlan {
  /** List of subtasks to execute */
  subtasks: Subtask[];
  /** Estimated total cost */
  estimatedCost?: string;
}

/**
 * Subtask execution result.
 */
export interface SubtaskResult {
  /** Subtask ID */
  id: number;
  /** Execution status */
  status: 'success' | 'failed';
  /** Tier used for execution */
  tier: LLMTier;
  /** Agent used (if any) */
  agentId?: string;
  /** Result content */
  content?: string;
  /** Error message (if failed) */
  error?: string;
  /** Token usage */
  tokens?: number;
  /** Estimated cost */
  cost?: number;
}

/**
 * Orchestrator execution result.
 */
export interface OrchestratorResult {
  /** Overall status */
  status: 'success' | 'failed';
  /** Final synthesized result */
  result: string;
  /** Cost breakdown */
  costBreakdown: {
    total: string;
    small: string;
    medium: string;
    large: string;
  };
  /** All subtask results */
  subtaskResults?: SubtaskResult[];
}

/**
 * Orchestrator configuration.
 */
export interface OrchestratorConfig {
  /** Maximum escalation attempts per subtask */
  maxEscalations?: number;
  /** Enable cost tracking */
  trackCost?: boolean;
  /** Model pricing (tokens per dollar) */
  pricing?: {
    small: number;   // e.g., 1000000 for $1/1M tokens
    medium: number;
    large: number;
  };
}
