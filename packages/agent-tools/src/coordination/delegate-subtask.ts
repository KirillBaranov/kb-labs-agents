/**
 * @module @kb-labs/agent-tools/coordination
 * Tool for explicit subtask delegation to agents.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Delegation instruction.
 */
export interface DelegationInstruction {
  /** Subtask ID being delegated */
  subtaskId: string;
  /** Agent ID to delegate to */
  agentId: string;
  /** Context/input to provide to agent */
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
 * @param validSpecialistIds - Array of valid agent IDs
 * @returns LLM tool definition
 */
export function createDelegateSubtaskTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'delegate_subtask',
    description: `Delegate a subtask to an agent with clear instructions and context.

**Available agents:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Use this tool to:**
- Provide context from previous subtasks
- Set clear expectations for deliverables
- Adjust priority based on current state`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'agentId', 'context', 'expectedOutput', 'priority'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask being delegated',
          pattern: '^subtask-\\d+$',
        },
        agentId: {
          type: 'string',
          description: 'Agent to delegate to',
          enum: validSpecialistIds,
        },
        context: {
          type: 'string',
          description: 'Context and background information for agent',
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
