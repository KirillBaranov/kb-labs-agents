/**
 * GET /sessions/:sessionId/events - Get session events (chat history)
 */

import { defineHandler, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '@kb-labs/agent-core';
import type { GetSessionEventsResponse } from '@kb-labs/agent-contracts';

interface GetSessionEventsRequest {
  sessionId?: string;
  limit?: number;
  offset?: number;
  types?: string[];
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GetSessionEventsRequest>
  ): Promise<GetSessionEventsResponse> {
    const params = input.params as Record<string, string> | undefined;
    const sessionId = params?.sessionId;
    const query = input.query as Partial<GetSessionEventsRequest> | undefined;

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const sessionManager = new SessionManager(ctx.cwd);

    ctx.platform.logger.info(`[get-session-events] cwd: ${ctx.cwd}, sessionId: ${sessionId}`);
    ctx.platform.logger.info(`[get-session-events] eventsPath: ${sessionManager.getEventsPath(sessionId)}`);

    // Verify session exists
    const session = await sessionManager.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const events = await sessionManager.getSessionEvents(sessionId, {
      limit: query?.limit, // No default limit - return all events
      offset: query?.offset ?? 0,
      types: query?.types,
    });

    ctx.platform.logger.info(`[get-session-events] Found ${events.length} events`);

    const total = await sessionManager.countEvents(sessionId, query?.types);

    return { events, total };
  },
});
