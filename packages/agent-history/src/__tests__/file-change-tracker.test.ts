/**
 * Unit tests for FileChangeTracker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileChangeTracker } from '../file-change-tracker';
import { SnapshotStorage } from '../snapshot-storage';

describe('FileChangeTracker', () => {
  const testBasePath = path.join(__dirname, '.tmp-test-history');
  const sessionId = 'test-session-123';
  const agentId = 'test-agent';

  let tracker: FileChangeTracker;
  let storage: SnapshotStorage;

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }

    storage = new SnapshotStorage(testBasePath);
    tracker = new FileChangeTracker(sessionId, agentId, testBasePath, storage);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  describe('captureChange', () => {
    it('should capture write operation for new file', async () => {
      const change = await tracker.captureChange(
        'test.ts',
        'write',
        null,
        'console.log("hello");',
        { isOverwrite: false }
      );

      expect(change.id).toMatch(/^change-/);
      expect(change.sessionId).toBe(sessionId);
      expect(change.agentId).toBe(agentId);
      expect(change.filePath).toBe('test.ts');
      expect(change.operation).toBe('write');
      expect(change.before).toBeUndefined();
      expect(change.after.content).toBe('console.log("hello");');
      expect(change.after.hash).toBeDefined();
      expect(change.after.size).toBe(Buffer.byteLength('console.log("hello");', 'utf-8'));
      expect(change.metadata?.isOverwrite).toBe(false);
    });

    it('should capture write operation for overwrite', async () => {
      const beforeContent = 'const x = 1;';
      const afterContent = 'const x = 2;';

      const change = await tracker.captureChange(
        'test.ts',
        'write',
        beforeContent,
        afterContent,
        { isOverwrite: true }
      );

      expect(change.before).toBeDefined();
      expect(change.before?.content).toBe(beforeContent);
      expect(change.before?.hash).toBeDefined();
      expect(change.after.content).toBe(afterContent);
      expect(change.metadata?.isOverwrite).toBe(true);
    });

    it('should capture patch operation with line metadata', async () => {
      const beforeContent = 'line1\nline2\nline3\nline4';
      const afterContent = 'line1\nNEW_LINE\nline3\nline4';

      const change = await tracker.captureChange(
        'test.ts',
        'patch',
        beforeContent,
        afterContent,
        {
          startLine: 2,
          endLine: 2,
          linesAdded: 1,
          linesRemoved: 1,
        }
      );

      expect(change.operation).toBe('patch');
      expect(change.metadata?.startLine).toBe(2);
      expect(change.metadata?.endLine).toBe(2);
      expect(change.metadata?.linesAdded).toBe(1);
      expect(change.metadata?.linesRemoved).toBe(1);
    });

    it('should emit file:changed event', async () => {
      const eventListener = vi.fn();
      tracker.on('file:changed', eventListener);

      await tracker.captureChange(
        'test.ts',
        'write',
        null,
        'content',
        {}
      );

      expect(eventListener).toHaveBeenCalledTimes(1);
      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: 'test.ts',
          operation: 'write',
        })
      );
    });

    it('should store change in memory', async () => {
      const change = await tracker.captureChange(
        'test.ts',
        'write',
        null,
        'content',
        {}
      );

      const history = tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(change);
    });

    it('should persist change to disk', async () => {
      const change = await tracker.captureChange(
        'test.ts',
        'write',
        null,
        'content',
        {}
      );

      const loaded = await storage.loadSnapshot(sessionId, change.id);
      expect(loaded).toBeDefined();
      expect(loaded?.filePath).toBe('test.ts');
      expect(loaded?.after.content).toBe('content');
    });
  });

  describe('getHistory', () => {
    it('should return all changes in order', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'content1', {});
      await tracker.captureChange('file2.ts', 'write', null, 'content2', {});
      await tracker.captureChange('file3.ts', 'patch', 'old', 'new', {});

      const history = tracker.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.filePath).toBe('file1.ts');
      expect(history[1]!.filePath).toBe('file2.ts');
      expect(history[2]!.filePath).toBe('file3.ts');
    });

    it('should return empty array when no changes', () => {
      const history = tracker.getHistory();
      expect(history).toHaveLength(0);
    });
  });

  describe('getFileHistory', () => {
    it('should return changes for specific file', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});
      await tracker.captureChange('file2.ts', 'write', null, 'content', {});
      await tracker.captureChange('file1.ts', 'patch', 'v1', 'v2', {});

      const file1History = tracker.getFileHistory('file1.ts');
      expect(file1History).toHaveLength(2);
      expect(file1History[0]!.after.content).toBe('v1');
      expect(file1History[1]!.after.content).toBe('v2');
    });

    it('should return empty array for file with no changes', () => {
      const history = tracker.getFileHistory('nonexistent.ts');
      expect(history).toHaveLength(0);
    });
  });

  describe('getChangedFiles', () => {
    it('should return list of unique changed files', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});
      await tracker.captureChange('file2.ts', 'write', null, 'content', {});
      await tracker.captureChange('file1.ts', 'patch', 'v1', 'v2', {});

      const changedFiles = tracker.getChangedFiles();
      expect(changedFiles).toHaveLength(2);
      expect(changedFiles).toContain('file1.ts');
      expect(changedFiles).toContain('file2.ts');
    });

    it('should return empty array when no changes', () => {
      const changedFiles = tracker.getChangedFiles();
      expect(changedFiles).toHaveLength(0);
    });
  });

  describe('rollbackFile', () => {
    it('should rollback to latest change', async () => {
      await tracker.captureChange('test.ts', 'write', null, 'v1', {});
      await tracker.captureChange('test.ts', 'patch', 'v1', 'v2', {});
      await tracker.captureChange('test.ts', 'patch', 'v2', 'v3', {});

      const rolledBack = await tracker.rollbackFile('test.ts');
      expect(rolledBack).toBe(true);

      const history = tracker.getFileHistory('test.ts');
      expect(history).toHaveLength(2); // Last change removed
    });

    it('should return false if file has no changes', async () => {
      const rolledBack = await tracker.rollbackFile('nonexistent.ts');
      expect(rolledBack).toBe(false);
    });

    it('should emit file:rolled-back event', async () => {
      await tracker.captureChange('test.ts', 'write', null, 'v1', {});

      const eventListener = vi.fn();
      tracker.on('file:rolled-back', eventListener);

      await tracker.rollbackFile('test.ts');

      expect(eventListener).toHaveBeenCalledTimes(1);
      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: 'test.ts',
        })
      );
    });
  });

  describe('rollbackAgent', () => {
    it('should rollback all changes by specific agent', async () => {
      // Agent 1 changes
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});
      await tracker.captureChange('file2.ts', 'write', null, 'v1', {});

      // Agent 2 changes
      const tracker2 = new FileChangeTracker(sessionId, 'agent-2', testBasePath, storage);
      await tracker2.captureChange('file3.ts', 'write', null, 'v1', {});

      // Load all changes from storage
      const allChanges = await storage.listSnapshots(sessionId);
      expect(allChanges).toHaveLength(3);

      // Rollback agent 1
      const result = await tracker.rollbackAgent('test-agent');
      expect(result.rolledBack).toBe(2);
      expect(result.skipped).toBe(0);

      // Verify changes removed
      const history = tracker.getHistory();
      expect(history).toHaveLength(0);
    });

    it('should detect conflicts with later modifications', async () => {
      // Agent 1 modifies file
      await tracker.captureChange('test.ts', 'write', null, 'v1', {});

      // Agent 2 modifies same file
      const tracker2 = new FileChangeTracker(sessionId, 'agent-2', testBasePath, storage);
      await tracker2.captureChange('test.ts', 'patch', 'v1', 'v2', {});

      // Try to rollback agent 1 - should detect conflict
      const result = await tracker.rollbackAgent('test-agent', {
        skipConflicts: true,
      });

      expect(result.rolledBack).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts?.[0]!.filePath).toBe('test.ts');
      expect(result.conflicts?.[0]!.laterModifiedBy).toContain('agent-2');
    });

    it('should force overwrite conflicts when requested', async () => {
      // Agent 1 modifies file
      await tracker.captureChange('test.ts', 'write', null, 'v1', {});

      // Agent 2 modifies same file
      const tracker2 = new FileChangeTracker(sessionId, 'agent-2', testBasePath, storage);
      await tracker2.captureChange('test.ts', 'patch', 'v1', 'v2', {});

      // Force rollback agent 1 - should overwrite
      const result = await tracker.rollbackAgent('test-agent', {
        forceOverwrite: true,
      });

      expect(result.rolledBack).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.conflicts).toBeUndefined();
    });
  });

  describe('rollbackAfter', () => {
    it('should rollback all changes after timestamp', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});

      // Wait 10ms to ensure different timestamps
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      const cutoffTime = new Date().toISOString();
      await new Promise((resolve) => { setTimeout(resolve, 10); });

      await tracker.captureChange('file2.ts', 'write', null, 'v2', {});
      await tracker.captureChange('file3.ts', 'write', null, 'v3', {});

      const result = await tracker.rollbackAfter(cutoffTime);

      expect(result.rolledBack).toBe(2);
      expect(result.skipped).toBe(0);

      const history = tracker.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.filePath).toBe('file1.ts');
    });

    it('should return zero if no changes after timestamp', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});

      // Future timestamp
      const futureTime = new Date(Date.now() + 100000).toISOString();

      const result = await tracker.rollbackAfter(futureTime);

      expect(result.rolledBack).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all changes from memory', async () => {
      await tracker.captureChange('file1.ts', 'write', null, 'v1', {});
      await tracker.captureChange('file2.ts', 'write', null, 'v2', {});

      tracker.clear();

      const history = tracker.getHistory();
      expect(history).toHaveLength(0);
    });

    it('should not affect persisted snapshots', async () => {
      const change = await tracker.captureChange('file1.ts', 'write', null, 'v1', {});

      tracker.clear();

      // Should still be in storage
      const loaded = await storage.loadSnapshot(sessionId, change.id);
      expect(loaded).toBeDefined();
    });
  });

  describe('integration with multiple agents', () => {
    it('should track changes from different agents in same session', async () => {
      const tracker1 = new FileChangeTracker(sessionId, 'agent-1', testBasePath, storage);
      const tracker2 = new FileChangeTracker(sessionId, 'agent-2', testBasePath, storage);

      await tracker1.captureChange('file1.ts', 'write', null, 'agent1-v1', {});
      await tracker2.captureChange('file2.ts', 'write', null, 'agent2-v1', {});
      await tracker1.captureChange('file3.ts', 'write', null, 'agent1-v2', {});

      // Load all changes from storage
      const allChanges = await storage.listSnapshots(sessionId);
      expect(allChanges).toHaveLength(3);

      // Verify agent attribution
      const agent1Changes = allChanges.filter((c) => c.agentId === 'agent-1');
      const agent2Changes = allChanges.filter((c) => c.agentId === 'agent-2');

      expect(agent1Changes).toHaveLength(2);
      expect(agent2Changes).toHaveLength(1);
    });
  });
});
