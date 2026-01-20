/**
 * @module @kb-labs/agent-tools/planning
 * Tool for dynamically revising execution plans based on agent findings.
 */

import type { LLMTool } from '@kb-labs/core-platform';
import type { SubTask } from './create-execution-plan.js';

/**
 * Revision action types.
 */
export type RevisionAction = 'add' | 'remove' | 'modify' | 'reorder';

/**
 * Plan revision instruction.
 */
export interface PlanRevision {
  /** Type of revision action */
  action: RevisionAction;
  /** Subtask to add/modify (for add/modify actions) */
  subtask?: SubTask;
  /** Subtask ID to remove/modify (for remove/modify actions) */
  subtaskId?: string;
  /** Reason for this revision */
  reason: string;
}

/**
 * Revised execution plan.
 */
export interface RevisedPlan {
  /** Array of revision instructions */
  revisions: PlanRevision[];
  /** Summary of changes made */
  changeSummary: string;
}

/**
 * Create LLM tool for revising execution plans.
 *
 * Allows orchestrator to dynamically adapt plan based on:
 * - Agent findings (Phase 2 adaptive feedback)
 * - Discovered blockers or issues
 * - New requirements or context
 *
 * @param validSpecialistIds - Array of valid agent IDs
 * @returns LLM tool definition
 *
 * @example
 * ```typescript
 * const tool = createReviseExecutionPlanTool(['implementer', 'researcher', 'tester']);
 *
 * const response = await llm.chatWithTools([...], {
 *   tools: [tool],
 *   toolChoice: { type: 'function', function: { name: 'revise_execution_plan' } }
 * });
 * ```
 */
export function createReviseExecutionPlanTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'revise_execution_plan',
    description: `Revise the current execution plan by adding, removing, modifying, or reordering subtasks.

**Use this tool when:**
- Agent findings reveal need for additional subtasks (e.g., bug found → add fix subtask)
- A subtask is no longer needed (e.g., feature already exists)
- Subtask priorities or dependencies need adjustment
- Execution order needs to change based on new information

**Available agents:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Guidelines:**
- Add subtasks when agent findings require follow-up work
- Remove subtasks that are redundant or no longer applicable
- Modify subtasks to update description, priority, or dependencies
- Provide clear reasons for each revision`,

    inputSchema: {
      type: 'object',
      required: ['revisions', 'changeSummary'],
      properties: {
        revisions: {
          type: 'array',
          description: 'List of revision instructions to apply',
          minItems: 1,
          items: {
            type: 'object',
            required: ['action', 'reason'],
            properties: {
              action: {
                type: 'string',
                description: 'Type of revision action',
                enum: ['add', 'remove', 'modify', 'reorder'],
              },
              subtask: {
                type: 'object',
                description: 'Subtask to add or modify (required for add/modify actions)',
                required: ['id', 'description', 'agentId', 'dependencies', 'priority', 'estimatedComplexity'],
                properties: {
                  id: { type: 'string', pattern: '^subtask-\\d+$' },
                  description: { type: 'string', minLength: 10, maxLength: 500 },
                  agentId: { type: 'string', enum: validSpecialistIds },
                  dependencies: { type: 'array', items: { type: 'string' } },
                  priority: { type: 'number', minimum: 1, maximum: 10 },
                  estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
              },
              subtaskId: {
                type: 'string',
                description: 'ID of subtask to remove or modify (required for remove/modify actions)',
                pattern: '^subtask-\\d+$',
              },
              reason: {
                type: 'string',
                description: 'Clear explanation for why this revision is needed',
                minLength: 10,
                maxLength: 200,
              },
            },
          },
        },
        changeSummary: {
          type: 'string',
          description: 'High-level summary of all revisions made',
          minLength: 20,
          maxLength: 300,
        },
      },
    },
  };
}
