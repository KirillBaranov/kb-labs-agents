/**
 * GET /sessions/:sessionId/changes - List file changes for a session
 * Optionally filtered by ?runId= to scope to a specific agent run/turn.
 */

import { defineHandler, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '@kb-labs/agent-core';
import { SnapshotStorage } from '@kb-labs/agent-history';
import type { FileChangeSummary } from '@kb-labs/agent-contracts';

interface ListFileChangesResponse {
  changes: FileChangeSummary[];
  total: number;
  sessionId: string;
  runId?: string;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput
  ): Promise<ListFileChangesResponse> {
    const params = input.params as Record<string, string> | undefined;
    const sessionId = params?.sessionId;

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const query = input.query as Record<string, string> | undefined;
    const runId = query?.runId;

    const sessionManager = new SessionManager(ctx.cwd);
    const session = await sessionManager.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Use session's own workingDir for snapshot lookup (may differ from ctx.cwd)
    const workingDir = session.workingDir || ctx.cwd;
    const storage = new SnapshotStorage(workingDir);
    let changes = await storage.listSnapshots(sessionId);

    if (runId) {
      changes = changes.filter((c) => c.runId === runId);
    }

    const total = changes.length;

    const summaries: FileChangeSummary[] = changes.map((c) => ({
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

    return { changes: summaries, total, sessionId, runId };
  },
});
