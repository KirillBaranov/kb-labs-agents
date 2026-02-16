/**
 * agent:rollback - Rollback file changes
 *
 * Usage:
 *   pnpm kb agent:rollback --change-id={id}
 *   pnpm kb agent:rollback --file=src/index.ts
 *   pnpm kb agent:rollback --agent-id={id}
 *   pnpm kb agent:rollback --session-id={id}
 *   pnpm kb agent:rollback --after="2026-02-16T10:00:00Z"
 */

import { defineCommand, useLogger } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';

type RollbackInput = {
  changeId?: string;
  file?: string;
  agentId?: string;
  sessionId?: string;
  after?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

type RollbackResult = { exitCode: number; response?: any };

export default defineCommand({
  id: 'rollback',
  description: 'Rollback file changes made by agents',

  handler: {
    async execute(ctx: PluginContextV3, input: RollbackInput): Promise<RollbackResult> {
      const logger = useLogger();
      const flags = (input as any).flags ?? input;

      try {
        const basePath = path.join(process.cwd(), '.kb', 'agents', 'sessions');

        // Rollback specific change
        if (flags.changeId) {
          return await rollbackChange(ctx, basePath, flags.changeId, flags);
        }

        // Rollback all changes to specific file
        if (flags.file) {
          return await rollbackFile(ctx, basePath, flags.file, flags);
        }

        // Rollback all changes by specific agent
        if (flags.agentId) {
          return await rollbackAgent(ctx, basePath, flags.agentId, flags);
        }

        // Rollback all changes in session
        if (flags.sessionId) {
          return await rollbackSession(ctx, basePath, flags.sessionId, flags);
        }

        // Rollback all changes after timestamp
        if (flags.after) {
          return await rollbackAfter(ctx, basePath, flags.after, flags);
        }

        // No flags provided
        const err = {
          success: false,
          error: 'Missing rollback target. Provide one of: --change-id, --file, --agent-id, --session-id, --after',
        };
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      } catch (err) {
        logger.error('agent:rollback error:', err instanceof Error ? err : undefined);
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
 * Rollback specific change by ID
 */
async function rollbackChange(
  ctx: PluginContextV3,
  basePath: string,
  changeId: string,
  flags: any
): Promise<RollbackResult> {
  // Find the change
  const sessions = await fs.readdir(basePath);
  let snapshot = null;
  let foundSessionId = null;

  for (const sessionId of sessions) {
    const snapshotPath = path.join(basePath, sessionId, 'snapshots', `${changeId}.json`);

    try {
      const content = await fs.readFile(snapshotPath, 'utf-8');
      snapshot = JSON.parse(content);
      foundSessionId = sessionId;
      break;
    } catch {
      continue;
    }
  }

  if (!snapshot) {
    const err = { success: false, error: `Change not found: ${changeId}` };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  // Check if we can rollback
  if (!snapshot.before && snapshot.operation === 'write') {
    // New file - delete it
    if (flags.dryRun) {
      ctx.ui.write(`[DRY RUN] Would delete file: ${snapshot.filePath}\n`);
    } else {
      const fullPath = path.join(process.cwd(), snapshot.filePath);
      await fs.unlink(fullPath);
      ctx.ui.write(`✅ Deleted file: ${snapshot.filePath}\n`);
    }
  } else if (snapshot.before) {
    // Restore previous content
    if (flags.dryRun) {
      ctx.ui.write(`[DRY RUN] Would restore file: ${snapshot.filePath}\n`);
      ctx.ui.write(`  Before size: ${snapshot.before.size} bytes\n`);
      ctx.ui.write(`  Current size: ${snapshot.after.size} bytes\n`);
    } else {
      const fullPath = path.join(process.cwd(), snapshot.filePath);
      await fs.writeFile(fullPath, snapshot.before.content, 'utf-8');
      ctx.ui.write(`✅ Restored file: ${snapshot.filePath}\n`);
    }
  } else {
    const err = { success: false, error: 'Cannot rollback: no previous state available' };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  const response = {
    success: true,
    action: 'rollback-change',
    changeId,
    filePath: snapshot.filePath,
    dryRun: flags.dryRun || false,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  }

  return { exitCode: 0, response };
}

/**
 * Rollback all changes to specific file
 */
async function rollbackFile(
  ctx: PluginContextV3,
  basePath: string,
  filePath: string,
  flags: any
): Promise<RollbackResult> {
  // Find all changes to this file
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
      continue;
    }
  }

  if (allChanges.length === 0) {
    const err = { success: false, error: `No changes found for file: ${filePath}` };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  // Sort by timestamp (newest first)
  allChanges.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Get earliest state
  const earliestChange = allChanges[allChanges.length - 1]!;

  if (flags.dryRun) {
    ctx.ui.write(`[DRY RUN] Would rollback ${allChanges.length} changes to: ${filePath}\n`);
    ctx.ui.write(`  Earliest state: ${earliestChange.before ? 'restore' : 'delete'}\n`);
  } else {
    // Rollback to earliest state
    if (earliestChange.before) {
      const fullPath = path.join(process.cwd(), filePath);
      await fs.writeFile(fullPath, earliestChange.before.content, 'utf-8');
      ctx.ui.write(`✅ Restored ${allChanges.length} changes to: ${filePath}\n`);
    } else {
      // File was created - delete it
      const fullPath = path.join(process.cwd(), filePath);
      await fs.unlink(fullPath);
      ctx.ui.write(`✅ Deleted file (created during session): ${filePath}\n`);
    }
  }

  const response = {
    success: true,
    action: 'rollback-file',
    filePath,
    changesRolledBack: allChanges.length,
    dryRun: flags.dryRun || false,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  }

  return { exitCode: 0, response };
}

/**
 * Rollback all changes by specific agent
 */
async function rollbackAgent(
  ctx: PluginContextV3,
  basePath: string,
  agentId: string,
  flags: any
): Promise<RollbackResult> {
  // Find all changes by this agent
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
      continue;
    }
  }

  if (allChanges.length === 0) {
    const err = { success: false, error: `No changes found for agent: ${agentId}` };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  // Group by file
  const byFile = new Map<string, any[]>();
  for (const change of allChanges) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }
    byFile.get(change.filePath)!.push(change);
  }

  if (flags.dryRun) {
    ctx.ui.write(`[DRY RUN] Would rollback changes by agent: ${agentId}\n`);
    ctx.ui.write(`  Files affected: ${byFile.size}\n`);
    ctx.ui.write(`  Total changes: ${allChanges.length}\n`);
  } else {
    let rolledBack = 0;

    for (const [filePath, fileChanges] of byFile.entries()) {
      // Sort by timestamp (oldest first)
      fileChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const earliestChange = fileChanges[0]!;

      try {
        if (earliestChange.before) {
          const fullPath = path.join(process.cwd(), filePath);
          await fs.writeFile(fullPath, earliestChange.before.content, 'utf-8');
          rolledBack++;
        } else {
          // File was created - delete it
          const fullPath = path.join(process.cwd(), filePath);
          await fs.unlink(fullPath);
          rolledBack++;
        }
      } catch (err) {
        ctx.ui.write(`⚠️  Failed to rollback ${filePath}: ${err}\n`);
      }
    }

    ctx.ui.write(`✅ Rolled back ${rolledBack} files by agent: ${agentId}\n`);
  }

  const response = {
    success: true,
    action: 'rollback-agent',
    agentId,
    filesAffected: byFile.size,
    changesRolledBack: allChanges.length,
    dryRun: flags.dryRun || false,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  }

  return { exitCode: 0, response };
}

/**
 * Rollback all changes in session
 */
async function rollbackSession(
  ctx: PluginContextV3,
  basePath: string,
  sessionId: string,
  flags: any
): Promise<RollbackResult> {
  const snapshotsDir = path.join(basePath, sessionId, 'snapshots');

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

  // Group by file
  const byFile = new Map<string, any[]>();
  for (const snapshot of snapshots) {
    if (!byFile.has(snapshot.filePath)) {
      byFile.set(snapshot.filePath, []);
    }
    byFile.get(snapshot.filePath)!.push(snapshot);
  }

  if (flags.dryRun) {
    ctx.ui.write(`[DRY RUN] Would rollback session: ${sessionId}\n`);
    ctx.ui.write(`  Files affected: ${byFile.size}\n`);
    ctx.ui.write(`  Total changes: ${snapshots.length}\n`);
  } else {
    let rolledBack = 0;

    for (const [filePath, fileChanges] of byFile.entries()) {
      // Sort by timestamp (oldest first)
      fileChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const earliestChange = fileChanges[0]!;

      try {
        if (earliestChange.before) {
          const fullPath = path.join(process.cwd(), filePath);
          await fs.writeFile(fullPath, earliestChange.before.content, 'utf-8');
          rolledBack++;
        } else {
          // File was created - delete it
          const fullPath = path.join(process.cwd(), filePath);
          await fs.unlink(fullPath);
          rolledBack++;
        }
      } catch (err) {
        ctx.ui.write(`⚠️  Failed to rollback ${filePath}: ${err}\n`);
      }
    }

    ctx.ui.write(`✅ Rolled back ${rolledBack} files in session: ${sessionId}\n`);
  }

  const response = {
    success: true,
    action: 'rollback-session',
    sessionId,
    filesAffected: byFile.size,
    changesRolledBack: snapshots.length,
    dryRun: flags.dryRun || false,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  }

  return { exitCode: 0, response };
}

/**
 * Rollback all changes after timestamp
 */
async function rollbackAfter(
  ctx: PluginContextV3,
  basePath: string,
  after: string,
  flags: any
): Promise<RollbackResult> {
  const afterDate = new Date(after);

  if (isNaN(afterDate.getTime())) {
    const err = { success: false, error: `Invalid timestamp: ${after}` };
    ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
    return { exitCode: 1, response: err };
  }

  // Find all changes after timestamp
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

        const changeDate = new Date(snapshot.timestamp);
        if (changeDate > afterDate) {
          allChanges.push({ ...snapshot, sessionId });
        }
      }
    } catch {
      continue;
    }
  }

  if (allChanges.length === 0) {
    ctx.ui.write(`No changes found after: ${after}\n`);
    return { exitCode: 0, response: { success: true, changesRolledBack: 0 } };
  }

  // Group by file
  const byFile = new Map<string, any[]>();
  for (const change of allChanges) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }
    byFile.get(change.filePath)!.push(change);
  }

  if (flags.dryRun) {
    ctx.ui.write(`[DRY RUN] Would rollback changes after: ${after}\n`);
    ctx.ui.write(`  Files affected: ${byFile.size}\n`);
    ctx.ui.write(`  Total changes: ${allChanges.length}\n`);
  } else {
    let rolledBack = 0;

    for (const [filePath, fileChanges] of byFile.entries()) {
      // Sort by timestamp (oldest first)
      fileChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const earliestChange = fileChanges[0]!;

      try {
        if (earliestChange.before) {
          const fullPath = path.join(process.cwd(), filePath);
          await fs.writeFile(fullPath, earliestChange.before.content, 'utf-8');
          rolledBack++;
        } else {
          // File was created - delete it
          const fullPath = path.join(process.cwd(), filePath);
          await fs.unlink(fullPath);
          rolledBack++;
        }
      } catch (err) {
        ctx.ui.write(`⚠️  Failed to rollback ${filePath}: ${err}\n`);
      }
    }

    ctx.ui.write(`✅ Rolled back ${rolledBack} files after: ${after}\n`);
  }

  const response = {
    success: true,
    action: 'rollback-after',
    after,
    filesAffected: byFile.size,
    changesRolledBack: allChanges.length,
    dryRun: flags.dryRun || false,
  };

  if (flags.json) {
    ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
  }

  return { exitCode: 0, response };
}
