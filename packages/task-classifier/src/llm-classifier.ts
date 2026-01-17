/**
 * @module @kb-labs/task-classifier/llm-classifier
 * LLM-based task complexity classifier.
 *
 * Uses a small LLM (gpt-4o-mini) to accurately classify task complexity.
 * More accurate than heuristic, but costs ~$0.002 per classification.
 */

import type { ILLM, LLMTier, ClassifyInput, ClassificationResult, ITaskClassifier } from './types.js';

/**
 * LLM classification prompt template.
 */
const CLASSIFICATION_PROMPT = `You are a task complexity classifier for an AI orchestration system.

Your job is to classify tasks into one of three complexity tiers:

**SMALL** (simple, fast tasks):
- Information retrieval (find, search, list, show)
- Reading/checking existing code
- Simple queries
- Tasks that can be done quickly without much reasoning

**MEDIUM** (standard development tasks):
- Implementing features
- Adding/modifying code
- Fixing bugs
- Writing tests
- Standard refactoring
- Tasks requiring some reasoning and code generation

**LARGE** (complex, architectural tasks):
- System design and architecture
- Complex analysis and optimization
- Multi-step planning
- Migration/integration projects
- Tasks requiring deep reasoning and multiple steps

Analyze the following task and respond with ONLY the tier name (SMALL, MEDIUM, or LARGE) and a brief reason (max 20 words).

Format: TIER | Reason

Task: {TASK}`;

/**
 * LLM complexity classifier.
 *
 * Uses a small LLM to classify task complexity with high accuracy.
 * Recommended model: gpt-4o-mini (cheap, fast, accurate).
 *
 * @example
 * ```typescript
 * const llm = useLLM({ tier: 'small' }); // Use cheap model for classification
 * const classifier = new LLMComplexityClassifier(llm);
 *
 * const result = await classifier.classify({
 *   taskDescription: 'Design a scalable multi-tenant architecture'
 * });
 * // result.tier === 'large'
 * // result.confidence === 'high'
 * // result.method === 'llm'
 * ```
 */
export class LLMComplexityClassifier implements ITaskClassifier {
  constructor(private llm: ILLM) {}

  /**
   * Classify task using LLM.
   */
  async classify(input: ClassifyInput): Promise<ClassificationResult> {
    const { taskDescription } = input;

    // Generate prompt
    const prompt = CLASSIFICATION_PROMPT.replace('{TASK}', taskDescription);

    try {
      // Call LLM
      const response = await this.llm.complete(prompt, {
        maxTokens: 50,
        temperature: 0.1, // Low temperature for deterministic classification
      });

      // Parse response
      const text = response.content.trim();
      const match = text.match(/^(SMALL|MEDIUM|LARGE)\s*\|\s*(.+)$/i);

      if (!match || !match[1] || !match[2]) {
        throw new Error(`Invalid LLM response format: ${text}`);
      }

      const tier = match[1].toLowerCase() as LLMTier;
      const reasoning = match[2].trim();

      return {
        tier,
        confidence: 'high', // LLM classifications are always high confidence
        method: 'llm',
        reasoning,
      };
    } catch (error) {
      // Fallback to medium tier on error
      return {
        tier: 'medium',
        confidence: 'low',
        method: 'llm',
        reasoning: `Error during LLM classification: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}
