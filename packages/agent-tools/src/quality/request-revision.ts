/**
 * @module @kb-labs/agent-tools/quality
 * Tool for requesting revisions to specialist output.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Revision request.
 */
export interface RevisionRequest {
  /** Subtask ID needing revision */
  subtaskId: string;
  /** Specialist to revise */
  specialistId: string;
  /** Issues requiring revision */
  issues: string[];
  /** Specific changes requested */
  requestedChanges: string[];
  /** Priority of revision (1-10) */
  priority: number;
  /** Reason for revision */
  reason: string;
}

/**
 * Create LLM tool for requesting output revisions.
 *
 * Asks specialist to fix issues or make improvements.
 *
 * @param validSpecialistIds - Array of valid specialist IDs
 * @returns LLM tool definition
 */
export function createRequestRevisionTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'request_revision',
    description: `Request revision to specialist output due to issues or needed improvements.

**Available specialists:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Use this tool when:**
- Validation found issues that need fixing
- Output doesn't fully meet requirements
- Quality improvements are needed
- Changes required based on feedback

**Be specific:**
- Clearly describe each issue
- Provide actionable change requests
- Explain why revision is needed`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'specialistId', 'issues', 'requestedChanges', 'priority', 'reason'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask needing revision',
          pattern: '^subtask-\\d+$',
        },
        specialistId: {
          type: 'string',
          description: 'Specialist to revise',
          enum: validSpecialistIds,
        },
        issues: {
          type: 'array',
          description: 'Issues found that require revision',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 300,
          },
        },
        requestedChanges: {
          type: 'array',
          description: 'Specific changes requested',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 300,
          },
        },
        priority: {
          type: 'number',
          description: 'Priority of this revision (10 = critical, 1 = optional)',
          minimum: 1,
          maximum: 10,
        },
        reason: {
          type: 'string',
          description: 'Clear explanation of why revision is needed',
          minLength: 20,
          maxLength: 500,
        },
      },
    },
  };
}
