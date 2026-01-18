/**
 * Specialist Run Command (V2 Architecture)
 *
 * Execute tasks using a specific specialist (researcher, implementer, etc.)
 */

import { defineCommand, TimingTracker, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
import { SpecialistRegistry, SpecialistExecutor, type SpecialistResult } from '@kb-labs/agent-core';
import { ToolDiscoverer } from '@kb-labs/agent-core';

interface SpecialistRunFlags {
  specialistId: string;
  task: string;
  json?: boolean;
}

interface SpecialistRunInput {
  argv: string[];
  flags: SpecialistRunFlags;
}

interface SpecialistRunOutput {
  success: boolean;
  output?: unknown;
  error?: string;
  steps: number;
  tokensUsed: number;
  durationMs: number;
}

/**
 * Execute a task using a specialist
 */
export default defineCommand<unknown, SpecialistRunInput, SpecialistRunOutput>({
  id: 'specialist:run',
  description: 'Execute a task using a specialist',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: SpecialistRunInput
    ): Promise<CommandResult<SpecialistRunOutput>> {
      const tracker = new TimingTracker();
      const { specialistId, task, json: jsonOutput } = input.flags;

      if (!specialistId) {
        ctx.ui.error('Missing required flag: --specialistId', {
          title: 'Specialist Run',
        });
        return {
          exitCode: 1,
          result: {
            success: false,
            error: 'Specialist ID is required',
            steps: 0,
            tokensUsed: 0,
            durationMs: 0,
          },
        };
      }

      if (!task) {
        ctx.ui.error('Missing required flag: --task', {
          title: 'Specialist Run',
        });
        return {
          exitCode: 1,
          result: {
            success: false,
            error: 'Task is required',
            steps: 0,
            tokensUsed: 0,
            durationMs: 0,
          },
        };
      }

      try {
        tracker.checkpoint('init');

        // Load specialist configuration
        const registry = new SpecialistRegistry(ctx);
        const config = await registry.load(specialistId);

        tracker.checkpoint('load');

        // Show startup info
        if (!jsonOutput) {
          ctx.ui.info('Starting Specialist Execution', {
            title: 'Specialist Run',
            sections: [
              {
                header: 'Specialist',
                items: [
                  `ID: ${config.id}`,
                  `Name: ${config.name}`,
                  `Description: ${config.description}`,
                  `LLM Tier: ${config.llm.tier}`,
                ],
              },
              {
                header: 'Limits',
                items: [
                  `Max steps: ${config.limits.maxSteps}`,
                  `Max tool calls: ${config.limits.maxToolCalls}`,
                  `Forced reasoning interval: ${config.limits.forcedReasoningInterval ?? 3}`,
                ],
              },
              {
                header: 'Task',
                items: [task],
              },
            ],
          });
        }

        // Discover available tools based on specialist config
        const toolDiscoverer = new ToolDiscoverer(ctx);
        const tools = await toolDiscoverer.discover(config.tools);

        tracker.checkpoint('tools');

        // Create specialist executor
        const executor = new SpecialistExecutor(ctx);

        // Execute
        const result: SpecialistResult = await executor.execute(
          { config, tools },
          task,
          undefined, // No input data for MVP
          {
            onStepStart: (step, maxSteps) => {
              if (!jsonOutput) {
                ctx.ui.write(
                  ctx.ui.colors.dim(`Step ${step}/${maxSteps}...`)
                );
              }
            },
          }
        );

        tracker.checkpoint('execution');

        // Format output
        const output: SpecialistRunOutput = {
          success: result.success,
          output: result.output,
          error: result.error,
          steps: result.steps.length,
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
        };

        if (jsonOutput) {
          ctx.ui.json(output);
        } else {
          if (result.success) {
            ctx.ui.success('Specialist task completed', {
              title: 'Specialist Run',
              sections: [
                {
                  header: 'Output',
                  items: [JSON.stringify(result.output, null, 2)],
                },
                {
                  header: 'Statistics',
                  items: [
                    `Steps: ${output.steps}`,
                    `Tokens: ${output.tokensUsed}`,
                    `Duration: ${output.durationMs}ms`,
                  ],
                },
              ],
              timing: tracker.total(),
            });
          } else {
            ctx.ui.error(result.error || 'Unknown error', {
              title: 'Specialist Failed',
              sections: [
                {
                  header: 'Details',
                  items: [
                    `Specialist: ${specialistId}`,
                    `Steps: ${output.steps}`,
                    `Duration: ${output.durationMs}ms`,
                  ],
                },
              ],
            });
          }
        }

        return {
          exitCode: result.success ? 0 : 1,
          result: output,
          meta: { timing: tracker.breakdown() },
        };
      } catch (error) {
        ctx.ui.error(error instanceof Error ? error.message : String(error), {
          title: 'Specialist Execution Failed',
        });

        return {
          exitCode: 1,
          result: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            steps: 0,
            tokensUsed: 0,
            durationMs: 0,
          },
        };
      }
    },
  },
});
