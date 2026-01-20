/**
 * @module @kb-labs/agent-tools/planning
 * Tool for estimating task complexity before planning.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Complexity factors identified.
 */
export interface ComplexityFactor {
  /** Factor name (e.g., "multiple files", "external dependencies") */
  factor: string;
  /** Impact on complexity (low/medium/high) */
  impact: 'low' | 'medium' | 'high';
  /** Explanation of why this factor matters */
  explanation: string;
}

/**
 * Complexity estimation result.
 */
export interface ComplexityEstimate {
  /** Overall complexity level */
  overallComplexity: 'low' | 'medium' | 'high';
  /** Estimated number of subtasks needed */
  estimatedSubtasks: number;
  /** Factors contributing to complexity */
  factors: ComplexityFactor[];
  /** Recommended agent types */
  recommendedSpecialists: string[];
  /** Summary reasoning */
  reasoning: string;
}

/**
 * Create LLM tool for estimating task complexity.
 *
 * Helps orchestrator understand task difficulty before creating execution plan.
 *
 * @returns LLM tool definition
 *
 * @example
 * ```typescript
 * const tool = createEstimateComplexityTool();
 *
 * const response = await llm.chatWithTools([...], {
 *   tools: [tool],
 *   toolChoice: { type: 'function', function: { name: 'estimate_complexity' } }
 * });
 * ```
 */
export function createEstimateComplexityTool(): LLMTool {
  return {
    name: 'estimate_complexity',
    description: `Estimate the complexity of a task before creating an execution plan.

**Use this tool to:**
- Assess task difficulty (low/medium/high)
- Identify complexity factors (multiple files, external deps, etc.)
- Determine how many subtasks will be needed
- Recommend which agents to involve

**Common complexity factors:**
- Number of files to modify (1 = low, 3-5 = medium, 10+ = high)
- External dependencies (APIs, databases, third-party libs)
- Code refactoring scope (single function vs entire module)
- Testing requirements (unit only vs integration + e2e)
- Documentation needs
- Cross-cutting concerns (affects multiple components)`,

    inputSchema: {
      type: 'object',
      required: ['overallComplexity', 'estimatedSubtasks', 'factors', 'recommendedSpecialists', 'reasoning'],
      properties: {
        overallComplexity: {
          type: 'string',
          description: 'Overall complexity assessment',
          enum: ['low', 'medium', 'high'],
        },
        estimatedSubtasks: {
          type: 'number',
          description: 'Estimated number of subtasks needed (1-10)',
          minimum: 1,
          maximum: 10,
        },
        factors: {
          type: 'array',
          description: 'Complexity factors identified',
          minItems: 1,
          items: {
            type: 'object',
            required: ['factor', 'impact', 'explanation'],
            properties: {
              factor: {
                type: 'string',
                description: 'Name of complexity factor',
                minLength: 5,
                maxLength: 100,
              },
              impact: {
                type: 'string',
                description: 'Impact level of this factor',
                enum: ['low', 'medium', 'high'],
              },
              explanation: {
                type: 'string',
                description: 'Why this factor affects complexity',
                minLength: 10,
                maxLength: 200,
              },
            },
          },
        },
        recommendedSpecialists: {
          type: 'array',
          description: 'Recommended agent types for this task',
          minItems: 1,
          items: {
            type: 'string',
            description: 'Agent type (e.g., implementer, researcher, tester)',
          },
        },
        reasoning: {
          type: 'string',
          description: 'Summary of complexity assessment reasoning',
          minLength: 50,
          maxLength: 500,
        },
      },
    },
  };
}
