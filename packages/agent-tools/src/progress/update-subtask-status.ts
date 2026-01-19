/**
 * @module @kb-labs/agent-tools/progress
 * Tool for updating subtask status during execution.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Subtask status values.
 */
export type SubtaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked';

/**
 * Status update.
 */
export interface StatusUpdate {
  /** Subtask ID */
  subtaskId: string;
  /** New status */
  status: SubtaskStatus;
  /** Progress percentage (0-100) */
  progressPercent: number;
  /** Status message */
  message: string;
  /** Estimated completion time (ISO 8601 duration, optional) */
  estimatedCompletion?: string;
}

/**
 * Create LLM tool for updating subtask status.
 *
 * Tracks execution progress in real-time.
 *
 * @returns LLM tool definition
 */
export function createUpdateSubtaskStatusTool(): LLMTool {
  return {
    name: 'update_subtask_status',
    description: `Update the status of a subtask during execution.

**Status values:**
- pending: Not started yet
- in-progress: Currently being worked on
- completed: Successfully finished
- failed: Encountered unrecoverable error
- blocked: Waiting on dependency or blocker

**Use this tool to:**
- Track progress of long-running subtasks
- Report completion or failures
- Indicate blockers or dependencies`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'status', 'progressPercent', 'message'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask being updated',
          pattern: '^subtask-\\d+$',
        },
        status: {
          type: 'string',
          description: 'New status value',
          enum: ['pending', 'in-progress', 'completed', 'failed', 'blocked'],
        },
        progressPercent: {
          type: 'number',
          description: 'Progress percentage (0-100)',
          minimum: 0,
          maximum: 100,
        },
        message: {
          type: 'string',
          description: 'Status message explaining current state',
          minLength: 10,
          maxLength: 300,
        },
        estimatedCompletion: {
          type: 'string',
          description: 'Estimated time to completion (ISO 8601 duration, e.g., "PT5M" for 5 minutes)',
          pattern: '^PT\\d+[HMS]$',
        },
      },
    },
  };
}
