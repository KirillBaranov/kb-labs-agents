/**
 * @module @kb-labs/task-classifier/types
 * Type definitions for task complexity classification.
 */

import type { ILLM } from "@kb-labs/sdk";
import type { LLMTier } from "@kb-labs/agent-contracts";

// Re-export for convenience
export type { ILLM, LLMTier };

/**
 * Input for task classification.
 */
export interface ClassifyInput {
  /** The task description from user */
  taskDescription: string;
}

/**
 * Classification result.
 */
export interface ClassificationResult {
  /** Recommended tier for this task */
  tier: LLMTier;
  /** Confidence level in this classification */
  confidence: "high" | "low";
  /** Method used for classification */
  method: "heuristic" | "llm";
  /** Optional reasoning for the classification */
  reasoning?: string;
}

/**
 * Task complexity classifier interface.
 */
export interface ITaskClassifier {
  /**
   * Classify task complexity and recommend tier.
   * @param input - Task classification input
   * @returns Classification result with recommended tier
   */
  classify(input: ClassifyInput): Promise<ClassificationResult>;
}

/**
 * Heuristic classification rules.
 */
export interface HeuristicRule {
  /** Keywords to match (case-insensitive) */
  keywords: string[];
  /** Tier to assign if matched */
  tier: LLMTier;
  /** Weight of this rule (0-1) */
  weight: number;
}
