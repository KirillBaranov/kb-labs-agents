import { describe, it, expect, beforeEach } from 'vitest';
import { FileTracker } from '../file-tracker.js';

describe('FileTracker', () => {
  let tracker: FileTracker;

  beforeEach(() => {
    tracker = new FileTracker();
  });

  describe('markRead', () => {
    it('tracks read files', () => {
      tracker.markRead('/a.ts', 'hash1', 100, 50);
      expect(tracker.filesRead.has('/a.ts')).toBe(true);
    });

    it('stores content hash', () => {
      tracker.markRead('/a.ts', 'abc123', 100, 50);
      expect(tracker.getReadHash('/a.ts')).toBe('abc123');
    });

    it('returns undefined hash for unread files', () => {
      expect(tracker.getReadHash('/unknown.ts')).toBeUndefined();
    });

    it('tracks smallest read window', () => {
      tracker.markRead('/a.ts', 'h1', 100, 50);
      tracker.markRead('/a.ts', 'h2', 100, 30);
      tracker.markRead('/a.ts', 'h3', 100, 80);
      const meta = tracker.getReadMeta('/a.ts');
      expect(meta?.smallestReadWindow).toBe(30);
    });

    it('increments read attempts', () => {
      tracker.markRead('/a.ts', 'h', 100, 50);
      tracker.markRead('/a.ts', 'h', 100, 50);
      tracker.markRead('/a.ts', 'h', 100, 50);
      const meta = tracker.getReadMeta('/a.ts');
      expect(meta?.readAttempts).toBe(3);
    });

    it('returns full read meta', () => {
      tracker.markRead('/a.ts', 'hash1', 200, 40);
      const meta = tracker.getReadMeta('/a.ts');
      expect(meta).toEqual({
        hash: 'hash1',
        totalLines: 200,
        smallestReadWindow: 40,
        readAttempts: 1,
      });
    });

    it('returns undefined meta for unread files', () => {
      expect(tracker.getReadMeta('/unknown.ts')).toBeUndefined();
    });
  });

  describe('markCreated / markModified', () => {
    it('tracks created files', () => {
      tracker.markCreated('/new.ts');
      expect(tracker.filesCreated.has('/new.ts')).toBe(true);
    });

    it('tracks modified files', () => {
      tracker.markModified('/existing.ts');
      expect(tracker.filesModified.has('/existing.ts')).toBe(true);
    });
  });

  describe('totalFilesTouched', () => {
    it('counts union of all file sets', () => {
      tracker.markRead('/a.ts', 'h', 10, 10);
      tracker.markCreated('/b.ts');
      tracker.markModified('/c.ts');
      expect(tracker.totalFilesTouched).toBe(3);
    });

    it('deduplicates across sets', () => {
      tracker.markRead('/a.ts', 'h', 10, 10);
      tracker.markModified('/a.ts');
      expect(tracker.totalFilesTouched).toBe(1);
    });
  });

  describe('snapshot', () => {
    it('returns immutable snapshot', () => {
      tracker.markRead('/a.ts', 'h', 10, 10);
      tracker.markCreated('/b.ts');
      const snap = tracker.snapshot();

      // Mutate original
      tracker.markRead('/c.ts', 'h2', 20, 20);

      // Snapshot should be unchanged
      expect(snap.filesRead.size).toBe(1);
      expect(snap.totalFilesTouched).toBe(2);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      tracker.markRead('/a.ts', 'h', 10, 10);
      tracker.markCreated('/b.ts');
      tracker.markModified('/c.ts');
      tracker.clear();

      expect(tracker.filesRead.size).toBe(0);
      expect(tracker.filesCreated.size).toBe(0);
      expect(tracker.filesModified.size).toBe(0);
      expect(tracker.totalFilesTouched).toBe(0);
      expect(tracker.getReadHash('/a.ts')).toBeUndefined();
    });
  });
});
