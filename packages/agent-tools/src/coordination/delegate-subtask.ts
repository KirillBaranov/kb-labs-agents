/**
 * @module @kb-labs/agent-tools/coordination
 * Tool for explicit subtask delegation to specialists.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Delegation instruction.
 */
export interface DelegationInstruction {
  /** Subtask ID being delegated */
  subtaskId: string;
  /** Specialist ID to delegate to */
  specialistId: string;
  /** Context/input to provide to specialist */
  context: string;
  /** Expected output/deliverable */
  expectedOutput: string;
  /** Priority level (1-10) */
  priority: number;
}

/**
 * Create LLM tool for delegating subtasks.
 *
 * Provides explicit delegation instructions with context.
 *
 * @param validSpecialistIds - Array of valid specialist IDs
 * @returns LLM tool definition
 */
export function createDelegateSubtaskTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'delegate_subtask',
    description: `Delegate a subtask to a specialist with clear instructions and context.

**Available specialists:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Use this tool to:**
- Provide context from previous subtasks
- Set clear expectations for deliverables
- Adjust priority based on current state`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'specialistId', 'context', 'expectedOutput', 'priority'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask being delegated',
          pattern: '^subtask-\\d+$',
        },
        specialistId: {
          type: 'string',
          description: 'Specialist to delegate to',
          enum: validSpecialistIds,
        },
        context: {
          type: 'string',
          description: 'Context and background information for specialist',
          minLength: 20,
          maxLength: 1000,
        },
        expectedOutput: {
          type: 'string',
          description: 'Clear description of expected deliverable',
          minLength: 20,
          maxLength: 500,
        },
        priority: {
          type: 'number',
          description: 'Priority level (10 = critical, 1 = optional)',
          minimum: 1,
          maximum: 10,
        },
      },
    },
  };
}
