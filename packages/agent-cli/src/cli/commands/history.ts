/**
 * agent:history - Show file change history
 *
 * Usage:
 *   pnpm kb agent:history --session-id={id}
 *   pnpm kb agent:history --file=src/index.ts
 *   pnpm kb agent:history --agent-id={id}
 *   pnpm kb agent:history --json
 */

import { defineCommand, useLogger } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';

type HistoryInput = {
  sessionId?: string;
  file?: string;
  agentId?: string;
  json?: boolean;
};

type HistoryResult = { exitCode: number; response?: any };

export default defineCommand({
  id: 'history',
  description: 'Show file change history for agent sessions',

  handler: {
    async execute(ctx: PluginContextV3, input: HistoryInput): Promise<HistoryResult> {
      const logger = useLogger();
      const flags = (input as any).flags ?? input;

      try {
        // Default to .kb/agents/sessions
        const basePath = path.join(process.cwd(), '.kb', 'agents', 'sessions');

        // If session-id provided, load that session
        if (flags.sessionId) {
          return await showSessionHistory(ctx, basePath, flags.sessionId, flags);
        }

        // If file provided, search all sessions for that file
        if (flags.file) {
          return await showFileHistory(ctx, basePath, flags.file, flags);
        }

        // If agent-id provided, search all sessions for that agent
        if (flags.agentId) {
          return await showAgentHistory(ctx, basePath, flags.agentId, flags);
        }

        // Otherwise, list all sessions
        return await listAllSessions(ctx, basePath, flags);
      } catch (err) {
        logger.error('agent:history error:', err instanceof Error ? err : undefined);
        const errResponse = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
        return { exitCode: 1, response: errResponse };
      }
    },
  },
});

/**
 * Show history for specific session
 */
async function showSessionHistory(
  ctx: PluginContextV3,
  basePath: string,
  sessionId: string,
  flags: any
): Promise<HistoryResult> {
  const sessionDir = path.join(basePath, sessionId);
  const snapshotsDir = path.join(sessionDir, 'snapshots');

  // Check if session exists
  try {
    await fs.access(snapshotsDir);
  } catch {
    const err = { success: false, error: `Session not found: ${sessionId}` };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  // Read all snapshots
  const files = await fs.readdir(snapshotsDir);
  const snapshots = [];

  for (const file of files) {
    if (!file.endsWith('.json')) {continue;}

    const content = await fs.readFile(path.join(snapshotsDir, file), 'utf-8');
    const snapshot = JSON.parse(content);
    snapshots.push(snapshot);
  }

  // Sort by timestamp
  snapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const response = {
    success: true,
    sessionId,
    changes: snapshots.length,
    data: snapshots,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  } else {
    printSessionHistory(ctx, sessionId, snapshots);
  }

  return { exitCode: 0, response };
}

/**
 * Show history for specific file across all sessions
 */
async function showFileHistory(
  ctx: PluginContextV3,
  basePath: string,
  filePath: string,
  flags: any
): Promise<HistoryResult> {
  // Find all sessions
  const sessions = await fs.readdir(basePath);
  const allChanges = [];

  for (const sessionId of sessions) {
    const snapshotsDir = path.join(basePath, sessionId, 'snapshots');

    try {
      const files = await fs.readdir(snapshotsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) {continue;}

        const content = await fs.readFile(path.join(snapshotsDir, file), 'utf-8');
        const snapshot = JSON.parse(content);

        if (snapshot.filePath === filePath) {
          allChanges.push({ ...snapshot, sessionId });
        }
      }
    } catch {
      // Skip sessions without snapshots
      continue;
    }
  }

  // Sort by timestamp
  allChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const response = {
    success: true,
    filePath,
    changes: allChanges.length,
    data: allChanges,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  } else {
    printFileHistory(ctx, filePath, allChanges);
  }

  return { exitCode: 0, response };
}

/**
 * Show history for specific agent across all sessions
 */
async function showAgentHistory(
  ctx: PluginContextV3,
  basePath: string,
  agentId: string,
  flags: any
): Promise<HistoryResult> {
  // Find all sessions
  const sessions = await fs.readdir(basePath);
  const allChanges = [];

  for (const sessionId of sessions) {
    const snapshotsDir = path.join(basePath, sessionId, 'snapshots');

    try {
      const files = await fs.readdir(snapshotsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) {continue;}

        const content = await fs.readFile(path.join(snapshotsDir, file), 'utf-8');
        const snapshot = JSON.parse(content);

        if (snapshot.agentId === agentId) {
          allChanges.push({ ...snapshot, sessionId });
        }
      }
    } catch {
      // Skip sessions without snapshots
      continue;
    }
  }

  // Sort by timestamp
  allChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const response = {
    success: true,
    agentId,
    changes: allChanges.length,
    data: allChanges,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  } else {
    printAgentHistory(ctx, agentId, allChanges);
  }

  return { exitCode: 0, response };
}

/**
 * List all sessions with basic info
 */
