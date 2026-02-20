/**
 * WebSocket handler for session-level event streaming
 *
 * Path: /session/:sessionId
 * Single persistent connection per session — streams turn:snapshot for ALL runs in the session.
 * Unlike /events/:runId which closes when a run ends, this stays open for the entire session.
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */

import {
  defineWebSocket,
  type PluginContextV3,
  type TypedSender,
} from '@kb-labs/sdk';
import type {
  ServerMessage,
  ClientMessage,
  ConnectionReadyMessage,
  RunCompletedMessage,
  ErrorMessage,
  TurnSnapshotMessage,
  ConversationSnapshotMessage,
  AgentEvent,
  Turn,
} from '@kb-labs/agent-contracts';
import { RunManager } from '../rest/run-manager.js';
import { SessionManager } from '@kb-labs/agent-core';

function getTurnIdFromEvent(event: AgentEvent): string | null {
  if ((event.type === 'agent:start' || event.type === 'agent:end' || event.type === 'agent:error') && !event.parentAgentId && event.agentId) {
    return `turn-${event.agentId}`;
  }
  return null;
}

function getTurnSignature(turn: Turn): string {
  return `${turn.id}:${turn.status}:${turn.completedAt || ''}:${turn.steps.length}`;
}

async function resolveTurnForEvent(
  sessionManager: SessionManager,
  sessionId: string,
  event: AgentEvent
): Promise<Turn | null> {
  const turns = await sessionManager.getTurns(sessionId);
  if (turns.length === 0) {
    return null;
  }

  const explicitTurnId = getTurnIdFromEvent(event);
  if (explicitTurnId) {
    const explicit = turns.find((turn) => turn.id === explicitTurnId);
    if (explicit) {
      return explicit;
    }
  }

  // For tool/llm/status events, send latest assistant turn snapshot.
  const assistantTurns = turns
    .filter((turn) => turn.type === 'assistant')
    .sort((a, b) => b.sequence - a.sequence);
  return assistantTurns[0] || null;
}

export default defineWebSocket<unknown, ClientMessage, ServerMessage>({
  path: '/session/:sessionId',
  description: 'Persistent session event stream (all runs)',

  handler: {
    async onConnect(ctx: PluginContextV3, sender: TypedSender<ServerMessage>) {
      const sessionId = (ctx.hostContext as { params?: { sessionId?: string } }).params?.sessionId;

      if (!sessionId) {
        await sender.send({
          type: 'error',
          payload: { code: 'MISSING_SESSION_ID', message: 'Session ID is required' },
          timestamp: Date.now(),
        } satisfies ErrorMessage);
        sender.close(4000, 'Missing session ID');
        return;
      }

      ctx.platform.logger.info(`[session-ws] Client connected to session ${sessionId}`);

      const sessionManager = new SessionManager(ctx.cwd);
      const lastTurnSignatures = new Map<string, string>();

      // Send connection:ready immediately
      await sender.send({
        type: 'connection:ready',
        payload: { runId: sessionId, connectedAt: new Date().toISOString() },
        timestamp: Date.now(),
      } satisfies ConnectionReadyMessage);

      // Send conversation:snapshot (history)
      try {
        const snapshot = await sessionManager.getConversationSnapshot(sessionId);
        await sender.send({
          type: 'conversation:snapshot',
          payload: {
            sessionId,
            completedTurns: snapshot.completedTurns,
            activeTurns: snapshot.activeTurns,
            totalTurns: snapshot.totalTurns,
            timestamp: new Date().toISOString(),
          },
          timestamp: Date.now(),
        } satisfies ConversationSnapshotMessage);
        ctx.platform.logger.info(
          `[session-ws] Sent snapshot: ${snapshot.completedTurns.length} completed + ${snapshot.activeTurns.length} active turns`
        );
      } catch (err) {
        ctx.platform.logger.error(`[session-ws] Failed to send snapshot: ${err}`);
      }

      // Session-level event callback — registered on ALL active runs in this session
      const eventCallback = async (event: import('@kb-labs/agent-contracts').AgentEvent) => {
        // Resolve sessionId from event
        const evtSessionId = (event as { sessionId?: string }).sessionId
          || (event.metadata?.sessionId as string | undefined);

        // Only forward events belonging to this session
        if (evtSessionId && evtSessionId !== sessionId) {
          return;
        }

        const targetSessionId = evtSessionId || sessionId;

        try {
          const turn = await resolveTurnForEvent(sessionManager, targetSessionId, event);
          if (turn) {
            const signature = getTurnSignature(turn);
            const previousSignature = lastTurnSignatures.get(turn.id);
            if (previousSignature !== signature) {
              lastTurnSignatures.set(turn.id, signature);

              await sender.send({
                type: 'turn:snapshot',
                payload: { sessionId: targetSessionId, turn, sequenceNumber: turn.sequence },
                timestamp: Date.now(),
              } satisfies TurnSnapshotMessage);
            }
          }
        } catch (err) {
          ctx.platform.logger.error(`[session-ws] Failed to process turn snapshot: ${err}`);
        }

        // Notify run completion
        if (event.type === 'agent:end' && !event.parentAgentId) {
          const runId = (event as { runId?: string }).runId || (event.metadata?.runId as string | undefined);
          await sender.send({
            type: 'run:completed',
            payload: {
              runId: runId ?? 'unknown',
              success: event.data.success,
              summary: event.data.summary,
              durationMs: event.data.durationMs,
            },
            timestamp: Date.now(),
          } satisfies RunCompletedMessage);
        }
      };

      // Store callback for cleanup
      (ctx as unknown as Record<string, unknown>)._sessionCallback = eventCallback;
      (ctx as unknown as Record<string, unknown>)._sessionId = sessionId;

      // Register on all currently active runs in this session
      RunManager.addSessionListener(sessionId, eventCallback);
    },

    async onMessage(ctx: PluginContextV3, message: ClientMessage, sender: TypedSender<ServerMessage>) {
      // Handle ping or corrections here if needed
      if (message.type === 'ping') {
        const sessionId = (ctx as unknown as Record<string, unknown>)._sessionId as string;
        await sender.send({
          type: 'connection:ready',
          payload: { runId: sessionId ?? '', connectedAt: new Date().toISOString() },
          timestamp: Date.now(),
        });
      }
    },

    async onDisconnect(ctx: PluginContextV3) {
      const sessionId = (ctx as unknown as Record<string, unknown>)._sessionId as string;
      const callback = (ctx as unknown as Record<string, unknown>)._sessionCallback as
        | import('@kb-labs/agent-contracts').AgentEventCallback
        | undefined;

      if (sessionId && callback) {
        RunManager.removeSessionListener(sessionId, callback);
      }

      ctx.platform.logger.info(`[session-ws] Client disconnected from session ${sessionId}`);
    },

    async onError(ctx: PluginContextV3, error: Error, sender: TypedSender<ServerMessage>) {
      ctx.platform.logger.error(`[session-ws] WebSocket error: ${error.message}`);
      await sender.send({
        type: 'error',
        payload: { code: 'INTERNAL_ERROR', message: error.message },
        timestamp: Date.now(),
      } satisfies ErrorMessage);
    },
  },
});
