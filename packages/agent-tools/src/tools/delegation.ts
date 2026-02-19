/**
 * Delegation tools — spawn sub-agents for subtask execution
 */

import type { Tool, ToolContext } from '../types.js';

/**
 * Spawn a sub-agent to handle a subtask.
 * Sub-agents have all tools except spawn_agent (no recursion).
 * The parent agent waits for the result synchronously.
 */
export function createSpawnAgentTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'spawn_agent',
        description: 'Spawn a sub-agent to handle a subtask. The sub-agent works independently and returns its result. Use for: research ("investigate how X works"), fixes ("fix lint errors in module Y"), or isolated tasks ("run tests and fix failures"). You wait for the result.',
        parameters: {
          type: 'object' as const,
          properties: {
            task: {
              type: 'string' as const,
              description: 'Clear task description for the sub-agent. Be specific — the sub-agent has no context about your current work.',
            },
            maxIterations: {
              type: 'number' as const,
              description: 'Max iterations for the sub-agent (default: 10). Use 5 for simple lookups, 10-15 for research/fixes.',
            },
            directory: {
              type: 'string' as const,
              description: 'Working directory for the sub-agent, relative to project root (e.g. "kb-labs-agents/packages/agent-tools"). Default: same as parent.',
            },
          },
          required: ['task'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      if (!context.spawnAgent) {
        return {
          success: false,
          error: 'Sub-agent spawning not available. This agent cannot delegate tasks.',
        };
      }

      const task = input.task as string;
      const maxIterations = (input.maxIterations as number) || 10;
      const directory = input.directory as string | undefined;

      try {
        const result = await context.spawnAgent({
          task,
          maxIterations,
          workingDir: directory,
        });

        const header = result.success ? 'Sub-agent completed successfully' : 'Sub-agent failed';
        return {
          success: true,
          output: `${header} (${result.iterations} iterations, ${result.tokensUsed} tokens):\n\n${result.result}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Sub-agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
