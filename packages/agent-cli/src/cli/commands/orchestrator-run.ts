/**
 * CLI Command: orchestrator:run
 *
 * Execute a complex task via orchestrator with specialist delegation
 */

import { defineCommand, type CommandResult } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';
import { OrchestratorExecutor } from '@kb-labs/agent-core';
import type { OrchestratorResult } from '@kb-labs/agent-core';

interface OrchestratorRunInput {
  flags: {
    task: string;
    json?: boolean;
  };
}

interface OrchestratorRunOutput {
  success: boolean;
  result?: OrchestratorResult;
  error?: string;
}

export default defineCommand<unknown, OrchestratorRunInput, OrchestratorRunOutput>({
  id: 'orchestrator:run',
  description: 'Execute a task via orchestrator with specialist delegation',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: OrchestratorRunInput
    ): Promise<CommandResult<OrchestratorRunOutput>> {
      const { task, json: jsonOutput } = input.flags;

      try {
        // Create orchestrator executor
        const executor = new OrchestratorExecutor(ctx);

        // Execute task
        const result = await executor.execute(task);

        // Output results
        if (jsonOutput) {
          // JSON output for programmatic use
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Human-readable output
          console.log('\n┌── Orchestrator Run');
          console.log('│');

          // Show execution plan
          console.log('│ Execution Plan');
          console.log(`│  Subtasks: ${result.plan.length}`);
          for (const subtask of result.plan) {
            console.log(`│  - [${subtask.id}] ${subtask.description}`);
            console.log(`│    → Assigned to: ${subtask.specialistId}`);
            if (subtask.dependencies && subtask.dependencies.length > 0) {
              console.log(`│    → Depends on: ${subtask.dependencies.join(', ')}`);
            }
            console.log(`│    → Priority: ${subtask.priority || 5}/10`);
          }
          console.log('│');

          // Show specialist results
          console.log('│ Specialist Results');
          for (const delegatedResult of result.delegatedResults) {
            const subtask = result.plan.find((s) => s.id === delegatedResult.subtaskId);
            const status = delegatedResult.success ? '✅' : '❌';

            console.log(`│  ${status} [${delegatedResult.subtaskId}] ${subtask?.description || '(unknown)'}`);
            console.log(`│    → Specialist: ${delegatedResult.specialistId}`);
            console.log(`│    → Tokens: ${delegatedResult.tokensUsed}`);
            console.log(`│    → Duration: ${delegatedResult.durationMs}ms`);

            if (delegatedResult.error) {
              console.log(`│    → Error: ${delegatedResult.error}`);
            }
          }
          console.log('│');

          // Show final answer
          console.log('│ Final Answer');
          const answerLines = result.answer.split('\n');
          for (const line of answerLines) {
            console.log(`│  ${line}`);
          }
          console.log('│');

          // Show statistics
          console.log('│ Statistics');
          console.log(`│  Total Tokens: ${result.tokensUsed}`);
          console.log(`│  Total Duration: ${result.durationMs}ms (${(result.durationMs / 1000).toFixed(1)}s)`);
          const successRate = result.delegatedResults.length > 0
            ? (result.delegatedResults.filter((r) => r.success).length / result.delegatedResults.length * 100).toFixed(0)
            : 0;
          console.log(`│  Success Rate: ${successRate}%`);
          console.log('│');

          if (result.success) {
            console.log('└── Success / ' + (result.durationMs / 1000).toFixed(1) + 's\n');
          } else {
            console.log('└── Failed / ' + (result.durationMs / 1000).toFixed(1) + 's\n');
            if (result.error) {
              console.error('Error:', result.error);
            }
          }
        }

        return {
          exitCode: result.success ? 0 : 1,
          result: {
            success: result.success,
            result,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (jsonOutput) {
          console.error(JSON.stringify({ error: errorMessage }, null, 2));
        } else {
          console.error('\n❌ Orchestrator execution failed');
          console.error('Error:', errorMessage);
        }

        ctx.platform.logger.error('Orchestrator command failed', new Error(errorMessage));

        return { exitCode: 1, result: { success: false, error: errorMessage } };
      }
    },
  },
});
