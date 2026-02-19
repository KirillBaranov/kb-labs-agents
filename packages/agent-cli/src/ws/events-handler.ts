/**
 * WebSocket handler for agent event streaming
 *
 * Path: /events/:runId
 * Streams AgentEvents in real-time to connected clients
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */
// Using import() in type signatures to avoid circular dependencies

import {
  defineWebSocket,
  useAnalytics,
  type PluginContextV3,
  type TypedSender,
} from '@kb-labs/sdk';
import type {
  ServerMessage,
  ClientMessage,
  AgentEventMessage,
  ConnectionReadyMessage,
  RunCompletedMessage,
  ErrorMessage,
  CorrectionAckMessage,
} from '@kb-labs/agent-contracts';
import { AGENT_ANALYTICS_EVENTS } from '@kb-labs/agent-contracts';
import { RunManager } from '../rest/run-manager.js';

export default defineWebSocket<unknown, ClientMessage, ServerMessage>({
  path: '/events/:runId',
  description: 'Real-time agent event streaming',

  handler: {
    async onConnect(ctx: PluginContextV3, sender: TypedSender<ServerMessage>) {
      // Extract runId from path params (set by router)
      const runId = (ctx.hostContext as { params?: { runId?: string } }).params?.runId;

      if (!runId) {
        await sender.send({
          type: 'error',
          payload: {
            code: 'MISSING_RUN_ID',
            message: 'Run ID is required',
          },
          timestamp: Date.now(),
        } satisfies ErrorMessage);
        sender.close(4000, 'Missing run ID');
        return;
      }

      // Check if run exists (memory or cache - handles cross-process)
      const runExists = await RunManager.exists(runId);

      if (!runExists) {
        await sender.send({
          type: 'error',
          payload: {
            code: 'RUN_NOT_FOUND',
            message: `Run ${runId} not found`,
          },
          timestamp: Date.now(),
        } satisfies ErrorMessage);
        sender.close(4004, 'Run not found');
        return;
      }

      // Get run from memory (for active runs) or state from cache
      const run = RunManager.get(runId);
      const runState = run || (await RunManager.getState(runId));

      ctx.platform.logger.info(`[events-ws] Client connected to run ${runId}`);

      // Track WS connection
      const analytics = useAnalytics();
      await analytics?.track(AGENT_ANALYTICS_EVENTS.WS_CONNECTED, { runId });

      // Register event listener
      const eventCallback = (event: import('@kb-labs/agent-contracts').AgentEvent) => {
        const message: AgentEventMessage = {
          type: 'agent:event',
          payload: event,
          timestamp: Date.now(),
        };

        // Send event to this client
        sender.send(message).catch((err) => {
          ctx.platform.logger.error(`[events-ws] Failed to send event: ${err}`);
        });

        // Check if run completed (only when MAIN agent ends, not sub-agents)
        if (event.type === 'agent:end' && !event.parentAgentId) {
          const completedMsg: RunCompletedMessage = {
            type: 'run:completed',
            payload: {
              runId,
              success: event.data.success,
              summary: event.data.summary,
              durationMs: event.data.durationMs,
            },
            timestamp: Date.now(),
          };

          sender.send(completedMsg).catch(() => {});
        }
      };

      // Store callback reference for cleanup
      (ctx as unknown as { _eventCallback?: typeof eventCallback })._eventCallback = eventCallback;

      // Send connection ready message
      await sender.send({
        type: 'connection:ready',
        payload: {
          runId,
          connectedAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      } satisfies ConnectionReadyMessage);

      // Replay buffer: send all events emitted before WS connected
      // This eliminates the gap between POST /run and WS connection
      const missedEvents = RunManager.getEventBuffer(runId);
      if (missedEvents.length > 0) {
        ctx.platform.logger.info(`[events-ws] Replaying ${missedEvents.length} buffered events for run ${runId}`);
        for (const event of missedEvents) {
          const message: AgentEventMessage = {
            type: 'agent:event',
            payload: event,
            timestamp: Date.now(),
          };
          await sender.send(message);
        }
      }

      // Register listener for future events (after replay)
      RunManager.addListener(runId, eventCallback);

      // If run already completed, send final status
      if (runState && (runState.status === 'completed' || runState.status === 'failed' || runState.status === 'stopped')) {
        await sender.send({
          type: 'run:completed',
          payload: {
            runId,
            success: runState.status === 'completed',
            summary: runState.summary || runState.error || `Run ${runState.status}`,
            durationMs: runState.durationMs || 0,
          },
          timestamp: Date.now(),
        } satisfies RunCompletedMessage);
      }
    },

    async onMessage(ctx: PluginContextV3, message: ClientMessage, sender: TypedSender<ServerMessage>) {
      const runId = (ctx.hostContext as { params?: { runId?: string } }).params?.runId;

      if (!runId) {return;}

      ctx.platform.logger.info(`[events-ws] Received message type: ${message.type}`);

      switch (message.type) {
        case 'user:correction': {
          const run = RunManager.get(runId);
          if (run && run.status === 'running') {
            const result = await run.orchestrator.injectCorrection(
              message.payload.message,
              message.payload.targetAgentId
            );

            await sender.send({
              type: 'correction:ack',
              payload: {
                correctionId: result.correctionId,
                routedTo: result.routedTo,
                reason: result.reason,
              },
              timestamp: Date.now(),
            } satisfies CorrectionAckMessage);
          }
          break;
        }

        case 'user:stop': {
          const run = RunManager.get(runId);
          if (run && run.status === 'running') {
            run.orchestrator.requestStop();
            await RunManager.updateStatus(runId, 'stopped', {
              completedAt: new Date().toISOString(),
              summary: message.payload.reason || 'Stopped by user via WebSocket',
            });
          }
          break;
        }

        case 'ping': {
          // Respond to keepalive
          await sender.send({
            type: 'connection:ready',
            payload: {
              runId,
              connectedAt: new Date().toISOString(),
            },
            timestamp: Date.now(),
          });
          break;
        }
      }
    },

    async onDisconnect(ctx: PluginContextV3, code: number, reason: string) {
      const runId = (ctx.hostContext as { params?: { runId?: string } }).params?.runId;
      const callback = (ctx as unknown as { _eventCallback?: import('@kb-labs/agent-contracts').AgentEventCallback })._eventCallback;

      if (runId && callback) {
        RunManager.removeListener(runId, callback);
      }

      // Track WS disconnection
      const analytics = useAnalytics();
      await analytics?.track(AGENT_ANALYTICS_EVENTS.WS_DISCONNECTED, { runId, code, reason });

      ctx.platform.logger.info(`[events-ws] Client disconnected from run ${runId}: ${code} ${reason}`);
    },

    async onError(ctx: PluginContextV3, error: Error, sender: TypedSender<ServerMessage>) {
      ctx.platform.logger.error(`[events-ws] WebSocket error: ${error.message}`);

      await sender.send({
        type: 'error',
        payload: {
          code: 'INTERNAL_ERROR',
          message: error.message,
        },
        timestamp: Date.now(),
      } satisfies ErrorMessage);
    },
  },
});
