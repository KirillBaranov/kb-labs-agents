/**
 * @module @kb-labs/task-classifier/heuristic-classifier
 * Heuristic-based task complexity classifier.
 *
 * Fast, rule-based classification using keywords and patterns.
 * Supports both English and Russian keywords.
 */

import type {
  ClassifyInput,
  ClassificationResult,
  HeuristicRule,
  ITaskClassifier,
} from "./types.js";
import type { LLMTier } from "@kb-labs/agent-contracts";

/**
 * Default heuristic rules for task classification.
 */
const DEFAULT_RULES: HeuristicRule[] = [
  // SMALL tier - simple, fast tasks
  {
    keywords: [
      "find",
      "search",
      "list",
      "show",
      "get",
      "read",
      "check",
      "verify",
    ],
    tier: "small",
    weight: 0.8,
  },
  {
    keywords: [
      "найди",
      "найти",
      "покажи",
      "показать",
      "список",
      "прочитай",
      "проверь",
    ],
    tier: "small",
    weight: 0.8,
  },

  // MEDIUM tier - standard development tasks
  {
    keywords: [
      "implement",
      "add",
      "create",
      "update",
      "modify",
      "fix",
      "refactor",
      "test",
    ],
    tier: "medium",
    weight: 0.7,
  },
  {
    keywords: [
      "реализуй",
      "реализовать",
      "добавь",
      "добавить",
      "создай",
      "создать",
      "исправь",
      "исправить",
      "обнови",
      "обновить",
    ],
    tier: "medium",
    weight: 0.7,
  },

  // LARGE tier - complex, architectural tasks
  {
    keywords: [
      "design",
      "architect",
      "plan",
      "analyze",
      "optimize",
      "migrate",
      "scale",
      "integrate",
    ],
    tier: "large",
    weight: 0.9,
  },
  {
    keywords: [
      "спроектируй",
      "спроектировать",
      "проанализируй",
      "проанализировать",
      "оптимизируй",
      "оптимизировать",
      "интегрируй",
      "интегрировать",
    ],
    tier: "large",
    weight: 0.9,
  },

  // Length-based rules
  {
    keywords: [], // Handled separately
    tier: "small",
    weight: 0.5,
  },
];

/**
 * Heuristic complexity classifier.
 *
 * Uses keyword matching and pattern recognition to quickly classify tasks.
 * Free to run, but less accurate than LLM-based classification.
 *
 * @example
 * ```typescript
 * const classifier = new HeuristicComplexityClassifier();
 *
 * const result = await classifier.classify({
 *   taskDescription: 'Find all TODO comments in the codebase'
 * });
 * // result.tier === 'small'
 * // result.confidence === 'high'
 * // result.method === 'heuristic'
 * ```
 */
export class HeuristicComplexityClassifier implements ITaskClassifier {
  constructor(private rules: HeuristicRule[] = DEFAULT_RULES) {}

  /**
   * Classify task using heuristic rules.
   */
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    const { taskDescription } = input;
    const lowerTask = taskDescription.toLowerCase();

    // Calculate scores for each tier
    const scores: Record<LLMTier, number> = {
      small: 0,
      medium: 0,
      large: 0,
    };

    // Apply keyword rules
    for (const rule of this.rules) {
      if (rule.keywords.length === 0) {
        continue;
      } // Skip length-based rule

      for (const keyword of rule.keywords) {
        if (lowerTask.includes(keyword.toLowerCase())) {
          scores[rule.tier] += rule.weight;
          break; // Only count each rule once
        }
      }
    }

    // Length-based heuristic
    const wordCount = taskDescription.split(/\s+/).length;
    if (wordCount <= 10) {
      scores.small += 0.3;
    } else if (wordCount <= 30) {
      scores.medium += 0.3;
    } else {
      scores.large += 0.4;
    }

    // Complexity indicators
    if (
      /\b(multi-step|complex|comprehensive|detailed|thorough)\b/i.test(
        taskDescription,
      )
    ) {
      scores.large += 0.5;
    }

    // Determine winner
    const [tier, score] = Object.entries(scores).reduce((max, entry) =>
      entry[1] > max[1] ? entry : max,
    ) as [LLMTier, number];

    // Determine confidence
    // High confidence if score is significantly higher than others
    const secondHighest =
      Object.values(scores)
        .filter((s) => s !== score)
        .sort((a, b) => b - a)[0] ?? 0;

    const confidence: "high" | "low" =
      score - secondHighest >= 0.5 ? "high" : "low";

    return {
      tier,
      confidence,
      method: "heuristic",
      reasoning: `Matched keywords and patterns (score: ${score.toFixed(2)})`,
    };
  }
}
