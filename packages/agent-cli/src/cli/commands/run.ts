/**
 * Agent Run Command
 *
 * Execute an agent with a task
 */

import { defineCommand, TimingTracker, type PluginContextV3, type CommandResult, useLogger } from '@kb-labs/sdk';
import { AgentRegistry, AgentExecutor, ToolDiscoverer } from '@kb-labs/agent-core';
import type { AgentProgressCallback } from '@kb-labs/agent-contracts';
import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
import type { ProgressEvent } from '@kb-labs/progress-reporter';

interface RunFlags {
  agentId: string;
  task: string;
  json?: boolean;
  adaptive?: boolean;
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
 * Execute task using AdaptiveOrchestrator (cost-optimized multi-tier approach)
 */
async function executeWithAdaptiveOrchestration(
  ctx: PluginContextV3<unknown>,
  task: string,
  tracker: TimingTracker,
  jsonOutput?: boolean
): Promise<CommandResult<RunResult>> {
  const startTime = Date.now();

  ctx.ui.info(`Running with Adaptive Orchestration`, {
    title: 'Agent Run',
    sections: [
      {
        header: 'Mode',
        items: [
          'Adaptive Orchestration (cost-optimized)',
          'Task will be classified and broken into subtasks',
          'Each subtask uses appropriate tier (small/medium/large)',
        ],
      },
      {
        header: 'Task',
        items: [task],
      },
    ],
  });

  // Create progress callback for UI updates
  const progressCallback = (event: ProgressEvent) => {
    const getTimestamp = () => {
      const elapsed = Date.now() - startTime;
      const seconds = Math.floor(elapsed / 1000);
      const minutes = Math.floor(seconds / 60);
      const displaySeconds = seconds % 60;
      const displayMinutes = minutes % 60;
      return `${displayMinutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
    };

    const timestamp = ctx.ui.colors.dim(getTimestamp());

    switch (event.type) {
      case 'task_started':
        ctx.ui.write(`${timestamp} ${ctx.ui.colors.accent('🎯')} Task started: ${event.data.taskDescription}`);
        break;

      case 'task_classified':
        const tierEmoji = event.data.tier === 'small' ? '🟢' : event.data.tier === 'medium' ? '🟡' : '🔴';
        ctx.ui.write(
          `${timestamp} ${tierEmoji} Classified as '${event.data.tier}' tier (${event.data.confidence} confidence, ${event.data.method})`
        );
        break;

      case 'planning_started':
        ctx.ui.write(`${timestamp} ${ctx.ui.colors.dim('📋 Planning subtasks...')}`);
        break;

      case 'planning_completed':
        ctx.ui.write(
          `${timestamp} ${ctx.ui.colors.success(ctx.ui.symbols.success)} Plan created: ${event.data.subtaskCount} subtasks`
        );
        ctx.ui.write(''); // Empty line
        break;

      case 'subtask_started':
        const subtaskEmoji = event.data.tier === 'small' ? '🟢' : event.data.tier === 'medium' ? '🟡' : '🔴';
        const agentLabelStart = event.data.agentId ? ctx.ui.colors.accent(` [Agent: ${event.data.agentId}]`) : '';
        ctx.ui.write(
          `${timestamp} ${subtaskEmoji} [${event.data.subtaskId}]${agentLabelStart} Starting: ${event.data.description}`
        );
        break;

      case 'subtask_completed':
        const agentLabelCompleted = event.data.agentId ? ctx.ui.colors.accent(` [Agent: ${event.data.agentId}]`) : '';
        ctx.ui.write(
          `${timestamp} ${ctx.ui.colors.success(ctx.ui.symbols.success)} [${event.data.subtaskId}]${agentLabelCompleted} Completed: ${event.data.description}`
        );
        break;

      case 'tier_escalated':
        ctx.ui.write(
          `${timestamp} ${ctx.ui.colors.warning('⬆️')} [${event.data.subtaskId}] Escalated from ${event.data.fromTier} → ${event.data.toTier}`
        );
        ctx.ui.write(`${timestamp} ${ctx.ui.colors.dim(`   Reason: ${event.data.reason}`)}`);
        break;

      case 'task_completed':
        ctx.ui.write(''); // Empty line
        const totalDurationMs = event.data.totalDuration || 0;
        ctx.ui.write(
          `${timestamp} ${ctx.ui.colors.success(ctx.ui.symbols.success)} Task ${event.data.status} in ${(totalDurationMs / 1000).toFixed(1)}s`
        );
        if (event.data.costBreakdown) {
          ctx.ui.write(`${timestamp} ${ctx.ui.colors.accent('💰')} Cost: ${event.data.costBreakdown.total}`);
          ctx.ui.write(
            `${timestamp}    🟢 Small:  ${event.data.costBreakdown.small} | 🟡 Medium: ${event.data.costBreakdown.medium} | 🔴 Large:  ${event.data.costBreakdown.large}`
          );
        }
        break;
    }
  };

  try {
    const logger = useLogger();
    const orchestrator = new AdaptiveOrchestrator(ctx, logger, progressCallback);
    const result = await orchestrator.execute(task);

    tracker.checkpoint('execution');

    const output: RunResult = {
      success: result.status === 'success',
      result: result.result,
      steps: result.subtaskResults?.length || 0,
      durationMs: Date.now() - startTime,
    };

    if (jsonOutput) {
      ctx.ui.json({
        ...output,
        costBreakdown: result.costBreakdown,
        subtaskResults: result.subtaskResults,
      });
    } else {
      if (result.status === 'success') {
        const sections = [
          {
            header: 'Result',
            items: [result.result || '(no output)'],
          },
          {
            header: 'Statistics',
            items: [
              `Subtasks: ${output.steps}`,
              `Duration: ${output.durationMs}ms`,
            ],
          },
          {
            header: 'Cost Breakdown',
            items: [
              `Total: ${result.costBreakdown.total}`,
              `🟢 Small:  ${result.costBreakdown.small}`,
              `🟡 Medium: ${result.costBreakdown.medium}`,
              `🔴 Large:  ${result.costBreakdown.large}`,
            ],
          },
        ];

        ctx.ui.success('Adaptive orchestration completed', {
          title: 'Agent Run',
          sections,
          timing: tracker.total(),
        });
      } else {
        ctx.ui.error('Orchestration failed', {
          title: 'Agent Run Failed',
          sections: [
            {
              header: 'Error',
              items: [result.result || 'Unknown error'],
            },
          ],
        });
      }
    }

    return {
      exitCode: result.status === 'success' ? 0 : 1,
      result: output,
      meta: {
        timing: tracker.breakdown(),
      },
    };
  } catch (error) {
    ctx.ui.error(error instanceof Error ? error.message : String(error), {
      title: 'Adaptive Orchestration Failed',
    });

    return {
      exitCode: 1,
      result: {
        success: false,
        error: {
          code: 'ORCHESTRATION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
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
      // DEBUG: Check permissions received
      console.log('[agent:run DEBUG] Context check:', {
        hasApi: !!ctx.api,
        hasInvoke: !!ctx.api?.invoke,
        apiInvokeType: typeof ctx.api?.invoke?.call,
      });

      // Try to call invoke to see what error we get
      try {
        await ctx.api.invoke.call('mind', { command: 'rag-query', query: 'test' });
      } catch (err) {
        console.log('[agent:run DEBUG] Invoke test failed:', err instanceof Error ? err.message : String(err));
      }

      const tracker = new TimingTracker();
      const { agentId, task, adaptive } = input.flags;

      // agentId is only required for standard (non-adaptive) mode
      if (!agentId && !adaptive) {
        ctx.ui.error('Missing required flag: --agent-id', {
          title: 'Agent Run',
        });
        return {
          exitCode: 1,
          result: {
            success: false,
            error: {
              code: 'MISSING_AGENT_ID',
              message: 'Agent ID is required (or use --adaptive for automatic agent selection)',
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
        tracker.checkpoint('init');

        // Check if adaptive orchestration is enabled
        if (input.flags.adaptive) {
          // Use AdaptiveOrchestrator for cost-optimized execution
          // No need to validate specific agent - orchestrator will select agents automatically
          return await executeWithAdaptiveOrchestration(ctx, task, tracker, input.flags.json);
        }

        // Standard agent execution - validate agent exists
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

        // Execute agent (standard mode)
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
            // Build sections array
            const errorSections: Array<{ header: string; items: string[] }> = [
              {
                header: 'Error',
                items: [
                  `Code: ${result.error?.code || 'UNKNOWN'}`,
                  `Message: ${result.error?.message || 'Unknown error'}`,
                ],
              },
            ];

            // Add summary/result section if available (e.g., for NEED_ESCALATION)
            if (result.result) {
              errorSections.push({
                header: 'Summary',
                items: [result.result],
              });
            }

            // Add statistics
            errorSections.push({
              header: 'Statistics',
              items: [
                `Steps completed: ${output.steps || 0}`,
                `Tokens used: ${output.totalTokens || 0}`,
                `Duration: ${output.durationMs || 0}ms`,
              ],
            });

            ctx.ui.error(result.error?.message || 'Unknown error', {
              title: 'Agent Run Failed',
              sections: errorSections,
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