async function listAllSessions(
  ctx: PluginContextV3,
  basePath: string,
  flags: any
): Promise<HistoryResult> {
  const sessions = await fs.readdir(basePath);
  const sessionInfo = [];

  for (const sessionId of sessions) {
    const snapshotsDir = path.join(basePath, sessionId, 'snapshots');

    try {
      const files = await fs.readdir(snapshotsDir);
      const snapshotFiles = files.filter((f) => f.endsWith('.json'));

      if (snapshotFiles.length === 0) {continue;}

      // Read first and last snapshot for timestamps
      const firstContent = await fs.readFile(
        path.join(snapshotsDir, snapshotFiles[0]!),
        'utf-8'
      );
      const lastContent = await fs.readFile(
        path.join(snapshotsDir, snapshotFiles[snapshotFiles.length - 1]!),
        'utf-8'
      );

      const firstSnapshot = JSON.parse(firstContent);
      const lastSnapshot = JSON.parse(lastContent);

      // Collect unique agents
      const agents = new Set<string>();
      const files_changed = new Set<string>();

      for (const file of snapshotFiles) {
        const content = await fs.readFile(path.join(snapshotsDir, file), 'utf-8');
        const snapshot = JSON.parse(content);
        agents.add(snapshot.agentId);
        files_changed.add(snapshot.filePath);
      }

      sessionInfo.push({
        sessionId,
        changes: snapshotFiles.length,
        agents: Array.from(agents),
        filesChanged: Array.from(files_changed),
        startedAt: firstSnapshot.timestamp,
        lastChangeAt: lastSnapshot.timestamp,
      });
    } catch {
      // Skip invalid sessions
      continue;
    }
  }

  // Sort by last change
  sessionInfo.sort(
    (a, b) => new Date(b.lastChangeAt).getTime() - new Date(a.lastChangeAt).getTime()
  );

  const response = {
    success: true,
    sessions: sessionInfo.length,
    data: sessionInfo,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  } else {
    printSessionsList(ctx, sessionInfo);
  }

  return { exitCode: 0, response };
}

/**
 * Print session history in human-readable format
 */
function printSessionHistory(ctx: PluginContextV3, sessionId: string, snapshots: any[]): void {
  ctx.ui.write('\n');
  ctx.ui.write(`📜 File Change History - Session: ${sessionId}\n`);
  ctx.ui.write('\n');
  ctx.ui.write(`Total changes: ${snapshots.length}\n`);
  ctx.ui.write('\n');

  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.timestamp).toLocaleString();
    const operation = snapshot.operation.toUpperCase().padEnd(7);
    const size = snapshot.after?.size || 0;
    const sizeFormatted = formatSize(size);

    ctx.ui.write(`[${timestamp}] ${operation} ${snapshot.filePath}\n`);
    ctx.ui.write(`  Agent: ${snapshot.agentId}\n`);
    ctx.ui.write(`  Size: ${sizeFormatted}\n`);

    if (snapshot.metadata?.linesAdded !== undefined) {
      ctx.ui.write(
        `  Lines: +${snapshot.metadata.linesAdded} -${snapshot.metadata.linesRemoved}\n`
      );
    }

    ctx.ui.write(`  Change ID: ${snapshot.id}\n`);
    ctx.ui.write('\n');
  }
}

/**
 * Print file history in human-readable format
 */
function printFileHistory(ctx: PluginContextV3, filePath: string, changes: any[]): void {
  ctx.ui.write('\n');
  ctx.ui.write(`📄 File History: ${filePath}\n`);
  ctx.ui.write('\n');
  ctx.ui.write(`Total changes: ${changes.length}\n`);
  ctx.ui.write('\n');

  for (const change of changes) {
    const timestamp = new Date(change.timestamp).toLocaleString();
    const operation = change.operation.toUpperCase().padEnd(7);

    ctx.ui.write(`[${timestamp}] ${operation}\n`);
    ctx.ui.write(`  Session: ${change.sessionId}\n`);
    ctx.ui.write(`  Agent: ${change.agentId}\n`);
    ctx.ui.write(`  Change ID: ${change.id}\n`);
    ctx.ui.write('\n');
  }
}

/**
 * Print agent history in human-readable format
 */
function printAgentHistory(ctx: PluginContextV3, agentId: string, changes: any[]): void {
  ctx.ui.write('\n');
  ctx.ui.write(`🤖 Agent History: ${agentId}\n`);
  ctx.ui.write('\n');
  ctx.ui.write(`Total changes: ${changes.length}\n`);
  ctx.ui.write('\n');

  // Group by file
  const byFile = new Map<string, any[]>();
  for (const change of changes) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }
    byFile.get(change.filePath)!.push(change);
  }

  ctx.ui.write(`Files modified: ${byFile.size}\n`);
  ctx.ui.write('\n');

  for (const [filePath, fileChanges] of byFile.entries()) {
    ctx.ui.write(`📄 ${filePath} (${fileChanges.length} changes)\n`);
    for (const change of fileChanges) {
      const timestamp = new Date(change.timestamp).toLocaleString();
      const operation = change.operation.toUpperCase().padEnd(7);
      ctx.ui.write(`  [${timestamp}] ${operation} (${change.sessionId})\n`);
    }
    ctx.ui.write('\n');
  }
}

/**
 * Print sessions list in human-readable format
 */
function printSessionsList(ctx: PluginContextV3, sessions: any[]): void {
  ctx.ui.write('\n');
  ctx.ui.write('📋 Agent Sessions\n');
  ctx.ui.write('\n');
  ctx.ui.write(`Total sessions: ${sessions.length}\n`);
  ctx.ui.write('\n');

  for (const session of sessions) {
    const lastChange = new Date(session.lastChangeAt).toLocaleString();

    ctx.ui.write(`Session: ${session.sessionId}\n`);
    ctx.ui.write(`  Last change: ${lastChange}\n`);
    ctx.ui.write(`  Changes: ${session.changes}\n`);
    ctx.ui.write(`  Agents: ${session.agents.join(', ')}\n`);
    ctx.ui.write(`  Files: ${session.filesChanged.length}\n`);
    ctx.ui.write('\n');
  }
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
