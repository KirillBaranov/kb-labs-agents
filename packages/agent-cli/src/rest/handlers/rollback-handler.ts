/**
 * POST /sessions/:sessionId/rollback
 * Rollback file changes for a session, optionally scoped to a runId or specific changeIds.
 */

import { defineHandler, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '@kb-labs/agent-core';
import { SnapshotStorage } from '@kb-labs/agent-history';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface RollbackRequest {
  runId?: string;
  changeIds?: string[];
  skipConflicts?: boolean;
}

interface ConflictEntry {
  filePath: string;
  changeId: string;
  reason: string;
}

interface RollbackResponse {
  rolledBack: number;
  skipped: number;
  conflicts: ConflictEntry[];
  success: boolean;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<RollbackRequest>
  ): Promise<RollbackResponse> {
    const params = input.params as Record<string, string> | undefined;
    const sessionId = params?.sessionId;

    if (!sessionId) throw new Error('Session ID is required');

    const body = (input.body ?? {}) as RollbackRequest;

    const sessionManager = new SessionManager(ctx.cwd);
    const session = await sessionManager.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Use session's own workingDir for snapshot lookup (may differ from ctx.cwd)
    const workingDir = session.workingDir || ctx.cwd;
    const storage = new SnapshotStorage(workingDir);
    let allChanges = await storage.listSnapshots(sessionId);

    // Filter to the requested scope
    if (body.runId) {
      allChanges = allChanges.filter((c) => c.runId === body.runId);
    } else if (body.changeIds?.length) {
      const ids = new Set(body.changeIds);
      allChanges = allChanges.filter((c) => ids.has(c.id));
    }

    if (allChanges.length === 0) {
      return { rolledBack: 0, skipped: 0, conflicts: [], success: true };
    }

    // Process in reverse-chronological order (undo latest changes first)
    const sorted = [...allChanges].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Load full snapshot list for conflict detection
    const fullHistory = await storage.listSnapshots(sessionId);

    const conflicts: ConflictEntry[] = [];
    let rolledBack = 0;
    let skipped = 0;

    for (const change of sorted) {
      // Conflict check: are there newer changes to this file not in our rollback set?
      if (!body.skipConflicts) {
        const rollbackIds = new Set(sorted.map((c) => c.id));
        const laterChanges = fullHistory.filter(
          (c) =>
            c.filePath === change.filePath &&
            new Date(c.timestamp).getTime() > new Date(change.timestamp).getTime() &&
            !rollbackIds.has(c.id)
        );

        if (laterChanges.length > 0) {
          const laterAgents = [...new Set(laterChanges.map((c) => c.agentId))].join(', ');
          conflicts.push({
            filePath: change.filePath,
            changeId: change.id,
            reason: `File was modified after this change by: ${laterAgents}. Use skipConflicts: true to force.`,
          });
          skipped++;
          continue;
        }
      }

      try {
        const fullPath = path.join(workingDir, change.filePath);

        if (change.before) {
          // Restore to previous content
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, change.before.content, 'utf-8');
        } else {
          // File was newly created by agent — delete it
          await fs.unlink(fullPath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
          });
        }

        rolledBack++;
      } catch (err) {
        conflicts.push({
          filePath: change.filePath,
          changeId: change.id,
          reason: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        skipped++;
      }
    }

    // Remove rolled-back changes from turns.json so UI hides them after page reload
    if (body.runId && rolledBack > 0) {
      const conflictIds = new Set(conflicts.map((c) => c.changeId));
      const fullChanges = await storage.listSnapshots(sessionId);
      const keptSummaries = fullChanges
        .filter((c) => c.runId === body.runId && conflictIds.has(c.id))
        .map((c) => ({
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
      const sessionManagerForTurn = new SessionManager(ctx.cwd);
      await sessionManagerForTurn.attachFileChangesToTurn(sessionId, body.runId, keptSummaries);
    }

    ctx.platform.logger.info(
      `[rollback-handler] Session ${sessionId}: rolled back ${rolledBack}, skipped ${skipped}`
    );

    return { rolledBack, skipped, conflicts, success: skipped === 0 };
  },
});
