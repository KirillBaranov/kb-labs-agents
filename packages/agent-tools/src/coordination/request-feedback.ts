/**
 * @module @kb-labs/agent-tools/coordination
 * Tool for requesting feedback from specialists.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Feedback request.
 */
export interface FeedbackRequest {
  /** Subtask ID to get feedback on */
  subtaskId: string;
  /** Specialist to request feedback from */
  specialistId: string;
  /** Specific questions to answer */
  questions: string[];
  /** Reason for feedback request */
  reason: string;
}

/**
 * Create LLM tool for requesting specialist feedback.
 *
 * Allows orchestrator to ask specialists for clarification or additional info.
 *
 * @param validSpecialistIds - Array of valid specialist IDs
 * @returns LLM tool definition
 */
export function createRequestFeedbackTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'request_feedback',
    description: `Request feedback or clarification from a specialist about their work.

**Available specialists:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Use this tool when:**
- Specialist output needs clarification
- Additional information is needed before proceeding
- Validation of approach or findings is required`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'specialistId', 'questions', 'reason'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'Subtask ID to get feedback on',
          pattern: '^subtask-\\d+$',
        },
        specialistId: {
          type: 'string',
          description: 'Specialist to request feedback from',
          enum: validSpecialistIds,
        },
        questions: {
          type: 'array',
          description: 'Specific questions to answer',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 200,
          },
        },
        reason: {
          type: 'string',
          description: 'Why this feedback is needed',
          minLength: 20,
          maxLength: 300,
        },
      },
    },
  };
}
