/**
 * @module @kb-labs/agent-tools/planning
 * Tool for creating structured execution plans with specialist delegation.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Subtask in execution plan.
 */
export interface SubTask {
  /** Unique identifier (e.g., "subtask-1") */
  id: string;
  /** Clear, actionable description of what to do */
  description: string;
  /** ID of specialist to delegate to */
  specialistId: string;
  /** Array of subtask IDs that must complete first */
  dependencies: string[];
  /** Priority 1-10 (10 = critical, 1 = optional) */
  priority: number;
  /** Estimated complexity */
  estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * Execution plan returned by tool.
 */
export interface ExecutionPlan {
  /** Array of subtasks (minimum 1 required) */
  subtasks: SubTask[];
}

/**
 * Create LLM tool for structured execution planning.
 *
 * Forces LLM to return a valid JSON schema with at least 1 subtask.
 *
 * @param validSpecialistIds - Array of valid specialist IDs
 * @returns LLM tool definition
 *
 * @example
 * ```typescript
 * const tool = createExecutionPlanTool(['implementer', 'researcher', 'tester']);
 *
 * const response = await llm.chatWithTools([...], {
 *   tools: [tool],
 *   tool_choice: { type: 'tool', name: 'create_execution_plan' }
 * });
 *
 * const plan = response.toolCalls[0].input as ExecutionPlan;
 * console.log(plan.subtasks); // Guaranteed to have at least 1 subtask
 * ```
 */
export function createExecutionPlanTool(validSpecialistIds: string[]): LLMTool {
  return {
    name: 'create_execution_plan',
    description: `Create a structured execution plan by delegating tasks to specialist team members.

**Your role as orchestrator:**
- Analyze the user's task requirements
- Break down complex tasks into logical subtasks (2-4 subtasks recommended)
- Assign each subtask to the most appropriate specialist
- Define dependencies between subtasks
- Set priorities (higher number = more critical)

**Available specialists:**
${validSpecialistIds.map(id => `- ${id}`).join('\n')}

**Guidelines:**
- ALWAYS create at least 1 subtask (NEVER return empty array)
- Use ONLY specialists from the available list above
- Keep subtask descriptions clear and actionable
- Define dependencies carefully (e.g., reviewer depends on implementer)
- Assign realistic priorities (10 = critical blocker, 1 = nice-to-have)
- Estimate complexity honestly (affects resource allocation)

**Example workflow patterns:**
- Simple task: implementer → reviewer
- Medium task: researcher → implementer → tester
- Complex task: researcher → implementer → reviewer → tester (with parallel paths)`,

    inputSchema: {
      type: 'object',
      required: ['subtasks'],
      properties: {
        subtasks: {
          type: 'array',
          description: 'Array of subtasks to execute (minimum 1 required)',
          minItems: 1, // CRITICAL: Prevents empty array
          items: {
            type: 'object',
            required: ['id', 'description', 'specialistId', 'dependencies', 'priority', 'estimatedComplexity'],
            properties: {
              id: {
                type: 'string',
                description: 'Unique identifier (e.g., "subtask-1", "subtask-2")',
                pattern: '^subtask-\\d+$',
              },
              description: {
                type: 'string',
                description: 'Clear, actionable description of what this subtask should accomplish',
                minLength: 10,
                maxLength: 500,
              },
              specialistId: {
                type: 'string',
                description: 'ID of specialist to delegate this subtask to',
                enum: validSpecialistIds,
              },
              dependencies: {
                type: 'array',
                description: 'Array of subtask IDs that must complete before this one (use [] if no dependencies)',
                items: {
                  type: 'string',
                  pattern: '^subtask-\\d+$',
                },
              },
              priority: {
                type: 'number',
                description: 'Priority level: 10 = critical blocker, 1 = optional nice-to-have',
                minimum: 1,
                maximum: 10,
              },
              estimatedComplexity: {
                type: 'string',
                description: 'Estimated complexity for resource allocation',
                enum: ['low', 'medium', 'high'],
              },
            },
          },
        },
      },
    },
  };
}
