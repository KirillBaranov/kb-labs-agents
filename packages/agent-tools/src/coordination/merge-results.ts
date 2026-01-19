/**
 * @module @kb-labs/agent-tools/coordination
 * Tool for merging results from multiple specialists.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Result to merge.
 */
export interface ResultToMerge {
  /** Subtask ID */
  subtaskId: string;
  /** Specialist who produced this result */
  specialistId: string;
  /** Key findings or deliverables */
  keyFindings: string[];
}

/**
 * Merged results.
 */
export interface MergedResults {
  /** Results being merged */
  results: ResultToMerge[];
  /** Synthesized summary */
  synthesis: string;
  /** Conflicts or inconsistencies found */
  conflicts?: string[];
  /** Recommended next steps */
  nextSteps: string[];
}

/**
 * Create LLM tool for merging specialist results.
 *
 * Synthesizes outputs from multiple specialists into coherent summary.
 *
 * @returns LLM tool definition
 */
export function createMergeResultsTool(): LLMTool {
  return {
    name: 'merge_results',
    description: `Merge and synthesize results from multiple specialists.

**Use this tool to:**
- Combine findings from parallel subtasks
- Identify conflicts or inconsistencies
- Create coherent summary from multiple outputs
- Determine next steps based on combined results`,

    inputSchema: {
      type: 'object',
      required: ['results', 'synthesis', 'nextSteps'],
      properties: {
        results: {
          type: 'array',
          description: 'Results to merge',
          minItems: 2,
          items: {
            type: 'object',
            required: ['subtaskId', 'specialistId', 'keyFindings'],
            properties: {
              subtaskId: {
                type: 'string',
                pattern: '^subtask-\\d+$',
              },
              specialistId: {
                type: 'string',
              },
              keyFindings: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
              },
            },
          },
        },
        synthesis: {
          type: 'string',
          description: 'Synthesized summary of all results',
          minLength: 50,
          maxLength: 1000,
        },
        conflicts: {
          type: 'array',
          description: 'Conflicts or inconsistencies found (optional)',
          items: {
            type: 'string',
            minLength: 20,
            maxLength: 300,
          },
        },
        nextSteps: {
          type: 'array',
          description: 'Recommended next steps based on merged results',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 200,
          },
        },
      },
    },
  };
}
