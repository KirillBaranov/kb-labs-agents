/**
 * agent:run command - unified agent interface
 *
 * Uses event-driven UI rendering instead of simple loaders.
 */

import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import {
  Agent,
  IncrementalTraceWriter,
  TraceSaverProcessor,
  MetricsCollectorProcessor,
  FileMemory,
} from '@kb-labs/agent-core';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { AgentConfig, ModeConfig, AgentMode, AgentEvent } from '@kb-labs/agent-contracts';
import { createEventRenderer, createMinimalRenderer, createDetailedRenderer } from '../ui/index.js';

type RunInput = {
  task: string;
  workingDir?: string;
  maxIterations?: number;
  temperature?: number;
  verbose?: boolean;
  quiet?: boolean;
  detailed?: boolean;
  sessionId?: string;
  tier?: 'small' | 'medium' | 'large';
  escalate?: boolean;
  mode?: AgentMode;
  complexity?: 'simple' | 'medium' | 'complex';
  files?: string[];
  trace?: string;
  'dry-run'?: boolean;
  argv?: string[];
};

type RunResult = {
  exitCode: number;
  result?: {
    success: boolean;
    summary: string;
    filesCreated: string[];
    filesModified: string[];
    filesRead: string[];
    iterations: number;
    tokensUsed: number;
  };
};

export default defineCommand({
  id: 'agent:run',
  description: 'Execute a task with autonomous agent (orchestrator + child agents)',

  handler: {
    async execute(ctx: PluginContextV3, input: RunInput): Promise<RunResult> {
      // V3: Flags come in input.flags object (not auto-merged)
      const flags = (input as any).flags ?? input;

      const {
        task,
        workingDir = ctx.cwd || process.cwd(),
        maxIterations = 25,
        temperature = 0.1,
        verbose = true,
        quiet = false,
        detailed = false,
        sessionId,
        tier = 'small',
        escalate = false,
        mode = 'execute',
        complexity,
        files,
        trace,
        'dry-run': dryRun = false,
      } = flags;

      if (!task) {
        ctx.ui?.error?.('Error: --task is required');
        return { exitCode: 1 };
      }

      // Build mode config
      let modeConfig: ModeConfig | undefined;
      if (mode !== 'execute') {
        modeConfig = { mode } as ModeConfig;

        // Add mode-specific context
        if (mode === 'plan') {
          modeConfig.context = { mode: 'plan', task, complexity };
        } else if (mode === 'edit') {
          modeConfig.context = { mode: 'edit', task, targetFiles: files || [], dryRun };
        } else if (mode === 'debug') {
          modeConfig.context = { mode: 'debug', task, traceFile: trace, relevantFiles: files || [] };
        }
      }

      // Select event renderer based on verbosity flags
      let eventRenderer;
      if (quiet) {
        eventRenderer = createMinimalRenderer();
      } else if (detailed) {
        eventRenderer = createDetailedRenderer();
      } else {
        eventRenderer = createEventRenderer({
          verbose,
          showToolOutput: true,
          showLLMContent: false,
        });
      }

      try {
        // Create shared file tracking (for edit protection)
        const filesRead = new Set<string>();
        const filesReadHash = new Map<string, string>();

        // Create tool registry
        const toolRegistry = createToolRegistry({
          workingDir,
          sessionId,
          verbose: false, // Disable tool registry verbose - we have event renderer
          filesRead,
          filesReadHash,
        });

        // Create tracer (incremental NDJSON tracer)
        const taskId = `task-${Date.now()}`;
        const tracer = new IncrementalTraceWriter(taskId);

        // Create memory system
        const memory = new FileMemory({
          workingDir,
          sessionId,
          maxShortTermMemories: 50,
          maxContextTokens: 4000,
        });

        // Create result processors
        const resultProcessors = [
          new TraceSaverProcessor(workingDir),
          new MetricsCollectorProcessor(),
        ];

        // Create composite event callback that writes to tracer AND renders UI
        const compositeEventCallback = (event: AgentEvent) => {
          // Write to tracer
          tracer.trace(event);
          // Render UI
          eventRenderer(event);
        };

        // Create agent config with event callback
        const config: AgentConfig = {
          workingDir,
          maxIterations,
          temperature,
          verbose: false, // Disable internal verbose logging - we use events now
          sessionId,
          tier,
          enableEscalation: escalate,
          tracer,
          resultProcessors,
          memory,
          mode: modeConfig,
          onEvent: compositeEventCallback, // Composite: tracer + UI rendering
        };

        // Create and execute agent
        const agent = new Agent(config, toolRegistry);
        const result = await agent.execute(task);

        // Event renderer already showed the result via agent:end event
        // Just return the structured result

        return {
          exitCode: result.success ? 0 : 1,
          result: {
            success: result.success,
            summary: result.summary,
            filesCreated: result.filesCreated,
            filesModified: result.filesModified,
            filesRead: result.filesRead,
            iterations: result.iterations,
            tokensUsed: result.tokensUsed,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ Agent execution failed: ${errorMessage}\n`);
        return { exitCode: 1 };
      }
    },
  },
});
