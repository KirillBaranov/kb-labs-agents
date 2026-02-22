/**
 * agent:run command - unified agent interface
 *
 * Uses event-driven UI rendering instead of simple loaders.
 */

import { defineCommand, useCache, useConfig, type PluginContextV3 } from '@kb-labs/sdk';
import {
  Agent,
  TraceSaverProcessor,
  MetricsCollectorProcessor,
  FileMemory,
  SessionManager,
  PlanDocumentService,
  SpecModeHandler,
} from '@kb-labs/agent-core';
import { IncrementalTraceWriter } from '@kb-labs/agent-tracing';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { AgentConfig, ModeConfig, AgentMode, AgentEvent, AgentsPluginConfig } from '@kb-labs/agent-contracts';
import type { TaskPlan } from '@kb-labs/agent-contracts';
import { promises as fs } from 'node:fs';
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
  approve?: boolean;
  spec?: boolean;
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

function parseBooleanFlag(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return defaultValue;
}

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
        verbose: verboseRaw = true,
        quiet: quietRaw = false,
        detailed: detailedRaw = false,
        sessionId,
        tier = 'medium',
        escalate: escalateRaw = true,
        mode = 'execute',
        complexity,
        files,
        trace,
        approve: approveRaw = false,
        spec: specRaw = false,
        'dry-run': dryRunRaw = false,
      } = flags;

      const verbose = parseBooleanFlag(verboseRaw, true);
      const quiet = parseBooleanFlag(quietRaw, false);
      const detailed = parseBooleanFlag(detailedRaw, false);
      const escalate = parseBooleanFlag(escalateRaw, true);
      const approve = parseBooleanFlag(approveRaw, false);
      const spec = parseBooleanFlag(specRaw, false);
      const dryRun = parseBooleanFlag(dryRunRaw, false);

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
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const sessionManager = new SessionManager(workingDir);
        let effectiveSessionId = sessionId as string | undefined;

        // Ensure session exists for consistent history/memory behavior in CLI path.
        if (!effectiveSessionId) {
          const createdSession = await sessionManager.createSession({
            mode,
            task,
            agentId: 'cli-agent',
          });
          effectiveSessionId = createdSession.id;
        } else {
          const existing = await sessionManager.loadSession(effectiveSessionId);
          if (!existing) {
            const createdSession = await sessionManager.createSession({
              mode,
              task,
              agentId: 'cli-agent',
              sessionId: effectiveSessionId,
            });
            effectiveSessionId = createdSession.id;
          }
        }

        // Persist user turn first so timeline ordering is deterministic.
        await sessionManager.createUserTurn(effectiveSessionId, task, runId);

        // Create shared file tracking (for edit protection)
        const filesRead = new Set<string>();
        const filesReadHash = new Map<string, string>();

        // Create tool registry
        const toolRegistry = createToolRegistry({
          workingDir,
          sessionId: effectiveSessionId,
          verbose: false, // Disable tool registry verbose - we have event renderer
          cache: useCache(),
          filesRead,
          filesReadHash,
        });
        const agentsConfig = await useConfig<AgentsPluginConfig>();
        const taskId = `task-${Date.now()}`;
        const tracer = new IncrementalTraceWriter(taskId);

        // Spec-only fast path: skip plan mode, generate spec from existing approved plan
        if (spec && effectiveSessionId && sessionId) {
          const planPath = sessionManager.getSessionPlanPath(effectiveSessionId);
          try {
            const planData = JSON.parse(await fs.readFile(planPath, 'utf-8')) as TaskPlan;
            if (planData.status === 'approved' || planData.status === 'spec_ready') {
              ctx.ui?.info?.(`Found approved plan: ${planData.id} (${planData.phases.length} phases). Generating spec directly...`);
              let pendingSessionWrite: Promise<void> = Promise.resolve();
              const specEventCallback = (event: AgentEvent) => {
                tracer.trace(event);
                eventRenderer(event);
                pendingSessionWrite = pendingSessionWrite
                  .then(async () => {
                    await sessionManager.addEvent(effectiveSessionId!, {
                      ...event,
                      sessionId: effectiveSessionId,
                      runId,
                      metadata: {
                        ...(event as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
                        sessionId: effectiveSessionId,
                        runId,
                        workingDir,
                      },
                    } as AgentEvent);
                  })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[agent:run] Failed to persist spec event: ${message}`);
                  });
              };
              const specConfig: AgentConfig = {
                workingDir,
                maxIterations: 40,
                temperature: 0.1,
                verbose: false,
                sessionId: effectiveSessionId,
                tier,
                enableEscalation: false,
                tokenBudget: agentsConfig?.tokenBudget,
                tracer,
                onEvent: specEventCallback,
              };
              const specHandler = new SpecModeHandler();
              const specResult = await specHandler.execute(planData, specConfig, toolRegistry);
              await pendingSessionWrite;
              await tracer.finalize();
              const detailedTrace = tracer.getEntries() as Array<Record<string, unknown>>;
              if (detailedTrace.length > 0) {
                await sessionManager.storeTraceArtifacts(effectiveSessionId, runId, detailedTrace);
              }
              if (specResult.success) {
                ctx.ui?.success?.(`Spec generated: ${specResult.spec?.id} (${specResult.spec?.sections.length || 0} sections, ${specResult.spec?.sections.reduce((s, sec) => s + sec.changes.length, 0) || 0} changes)`);
              } else {
                ctx.ui?.warn?.(`Spec generation failed: ${specResult.summary}`);
              }
              return {
                exitCode: specResult.success ? 0 : 1,
                result: {
                  success: specResult.success,
                  summary: specResult.summary,
                  filesCreated: specResult.filesCreated,
                  filesModified: specResult.filesModified,
                  filesRead: specResult.filesRead,
                  iterations: specResult.iterations,
                  tokensUsed: specResult.tokensUsed,
                },
              };
            }
          } catch {
            // No plan.json or unreadable — fall through to normal flow
          }
        }

        // Create memory system
        const memory = new FileMemory({
          workingDir,
          sessionId: effectiveSessionId,
          maxShortTermMemories: 50,
          maxContextTokens: 4000,
        });

        // Create result processors
        const resultProcessors = [
          new TraceSaverProcessor(workingDir),
          new MetricsCollectorProcessor(),
        ];

        // Track pending session writes so we can flush before exit
        let pendingSessionWrite: Promise<void> = Promise.resolve();
        let persistedEventCount = 0;

        // Create composite event callback that writes to tracer, renders UI, AND persists to session
        const compositeEventCallback = (event: AgentEvent) => {
          // Write to tracer
          tracer.trace(event);
          // Render UI
          eventRenderer(event);
          // Persist to session for conversation history
          pendingSessionWrite = pendingSessionWrite
            .then(async () => {
              await sessionManager.addEvent(effectiveSessionId!, {
                ...event,
                sessionId: effectiveSessionId,
                runId,
                metadata: {
                  ...(event as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
                  sessionId: effectiveSessionId,
                  runId,
                  workingDir,
                },
              } as AgentEvent);
              persistedEventCount += 1;
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[agent:run] Failed to persist event: ${message}`);
            });
        };

        // Create agent config with event callback
        const smartTiering = agentsConfig?.smartTiering;
        const config: AgentConfig = {
          workingDir,
          maxIterations,
          temperature,
          verbose: false, // Disable internal verbose logging - we use events now
          sessionId: effectiveSessionId,
          tier,
          enableEscalation: escalate,
          smartTiering,
          tokenBudget: agentsConfig?.tokenBudget,
          tracer,
          resultProcessors,
          memory,
          mode: modeConfig,
          onEvent: compositeEventCallback, // Composite: tracer + UI rendering
        };

        // Create and execute agent
        const agent = new Agent(config, toolRegistry);
        const result = await agent.execute(task);

        // Flush pending session writes (ensures agent:end is persisted before exit)
        await pendingSessionWrite;

        // Some modes can complete without emitting event stream.
        // Persist synthetic assistant turn events so history stays complete.
        if (persistedEventCount === 0 && result.summary?.trim()) {
          const now = new Date().toISOString();
          const agentId = `agent-${runId}`;
          const baseMetadata = { sessionId: effectiveSessionId, runId, workingDir };
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'agent:start',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: { task, tier, maxIterations, toolCount: 0 },
            metadata: baseMetadata,
          } as AgentEvent);
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'llm:end',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: {
              content: result.summary,
              hasToolCalls: false,
            },
            metadata: baseMetadata,
          } as AgentEvent);
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'agent:end',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: {
              success: result.success,
              summary: result.summary,
              iterations: result.iterations,
              tokensUsed: result.tokensUsed,
              filesCreated: result.filesCreated,
              filesModified: result.filesModified,
            },
            metadata: baseMetadata,
          } as AgentEvent);
        }

        const detailedTrace = tracer.getEntries() as Array<Record<string, unknown>>;
        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(effectiveSessionId, runId, detailedTrace);
        }

        // Optional: auto-approve generated plan in plan mode
        if (approve) {
          if (mode !== 'plan') {
            ctx.ui?.warn?.('--approve is currently supported only with --mode=plan');
          } else if (!result.plan) {
            ctx.ui?.warn?.('No plan produced by plan mode, nothing to approve');
          } else {
            const approvedAt = new Date().toISOString();
            const approvedPlan = {
              ...result.plan,
              status: 'approved' as const,
              approvedAt,
              approvalComment: 'Approved via CLI --approve',
              updatedAt: approvedAt,
            };

            const sessionPlanPath = sessionManager.getSessionPlanPath(effectiveSessionId);
            await fs.writeFile(sessionPlanPath, JSON.stringify(approvedPlan, null, 2), 'utf-8');

            const planDocumentService = new PlanDocumentService(workingDir);
            const planDocPath = planDocumentService.getPlanPath(result.plan);
            await planDocumentService.appendExecutionLog(
              planDocPath,
              `- ${approvedAt}: Plan approved via CLI (--approve).`
            );

            ctx.ui?.success?.(`Plan approved: ${approvedPlan.id}`);

            // Optional: generate spec after auto-approve
            if (spec && approvedPlan) {
              ctx.ui?.info?.('Generating detailed specification from approved plan...');
              const specHandler = new SpecModeHandler();
              const specResult = await specHandler.execute(approvedPlan, config, toolRegistry);

              if (specResult.success) {
                ctx.ui?.success?.(`Spec generated: ${specResult.spec?.id} (${specResult.spec?.sections.length || 0} sections)`);
              } else {
                ctx.ui?.warn?.(`Spec generation failed: ${specResult.summary}`);
              }
            }
          }
        }

        // Finalize tracer: generate index with memory stats, cleanup old traces
        await tracer.finalize();

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
