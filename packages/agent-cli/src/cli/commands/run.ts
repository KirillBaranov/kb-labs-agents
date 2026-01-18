/**
 * Agent Run Command
 *
 * Execute tasks using Iterative Orchestrator (smart boss + cheap workers)
 */

import { defineCommand, TimingTracker, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
import { IterativeOrchestrator, type OrchestratorCallbacks } from '@kb-labs/iterative-orchestrator';

interface RunFlags {
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
  iterations?: number;
  agentCalls?: number;
  totalTokens?: number;
  durationMs?: number;
  estimatedCost?: number;
}

/**
 * Execute an agent task
 */
export default defineCommand<unknown, RunInput, RunResult>({
  id: 'agent:run',
  description: 'Execute a task using iterative orchestration',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: RunInput
    ): Promise<CommandResult<RunResult>> {
      const tracker = new TimingTracker();
      const { task, json: jsonOutput } = input.flags;

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

      const startTime = Date.now();

      // Show startup info
      ctx.ui.info('Starting Iterative Orchestration', {
        title: 'Agent Run',
        sections: [
          {
            header: 'Mode',
            items: [
              'Smart orchestrator (thinks & delegates)',
              'Cheap worker agents (execute tools)',
              'Early stopping when confident',
            ],
          },
          {
            header: 'Task',
            items: [task],
          },
        ],
      });

      // Format timestamp
      const getTimestamp = () => {
        const elapsed = Date.now() - startTime;
        const seconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(seconds / 60);
        const displaySeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
      };

      // Progress callbacks for UI
      const callbacks: OrchestratorCallbacks = {
        onIteration: (iteration, decision) => {
          const timestamp = ctx.ui.colors.dim(getTimestamp());
          const decisionEmoji = {
            COMPLETE: '✅',
            DELEGATE: '📤',
            DELEGATE_PARALLEL: '📤📤',
            ESCALATE: '🙋',
            ABORT: '❌',
          }[decision.type];

          ctx.ui.write(
            `${timestamp} ${ctx.ui.colors.info(`Iteration ${iteration}`)} ${decisionEmoji} ${decision.type}`
          );
        },

        onAgentStart: (agentId, agentTask) => {
          const timestamp = ctx.ui.colors.dim(getTimestamp());
          ctx.ui.write(
            `${timestamp} ${ctx.ui.colors.accent('🤖')} Agent ${ctx.ui.colors.bold(agentId)}: ${agentTask.slice(0, 60)}${agentTask.length > 60 ? '...' : ''}`
          );
        },

        onAgentComplete: (result) => {
          const timestamp = ctx.ui.colors.dim(getTimestamp());
          const status = result.success
            ? ctx.ui.colors.success(ctx.ui.symbols.success)
            : ctx.ui.colors.error(ctx.ui.symbols.error);
          ctx.ui.write(
            `${timestamp} ${status} Agent ${result.agentId} ${ctx.ui.colors.muted(`(${result.durationMs}ms)`)}`
          );
        },

        onEscalate: async (reason, question) => {
          ctx.ui.write('');
          ctx.ui.warn('Orchestrator needs your input', {
            title: 'Escalation',
            sections: [
              { header: 'Reason', items: [reason] },
              { header: 'Question', items: [question] },
            ],
          });
          // TODO: Interactive input
          return undefined;
        },
      };

      try {
        tracker.checkpoint('init');

        // Create orchestrator and register default agents
        const orchestrator = new IterativeOrchestrator(ctx, {}, callbacks);

        // Register available agents
        // TODO: Load from agent registry
        orchestrator.registerAgent({
          id: 'mind-specialist',
          name: 'Mind Specialist',
          description: 'Searches codebase using Mind RAG for semantic understanding',
          tools: ['mind:rag-query', 'mind:rag-index'],
        });

        orchestrator.registerAgent({
          id: 'file-specialist',
          name: 'File Specialist',
          description: 'Reads and analyzes files in the codebase',
          tools: ['fs:read', 'fs:list', 'fs:search'],
        });

        orchestrator.registerAgent({
          id: 'code-writer',
          name: 'Code Writer',
          description: 'Writes and edits code files',
          tools: ['fs:read', 'fs:write', 'fs:edit'],
        });

        tracker.checkpoint('setup');

        // Execute
        const result = await orchestrator.execute(task);

        tracker.checkpoint('execution');

        // Format output
        const output: RunResult = {
          success: result.success,
          result: result.answer,
          iterations: result.stats.iterations,
          agentCalls: result.stats.agentCalls,
          totalTokens: result.stats.totalTokens,
          durationMs: result.stats.durationMs,
          estimatedCost: result.stats.estimatedCost,
        };

        if (result.escalation) {
          output.error = {
            code: 'ESCALATION_REQUIRED',
            message: result.escalation.question,
          };
        }

        if (result.abort) {
          output.error = {
            code: 'ABORTED',
            message: result.abort.reason,
          };
        }

        if (jsonOutput) {
          ctx.ui.json(output);
        } else {
          if (result.success) {
            ctx.ui.success('Task completed', {
              title: 'Agent Run',
              sections: [
                {
                  header: 'Result',
                  items: [result.answer || '(no output)'],
                },
                {
                  header: 'Statistics',
                  items: [
                    `Iterations: ${output.iterations}`,
                    `Agent calls: ${output.agentCalls}`,
                    `Tokens: ${output.totalTokens}`,
                    `Duration: ${output.durationMs}ms`,
                    `Est. cost: $${output.estimatedCost?.toFixed(4)}`,
                  ],
                },
              ],
              timing: tracker.total(),
            });
          } else if (result.escalation) {
            ctx.ui.warn('Task needs your input', {
              title: 'Escalation Required',
              sections: [
                { header: 'Reason', items: [result.escalation.reason] },
                { header: 'Question', items: [result.escalation.question] },
                ...(result.escalation.options
                  ? [{ header: 'Options', items: result.escalation.options }]
                  : []),
              ],
            });
          } else {
            ctx.ui.error(result.abort?.reason || 'Unknown error', {
              title: 'Task Failed',
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
          title: 'Orchestration Failed',
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
