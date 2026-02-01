/**
 * POST /run handler
 *
 * Starts a new agent run via Orchestrator
 */

import { defineHandler, useAnalytics, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { OrchestratorAgent, SessionManager } from '@kb-labs/agent-core';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { RunRequest, RunResponse } from '@kb-labs/agent-contracts';
import {
  AGENTS_WS_BASE_PATH,
  AGENTS_WS_CHANNELS,
  AGENT_ANALYTICS_EVENTS,
} from '@kb-labs/agent-contracts';
import { RunManager } from '../run-manager.js';

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
    const workingDir = body.workingDir || ctx.cwd;
    const startTime = Date.now();
    const sessionManager = new SessionManager(workingDir);

    // Get or create session
    let sessionId = body.sessionId;
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
      // Verify session exists
      const existingSession = await sessionManager.loadSession(sessionId);
      if (!existingSession) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      ctx.platform.logger.info(`[run-handler] Continuing session ${sessionId}`);
    }

    ctx.platform.logger.info(`[run-handler] Starting run ${runId} for task: ${body.task}`);

    // Track run started
    await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_STARTED, {
      runId,
      sessionId,
      taskLength: body.task.length,
      tier: body.tier ?? 'medium',
      verbose: body.verbose ?? false,
    });

    // Create tool registry with standard tools
    const toolRegistry = createToolRegistry({
      workingDir,
      verbose: body.verbose,
    });

    // Create orchestrator with event broadcasting and session persistence
    const finalSessionId = sessionId; // Capture for closure
    const orchestrator = new OrchestratorAgent(
      {
        sessionId: finalSessionId,
        workingDir,
        maxIterations: 50, // Default max iterations
        temperature: 0.1, // Low temperature for deterministic execution
        verbose: body.verbose ?? false,
        tier: body.tier ?? 'medium',
        onEvent: (event) => {
          // Broadcast to all WebSocket listeners (assigns seq)
          const seqEvent = RunManager.broadcast(runId, event);

          // Persist event with seq to session storage (fire and forget)
          void sessionManager.addEvent(finalSessionId, {
            ...seqEvent,
            sessionId: finalSessionId,
          });
        },
      },
      toolRegistry
    );

    // Register run
    const run = await RunManager.register(runId, body.task, orchestrator);
    await RunManager.updateStatus(runId, 'running');

    // Start execution in background (don't await)
    void (async () => {
      try {
        const result = await orchestrator.execute(body.task);
        const durationMs = Date.now() - startTime;

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

    // Build WebSocket URL for events
    const wsPath = AGENTS_WS_CHANNELS.EVENTS.replace(':runId', runId);
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
