/**
 * @module @kb-labs/agent-tools/quality
 * Tool for approving agent results.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Result approval.
 */
export interface ResultApproval {
  /** Subtask ID being approved */
  subtaskId: string;
  /** Agent who produced result */
  agentId: string;
  /** Key deliverables approved */
  approvedDeliverables: string[];
  /** Quality highlights */
  qualityHighlights: string[];
  /** Approval notes */
  notes: string;
}

/**
 * Create LLM tool for approving agent results.
 *
 * Formally approves output and allows proceeding to next steps.
 *
 * @returns LLM tool definition
 */
export function createApproveResultTool(): LLMTool {
  return {
    name: 'approve_result',
    description: `Formally approve agent result after validation.

**Use this tool when:**
- Output passes all validation criteria
- Quality meets or exceeds standards
- All deliverables are present and correct
- Ready to proceed to dependent subtasks

**Approval indicates:**
- Work is complete and satisfactory
- No further revisions needed
- Can be used as input for next subtasks`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'agentId', 'approvedDeliverables', 'qualityHighlights', 'notes'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask being approved',
          pattern: '^subtask-\\d+$',
        },
        agentId: {
          type: 'string',
          description: 'Agent who produced this result',
        },
        approvedDeliverables: {
          type: 'array',
          description: 'Key deliverables that are approved',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 5,
            maxLength: 200,
          },
        },
        qualityHighlights: {
          type: 'array',
          description: 'Positive quality aspects worth highlighting',
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 200,
          },
        },
        notes: {
          type: 'string',
          description: 'Approval notes and any additional context',
          minLength: 20,
          maxLength: 500,
        },
      },
    },
  };
}
