/**
 * @module @kb-labs/agent-tools/coordination
 * Tool for requesting feedback from agents.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Feedback request.
 */
export interface FeedbackRequest {
  /** Subtask ID to get feedback on */
  subtaskId: string;
  /** Agent to request feedback from */
  agentId: string;
  /** Specific questions to answer */
  questions: string[];
  /** Reason for feedback request */
  reason: string;
}

/**
 * Create LLM tool for requesting agent feedback.
 *
 * Allows orchestrator to ask agents for clarification or additional info.
 *
 * @param validSpecialistIds - Array of valid agent IDs
 * @returns LLM tool definition
 */
export function createRequestFeedbackTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'request_feedback',
    description: `Request feedback or clarification from an agent about their work.

**Available agents:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Use this tool when:**
- Agent output needs clarification
- Additional information is needed before proceeding
- Validation of approach or findings is required`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'agentId', 'questions', 'reason'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'Subtask ID to get feedback on',
          pattern: '^subtask-\\d+$',
        },
        agentId: {
          type: 'string',
          description: 'Agent to request feedback from',
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
