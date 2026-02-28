/**
 * POST /run handler
 *
 * Starts a new agent run via Orchestrator
 */

import { defineHandler, useAnalytics, useCache, useConfig, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager, createCoreToolPack } from '@kb-labs/agent-core';
import { IncrementalTraceWriter } from '@kb-labs/agent-tracing';
import { AgentSDK } from '@kb-labs/agent-sdk';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { RunRequest, RunResponse, AgentsPluginConfig, FileChangeSummary } from '@kb-labs/agent-contracts';
import path from 'node:path';
import fs from 'node:fs';
import {
  AGENTS_WS_BASE_PATH,
  AGENTS_WS_CHANNELS,
  AGENT_ANALYTICS_EVENTS,
} from '@kb-labs/agent-contracts';
import { RunManager } from '../run-manager.js';

const FOLLOW_UP_SCOPE_RE = /\b(глубже|подробнее|детал|слишком поверхност|deeper|more depth|details?)\b/i;

function isLikelyFollowUpScopeTask(task: string): boolean {
  return FOLLOW_UP_SCOPE_RE.test(task);
}

function pathExists(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

function scoreRepoFromToolPath(rawPath: string, scores: Map<string, number>): void {
  const p = rawPath.replace(/\\/g, '/');

  // Explicit repo prefix: kb-labs-xxx/...
  const explicit = p.match(/(^|\/)(kb-labs-[^/]+)\//);
  if (explicit?.[2]) {
    scores.set(explicit[2], (scores.get(explicit[2]) ?? 0) + 5);
  }

  // Heuristic by package naming patterns
  if (p.startsWith('packages/')) {
    if (/packages\/agent[-/]/.test(p) || /agent-core|agent-tools|agent-cli|agent-task-runner/.test(p)) {
      scores.set('kb-labs-agents', (scores.get('kb-labs-agents') ?? 0) + 4);
    }
    if (/packages\/mind[-/]/.test(p) || /mind-engine|mind-core/.test(p)) {
      scores.set('kb-labs-mind', (scores.get('kb-labs-mind') ?? 0) + 4);
    }
  }
}

async function inferFollowUpWorkingDir(
  sessionManager: SessionManager,
  sessionId: string,
  baseWorkingDir: string,
): Promise<string | null> {
  const events = await sessionManager.getSessionEvents(sessionId);
  if (!events.length) {
    return null;
  }

  // Find the latest completed run in this session
  const completedRuns = new Set<string>();
  for (const event of events) {
    if (event.type === 'agent:end' && event.runId) {
      completedRuns.add(event.runId);
    }
  }
  const lastRunId = Array.from(completedRuns).at(-1);
  if (!lastRunId) {
    return null;
  }

  const repoScores = new Map<string, number>();
  for (const event of events) {
    if (event.runId !== lastRunId) {
      continue;
    }

    if (event.type === 'tool:start') {
      const input = (event.data?.input as Record<string, unknown> | undefined) ?? {};
      const p1 = input.path;
      const p2 = input.directory;
      if (typeof p1 === 'string') {scoreRepoFromToolPath(p1, repoScores);}
      if (typeof p2 === 'string') {scoreRepoFromToolPath(p2, repoScores);}
    }

    if (event.type === 'tool:end') {
      const metadata = (event.data?.metadata as Record<string, unknown> | undefined) ?? {};
      const p = metadata.path;
      if (typeof p === 'string') {scoreRepoFromToolPath(p, repoScores);}
    }
  }

  const ranked = Array.from(repoScores.entries()).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < 4) {
    return null;
  }

  const inferredDir = path.join(baseWorkingDir, top[0]);
  return pathExists(inferredDir) ? inferredDir : null;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<RunRequest>
  ): Promise<RunResponse> {
    const body = input.body as RunRequest | undefined;

    if (!body?.task) {
      throw new Error('Task is required');
    }

    const analytics = useAnalytics();
    const runId = RunManager.generateRunId();
    const startTime = Date.now();

    // Get or create session
    let sessionId = body.sessionId;
    let workingDir = body.workingDir || ctx.cwd;
    let sessionManager = new SessionManager(workingDir);
    if (!sessionId) {
      // Create new session
      const session = await sessionManager.createSession({
        mode: 'execute',
        task: body.task,
        agentId: body.agentId ?? 'orchestrator',
      });
      sessionId = session.id;
      ctx.platform.logger.info(`[run-handler] Created new session ${sessionId}`);
    } else {
      // Verify session exists (from current manager first)
      const existingSession = await sessionManager.loadSession(sessionId);
      let resolvedSession = existingSession;

      // Fallback: session may belong to a different root than current ctx.cwd
      if (!resolvedSession && pathExists(ctx.cwd)) {
        const fallbackManager = new SessionManager(ctx.cwd);
        const fallbackSession = await fallbackManager.loadSession(sessionId);
        if (fallbackSession) {
          sessionManager = fallbackManager;
          resolvedSession = fallbackSession;
        }
      }

      if (!resolvedSession) {
        throw new Error(`Session not found: ${sessionId} (cwd=${ctx.cwd})`);
      }

      // Session workingDir is primary source of truth for follow-up runs
      workingDir = body.workingDir || resolvedSession.workingDir || workingDir;

      // Smart follow-up anchoring: keep depth requests in the same repo/module as previous run
      if (!body.workingDir && isLikelyFollowUpScopeTask(body.task)) {
        const inferred = await inferFollowUpWorkingDir(sessionManager, sessionId, resolvedSession.workingDir || ctx.cwd);
        if (inferred && inferred !== workingDir) {
          ctx.platform.logger.info(`[run-handler] Follow-up scope inferred: ${workingDir} -> ${inferred}`);
          workingDir = inferred;
        }
      }

      // Rebind session manager to effective working directory
      sessionManager = new SessionManager(workingDir);
      ctx.platform.logger.info(`[run-handler] Continuing session ${sessionId} (workingDir=${workingDir})`);
    }

    ctx.platform.logger.info(`[run-handler] Starting run ${runId} for task: ${body.task}`);

    // Create user turn with task/question
    await sessionManager.createUserTurn(sessionId, body.task, runId);

    // Track run started
    await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_STARTED, {
      runId,
      sessionId,
      taskLength: body.task.length,
      tier: body.tier ?? 'medium',
      enableEscalation: body.enableEscalation ?? true,
      responseMode: body.responseMode ?? 'auto',
      verbose: body.verbose ?? false,
    });

    // Create tool registry with standard tools
    const toolRegistry = createToolRegistry({
      workingDir,
      verbose: body.verbose,
      cache: useCache(),
    });
    const agentsConfig = await useConfig<AgentsPluginConfig>();

    const finalSessionId = sessionId; // Capture for closure
    const traceDir = path.join(workingDir, '.kb', 'traces', 'incremental');
    const traceWriter = new IncrementalTraceWriter(runId, {}, traceDir);

    // Create agent with event broadcasting and session persistence
    const agent = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner({
        sessionId: finalSessionId,
        workingDir,
        maxIterations: 50,
        temperature: 0.1,
        tier: body.tier ?? 'medium',
        tokenBudget: agentsConfig?.tokenBudget,
        onEvent: (event) => {
          // Broadcast to all WebSocket listeners (assigns seq)
          const seqEvent = RunManager.broadcast(runId, event);

          // Persist event with seq + runId + sessionId in metadata to session storage
          void sessionManager.addEvent(finalSessionId, {
            ...seqEvent,
            sessionId: finalSessionId,
            runId,
            metadata: {
              ...seqEvent.metadata,
              sessionId: finalSessionId,
              runId,
              workingDir,
            },
          });
        },
      });

    // Register run (pass sessionManager and sessionId so session-level WS listeners receive events)
    const run = await RunManager.register(runId, body.task, agent, sessionManager, finalSessionId);
    await RunManager.updateStatus(runId, 'running');

    // Start execution in background (don't await)
    void (async () => {
      try {
        const result = await agent.execute(body.task);
        const durationMs = Date.now() - startTime;
        const detailedTrace = traceWriter.getEntries() as Array<Record<string, unknown>>;
        await traceWriter.finalize?.();

        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(finalSessionId, runId, detailedTrace);
        }

        // Attach file change summaries to the turn so the UI can show rollback/approve panel
        // TODO: restore file history tracking via ObservabilityMiddleware once SDKAgentRunner
        //       populates run.meta with file changes (tracked by legacy Agent.getFileHistory())
        const legacyAgent = agent as unknown as { getFileHistory?: () => Array<{ runId: string; id: string; filePath: string; operation: 'write' | 'patch' | 'delete'; timestamp: string; metadata?: { linesAdded?: number; linesRemoved?: number }; before: unknown; after: { size: number }; approved: boolean }> };
        if (typeof legacyAgent.getFileHistory === 'function') {
          const fileHistory = legacyAgent.getFileHistory().filter((c) => c.runId === runId);
          if (fileHistory.length > 0) {
            const fileChanges: FileChangeSummary[] = fileHistory.map((c) => ({
              changeId: c.id,
              filePath: c.filePath,
              operation: c.operation,
              timestamp: c.timestamp,
              linesAdded: c.metadata?.linesAdded,
              linesRemoved: c.metadata?.linesRemoved,
              isNew: !c.before,
              sizeAfter: c.after.size,
              approved: c.approved,
            }));
            await sessionManager.attachFileChangesToTurn(finalSessionId, runId, fileChanges);
          }
        }

        await RunManager.updateStatus(runId, result.success ? 'completed' : 'failed', {
          completedAt: new Date().toISOString(),
          durationMs,
          summary: result.summary,
          error: result.error,
        });

        // Track completion
        await analytics?.track(
          result.success ? AGENT_ANALYTICS_EVENTS.RUN_COMPLETED : AGENT_ANALYTICS_EVENTS.RUN_FAILED,
          {
            runId,
            durationMs,
            success: result.success,
            summary: result.summary?.slice(0, 200),
          }
        );

        ctx.platform.logger.info(`[run-handler] Run ${runId} completed: ${result.success}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - startTime;
        const detailedTrace = traceWriter.getEntries() as Array<Record<string, unknown>>;
        await traceWriter.finalize?.();
        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(finalSessionId, runId, detailedTrace);
        }

        await RunManager.updateStatus(runId, 'failed', {
          completedAt: new Date().toISOString(),
          durationMs,
          error: errorMsg,
        });

        // Track failure
        await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_FAILED, {
          runId,
          durationMs,
          error: errorMsg.slice(0, 200),
        });

        ctx.platform.logger.error(`[run-handler] Run ${runId} failed: ${errorMsg}`);
      }
    })();

    // Build WebSocket URL — session-level stream (persistent, survives multiple runs)
    const wsPath = AGENTS_WS_CHANNELS.SESSION_STREAM.replace(':sessionId', finalSessionId);
    const eventsUrl = `ws://localhost:${process.env.KB_REST_PORT || 5050}${AGENTS_WS_BASE_PATH}${wsPath}`;

    return {
      runId,
      sessionId: finalSessionId,
      eventsUrl,
      status: 'started',
      startedAt: run.startedAt,
    };
  },
});
