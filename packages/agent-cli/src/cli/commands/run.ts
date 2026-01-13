/**
 * Agent Run Command
 *
 * Execute an agent with a task
 */

import { defineCommand, TimingTracker, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
import { AgentRegistry, AgentExecutor, ToolDiscoverer } from '@kb-labs/agent-core';
import type { AgentProgressCallback } from '@kb-labs/agent-contracts';

interface RunFlags {
  agentId: string;
  task: string;
  json?: boolean;
}

interface RunInput {
  argv: string[];
  flags: RunFlags;
}

interface RunResult {
  success: boolean;
  result?: string;
  error?: {
    code?: string;
    message: string;
  };
  steps?: number;
  totalTokens?: number;
  durationMs?: number;
}

/**
 * Execute an agent task
 */
export default defineCommand<unknown, RunInput, RunResult>({
  id: 'agent:run',
  description: 'Execute an agent with a task',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: RunInput
    ): Promise<CommandResult<RunResult>> {
      const tracker = new TimingTracker();
      const { agentId, task } = input.flags;

      if (!agentId) {
        ctx.ui.error('Missing required flag: --agent-id', {
          title: 'Agent Run',
        });
        return {
          exitCode: 1,
          result: {
            success: false,
            error: {
              code: 'MISSING_AGENT_ID',
              message: 'Agent ID is required',
            },
          },
        };
      }

      if (!task) {
        ctx.ui.error('Missing required flag: --task', {
          title: 'Agent Run',
        });
        return {
          exitCode: 1,
          result: {
            success: false,
            error: {
              code: 'MISSING_TASK',
              message: 'Task is required',
            },
          },
        };
      }

      try {
        // Discover and load agent
        tracker.checkpoint('init');
        const registry = new AgentRegistry(ctx);

        // Check if agent exists
        const agents = await registry.discover();
        const agentMeta = agents.find((a) => a.id === agentId);

        if (!agentMeta || !agentMeta.valid) {
          ctx.ui.error(`Agent not found or invalid: ${agentId}`, {
            title: 'Agent Run',
            sections: [
              {
                header: 'Available Agents',
                items: agents.filter(a => a.valid).map((a) => `  - ${a.id} (${a.name})`),
              },
            ],
          });

          return {
            exitCode: 1,
            result: {
              success: false,
              error: {
                code: 'AGENT_NOT_FOUND',
                message: `Agent not found: ${agentId}`,
              },
            },
          };
        }

        // Load full agent configuration and context
        const config = await registry.loadConfig(agentId);
        const agentContext = await registry.loadContext(agentId, config);

        tracker.checkpoint('discovery');

        // Discover tools
        const toolDiscoverer = new ToolDiscoverer(ctx);
        const tools = await toolDiscoverer.discover(config.tools || {});

        // Add tools to context
        const fullContext = { ...agentContext, tools };

        tracker.checkpoint('tools');

        // Execute agent
        ctx.ui.info(`Running agent: ${config.name}`, {
          title: 'Agent Run',
          sections: [
            {
              header: 'Configuration',
              items: [
                `Agent: ${config.name} (${config.id})`,
                `Task: ${task}`,
                `Tools: ${tools.length} available`,
                `Max steps: ${config.llm.maxToolCalls || 20}`,
              ],
            },
          ],
        });

        // Create progress callback for interactive display
        let currentStep = 0;
        let totalTokens = 0;
        const startTime = Date.now();

        // Format timestamp (HH:MM:SS)
        const getTimestamp = () => {
          const elapsed = Date.now() - startTime;
          const seconds = Math.floor(elapsed / 1000);
          const minutes = Math.floor(seconds / 60);
          const hours = Math.floor(minutes / 60);
          const displaySeconds = seconds % 60;
          const displayMinutes = minutes % 60;

          if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${displayMinutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
          }
          return `${displayMinutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
        };

        const progressCallback: AgentProgressCallback = {
          onStepStart: (step, maxSteps) => {
            currentStep = step;
            ctx.ui.write(
              `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.info(`Step ${step}/${maxSteps}`)}`
            );
          },

          onLLMStart: (step) => {
            ctx.ui.write(
              `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.dim('⏳ Calling LLM...')}`
            );
          },

          onLLMComplete: (step, tokens, content) => {
            totalTokens += tokens;
            ctx.ui.write(
              `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.dim(`${ctx.ui.symbols.success} LLM response`)} ${ctx.ui.colors.muted(`(${tokens} tokens)`)}`
            );
          },

          onToolStart: (tool, input, step) => {
            // Format tool input for display
            let displayInput = '';

            // Special handling for file operations - make paths clickable
            if (tool === 'fs:read' && typeof input === 'object' && input && 'path' in input) {
              const path = (input as { path: string }).path;
              displayInput = ctx.ui.colors.primary(path);
            } else if (tool === 'fs:write' && typeof input === 'object' && input && 'path' in input) {
              const path = (input as { path: string }).path;
              displayInput = ctx.ui.colors.primary(path);
            } else if (tool === 'fs:edit' && typeof input === 'object' && input && 'path' in input) {
              const path = (input as { path: string }).path;
              displayInput = ctx.ui.colors.primary(path);
            } else if (tool === 'mind:rag-query' && typeof input === 'object' && input && 'text' in input) {
              const query = (input as { text: string }).text;
              displayInput = ctx.ui.colors.dim(`"${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);
            } else {
              displayInput = ctx.ui.colors.dim(JSON.stringify(input).substring(0, 50));
            }

            ctx.ui.write(
              `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.accent('🔧')} ${ctx.ui.colors.bold(tool)} ${displayInput}`
            );
          },

          onToolComplete: (tool, success, output, error, durationMs) => {
            if (success) {
              ctx.ui.write(
                `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.success(ctx.ui.symbols.success)} ${ctx.ui.colors.bold(tool)} ${ctx.ui.colors.muted(`(${durationMs}ms)`)}`
              );
            } else {
              ctx.ui.write(
                `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.error(ctx.ui.symbols.error)} ${ctx.ui.colors.bold(tool)} ${ctx.ui.colors.error(error || 'Unknown error')}`
              );
            }
          },

          onStepComplete: (step, tokens, toolCallCount) => {
            ctx.ui.write(
              `${ctx.ui.colors.dim(getTimestamp())} ${ctx.ui.colors.dim(`Step ${step} complete`)} ${ctx.ui.colors.muted(`(${toolCallCount} tools, ${tokens} tokens total)`)}`
            );
            ctx.ui.write(''); // Empty line after step
          },
        };

        const executor = new AgentExecutor(ctx);
        const result = await executor.execute(fullContext, task, progressCallback);

        tracker.checkpoint('execution');

        // Format result
        const output: RunResult = {
          success: result.success,
          result: result.result,
          error: result.error,
          steps: result.steps?.length,
          totalTokens: result.totalTokens,
          durationMs: result.durationMs,
        };

        if (input.flags.json) {
          ctx.ui.json(output);
        } else {
          if (result.success) {
            const sections = [
              {
                header: 'Result',
                items: [result.result || '(no output)'],
              },
              {
                header: 'Statistics',
                items: [
                  `Steps: ${output.steps || 0}`,
                  `Tokens: ${output.totalTokens || 0}`,
                  `Duration: ${output.durationMs || 0}ms`,
                ],
              },
            ];

            ctx.ui.success('Agent execution completed', {
              title: 'Agent Run',
              sections,
              timing: tracker.total(),
            });
          } else {
            ctx.ui.error(result.error?.message || 'Unknown error', {
              title: 'Agent Run Failed',
              sections: [
                {
                  header: 'Error',
                  items: [
                    `Code: ${result.error?.code || 'UNKNOWN'}`,
                    `Message: ${result.error?.message || 'Unknown error'}`,
                  ],
                },
                {
                  header: 'Statistics',
                  items: [
                    `Steps completed: ${output.steps || 0}`,
                    `Tokens used: ${output.totalTokens || 0}`,
                    `Duration: ${output.durationMs || 0}ms`,
                  ],
                },
              ],
            });
          }
        }

        return {
          exitCode: result.success ? 0 : 1,
          result: output,
          meta: {
            timing: tracker.breakdown(),
          },
        };
      } catch (error) {
        ctx.ui.error(error instanceof Error ? error.message : String(error), {
          title: 'Agent Run Failed',
        });

        return {
          exitCode: 1,
          result: {
            success: false,
            error: {
              code: 'EXECUTION_ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    },
  },
});
