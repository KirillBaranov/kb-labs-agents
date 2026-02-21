/**
 * File Change Tracker - captures and manages file change history
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FileChange, RollbackResult, ConflictInfo } from './types.js';
import type { SnapshotStorage } from './snapshot-storage.js';

/**
 * Generate unique change ID
 */
function generateChangeId(): string {
  return `change-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * File Change Tracker
 *
 * Captures snapshots of file changes and provides rollback capabilities
 */
export class FileChangeTracker extends EventEmitter {
  private sessionId: string;
  private agentId: string;
  private workingDir: string;
  private storage: SnapshotStorage;
  private changes: FileChange[] = [];
  private runId?: string;

  constructor(
    sessionId: string,
    agentId: string,
    workingDir: string,
    storage: SnapshotStorage
  ) {
    super();
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.workingDir = workingDir;
    this.storage = storage;
  }

  /**
   * Set the run ID — call this right after an agent run starts.
   * All changes captured after this call will be tagged with the given runId.
   */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  /**
   * Capture file change with before/after snapshots
   */
  async captureChange(
    filePath: string,
    operation: 'write' | 'patch' | 'delete',
    beforeContent: string | null,
    afterContent: string,
    metadata?: Record<string, unknown>
  ): Promise<FileChange> {
    const changeId = generateChangeId();

    // Build snapshot
    const change: FileChange = {
      id: changeId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      runId: this.runId,
      filePath,
      operation,
      timestamp: new Date().toISOString(),

      before: beforeContent
        ? {
            content: beforeContent,
            hash: computeHash(beforeContent),
            size: Buffer.byteLength(beforeContent, 'utf-8'),
          }
        : undefined,

      after: {
        content: afterContent,
        hash: computeHash(afterContent),
        size: Buffer.byteLength(afterContent, 'utf-8'),
      },

      metadata: metadata as FileChange['metadata'],
    };

    // Save to storage
    await this.storage.saveSnapshot(this.sessionId, change);

    // Add to in-memory cache
    this.changes.push(change);

    // Emit event
    this.emit('file:changed', change);

    return change;
  }

  /**
   * Get all changes for current session
   */
  getChanges(): FileChange[] {
    return this.changes;
  }

  /**
   * Get all changes for current session (alias for getChanges)
   */
  getHistory(): FileChange[] {
    return this.changes;
  }

  /**
   * Get change history for specific file
   */
  getFileHistory(filePath: string): FileChange[] {
    return this.changes.filter((c) => c.filePath === filePath);
  }

  /**
   * Get list of unique files that have been changed
   */
  getChangedFiles(): string[] {
    return [...new Set(this.changes.map((c) => c.filePath))];
  }

  /**
   * Get change by ID
   */
  async getChange(changeId: string): Promise<FileChange | null> {
    // Check in-memory cache first
    const cached = this.changes.find((c) => c.id === changeId);
    if (cached) {
      return cached;
    }

    // Load from storage
    return this.storage.loadSnapshot(this.sessionId, changeId);
  }

  /**
   * Rollback file to previous state (removes latest change)
   */
  async rollbackFile(filePath: string): Promise<boolean> {
    // Find latest change for this file
    const fileHistory = this.getFileHistory(filePath);
    if (fileHistory.length === 0) {
      return false;
    }

    const change = fileHistory[fileHistory.length - 1]!; // Non-null assertion safe after length check
    const fullPath = path.join(this.workingDir, change.filePath);

    // Restore file to before state
    if (change.operation === 'delete') {
      // Restore deleted file
      if (!change.before) {
        throw new Error('Cannot restore deleted file: no before snapshot');
      }
      await fs.promises.writeFile(fullPath, change.before.content, 'utf-8');
    } else {
      // Restore to before state (or delete if it was a new file)
      if (change.before) {
        await fs.promises.writeFile(fullPath, change.before.content, 'utf-8');
      } else {
        // New file - delete it
        try {
          await fs.promises.unlink(fullPath);
        } catch (error) {
          // Ignore if file doesn't exist
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
    }

    // Remove latest change from history
    this.changes = this.changes.filter((c) => c.id !== change.id);

    // Emit rollback event
    this.emit('file:rolled-back', {
      changeId: change.id,
      filePath: change.filePath,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Rollback all changes by specific agent
   */
  async rollbackAgent(
    targetAgentId: string,
    options?: {
      skipConflicts?: boolean;
      forceOverwrite?: boolean;
    }
  ): Promise<RollbackResult> {
    const agentChanges = this.changes
      .filter((c) => c.agentId === targetAgentId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const conflicts: ConflictInfo[] = [];
    let rolledBack = 0;
    let skipped = 0;

    // Load all changes from storage to detect conflicts with other agents
    const allChanges = await this.storage.listSnapshots(this.sessionId);

    for (const change of agentChanges) {
      // Check if file was modified after this change by ANY agent (including other instances)
      const laterChanges = allChanges
        .filter((c) => c.filePath === change.filePath)
        .filter((c) => new Date(c.timestamp).getTime() > new Date(change.timestamp).getTime());

      if (laterChanges.length > 0 && !options?.forceOverwrite) {
        // Conflict detected
        const laterAgents = [...new Set(laterChanges.map((c) => c.agentId))];

        conflicts.push({
          filePath: change.filePath,
          change,
          laterModifiedBy: laterAgents,
        });

        if (options?.skipConflicts) {
          skipped++;
          continue; // Skip this file
        }
      }

      // Rollback file - directly manipulate changes array since we need to remove specific change
      const fullPath = path.join(this.workingDir, change.filePath);

      try {
        // Restore to before state
        if (change.before) {
          await fs.promises.writeFile(fullPath, change.before.content, 'utf-8');
        } else {
          // New file - delete it
          try {
            await fs.promises.unlink(fullPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
        }

        // Remove this change from history
        this.changes = this.changes.filter((c) => c.id !== change.id);
        rolledBack++;
      } catch (error) {
        console.error(`[FileChangeTracker] Failed to rollback ${change.filePath}:`, error);
      }
    }

    return {
      rolledBack,
      skipped,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  /**
   * Rollback all changes after specific timestamp
   */
  async rollbackAfter(timestamp: string): Promise<RollbackResult> {
    const targetTime = new Date(timestamp).getTime();

    const recentChanges = this.changes
      .filter((c) => new Date(c.timestamp).getTime() > targetTime)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    let rolledBack = 0;

    for (const change of recentChanges) {
      // Remove from array
      this.changes = this.changes.filter((c) => c.id !== change.id);
      rolledBack++;
    }

    return {
      rolledBack,
      skipped: 0,
    };
  }

  /**
   * Load existing changes from storage
   */
  async loadFromStorage(): Promise<void> {
    this.changes = await this.storage.listSnapshots(this.sessionId);
  }

  /**
   * Clear all changes from memory (does not affect disk storage)
   */
  clear(): void {
    this.changes = [];
  }

  /**
   * Cleanup old sessions
   */
  async cleanup(): Promise<{ deleted: number; keptLast: number }> {
    return this.storage.cleanupOldSessions();
  }
}
