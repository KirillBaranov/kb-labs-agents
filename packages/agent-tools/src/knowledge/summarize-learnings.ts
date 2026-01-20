/**
 * @module @kb-labs/agent-tools/knowledge
 * Tool for summarizing insights and lessons learned.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Learning category.
 */
export type LearningCategory = 'success' | 'challenge' | 'improvement' | 'best-practice' | 'warning';

/**
 * Individual learning.
 */
export interface Learning {
  /** Category of learning */
  category: LearningCategory;
  /** Learning description */
  description: string;
  /** Context where this applies */
  context: string;
}

/**
 * Summarized learnings.
 */
export interface SummarizedLearnings {
  /** Subtask ID */
  subtaskId: string;
  /** Agent who generated summary */
  agentId: string;
  /** Key learnings */
  learnings: Learning[];
  /** Recommendations for future similar tasks */
  recommendations: string[];
  /** Overall summary */
  summary: string;
}

/**
 * Create LLM tool for summarizing learnings.
 *
 * Captures insights, lessons learned, and best practices
 * for knowledge retention and continuous improvement.
 *
 * @returns LLM tool definition
 */
export function createSummarizeLearningsTool(): LLMTool {
  return {
    name: 'summarize_learnings',
    description: `Summarize key insights and lessons learned from task execution.

**Use this tool at end of subtask to capture:**
- What worked well (successes)
- What was difficult (challenges)
- What could be better (improvements)
- Patterns to follow (best practices)
- Pitfalls to avoid (warnings)

**Learning categories:**
- success: What worked well and why
- challenge: Difficulties encountered and how overcome
- improvement: What could be done better next time
- best-practice: Patterns worth following
- warning: Pitfalls to avoid in similar situations

**Benefits:**
- Knowledge retention across tasks
- Continuous improvement
- Prevents repeating mistakes
- Shares successful patterns
- Builds team knowledge base`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'agentId', 'learnings', 'recommendations', 'summary'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of completed subtask',
          pattern: '^subtask-\\d+$',
        },
        agentId: {
          type: 'string',
          description: 'Agent generating this summary',
        },
        learnings: {
          type: 'array',
          description: 'Key learnings from this subtask',
          minItems: 1,
          items: {
            type: 'object',
            required: ['category', 'description', 'context'],
            properties: {
              category: {
                type: 'string',
                description: 'Category of learning',
                enum: ['success', 'challenge', 'improvement', 'best-practice', 'warning'],
              },
              description: {
                type: 'string',
                description: 'What was learned',
                minLength: 20,
                maxLength: 300,
              },
              context: {
                type: 'string',
                description: 'Context where this learning applies',
                minLength: 10,
                maxLength: 200,
              },
            },
          },
        },
        recommendations: {
          type: 'array',
          description: 'Recommendations for future similar tasks',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 20,
            maxLength: 300,
          },
        },
        summary: {
          type: 'string',
          description: 'Overall summary of learnings',
          minLength: 50,
          maxLength: 500,
        },
      },
    },
  };
}
