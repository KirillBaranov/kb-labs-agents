import { describe, it, expect, beforeEach } from 'vitest';
import { ArchiveMemory } from '../archive-memory';

describe('ArchiveMemory', () => {
  let archive: ArchiveMemory;

  beforeEach(() => {
    archive = new ArchiveMemory({ maxEntries: 200, maxTotalChars: 2_000_000 });
  });

  // ── Store & Recall ────────────────────────────────────────────────

  describe('store()', () => {
    it('should store an entry and return it with id', () => {
      const { entry, evicted } = archive.store({
        iteration: 1,
        toolName: 'fs_read',
        toolInput: { path: '/src/index.ts' },
        fullOutput: 'export function init() {}',
        filePath: '/src/index.ts',
      });

      expect(entry.id).toMatch(/^archive_\d+$/);
      expect(entry.toolName).toBe('fs_read');
      expect(entry.outputLength).toBe(25);
      expect(entry.estimatedTokens).toBeGreaterThan(0);
      expect(evicted).toBe(0);
    });
  });

  describe('recallByFilePath()', () => {
    it('should return the MOST RECENT read of a file', () => {
      archive.store({
        iteration: 1,
        toolName: 'fs_read',
        toolInput: { path: '/src/index.ts' },
        fullOutput: 'version 1 content',
        filePath: '/src/index.ts',
      });

      archive.store({
        iteration: 5,
        toolName: 'fs_read',
        toolInput: { path: '/src/index.ts' },
        fullOutput: 'version 2 content (updated)',
        filePath: '/src/index.ts',
      });

      const result = archive.recallByFilePath('/src/index.ts');
      expect(result).not.toBeNull();
      expect(result!.fullOutput).toBe('version 2 content (updated)');
      expect(result!.iteration).toBe(5);
    });

    it('should return null for non-archived file', () => {
      expect(archive.recallByFilePath('/nonexistent.ts')).toBeNull();
    });
  });

  describe('recallAllByFilePath()', () => {
    it('should return all reads in chronological order', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'v1', filePath: '/a.ts' });
      archive.store({ iteration: 3, toolName: 'fs_read', toolInput: {}, fullOutput: 'v2', filePath: '/a.ts' });
      archive.store({ iteration: 2, toolName: 'fs_read', toolInput: {}, fullOutput: 'other', filePath: '/b.ts' });

      const all = archive.recallAllByFilePath('/a.ts');
      expect(all).toHaveLength(2);
      expect(all[0]!.fullOutput).toBe('v1');
      expect(all[1]!.fullOutput).toBe('v2');
    });
  });

  describe('recallByToolName()', () => {
    it('should return recent outputs of a specific tool', () => {
      archive.store({ iteration: 1, toolName: 'grep_search', toolInput: { pattern: 'TODO' }, fullOutput: 'match1' });
      archive.store({ iteration: 2, toolName: 'fs_read', toolInput: { path: '/a.ts' }, fullOutput: 'file content' });
      archive.store({ iteration: 3, toolName: 'grep_search', toolInput: { pattern: 'FIXME' }, fullOutput: 'match2' });

      const results = archive.recallByToolName('grep_search', 5);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.toolName === 'grep_search')).toBe(true);
    });
  });

  describe('recallByIteration()', () => {
    it('should return all outputs from a specific iteration', () => {
      archive.store({ iteration: 3, toolName: 'fs_read', toolInput: {}, fullOutput: 'read result' });
      archive.store({ iteration: 3, toolName: 'grep_search', toolInput: {}, fullOutput: 'grep result' });
      archive.store({ iteration: 4, toolName: 'fs_read', toolInput: {}, fullOutput: 'different iter' });

      const results = archive.recallByIteration(3);
      expect(results).toHaveLength(2);
    });
  });

  describe('search()', () => {
    it('should keyword search across all archived outputs', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'This file has a TODO comment' });
      archive.store({ iteration: 2, toolName: 'fs_read', toolInput: {}, fullOutput: 'Clean code here' });
      archive.store({ iteration: 3, toolName: 'grep_search', toolInput: {}, fullOutput: 'Found TODO in line 5' });

      const results = archive.search('TODO');
      expect(results).toHaveLength(2);
    });

    it('should be case-insensitive', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'Interface definition' });

      expect(archive.search('interface')).toHaveLength(1);
      expect(archive.search('INTERFACE')).toHaveLength(1);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        archive.store({ iteration: i, toolName: 'test', toolInput: {}, fullOutput: `match ${i}` });
      }
      expect(archive.search('match', 3)).toHaveLength(3);
    });
  });

  // ── Index Consistency ─────────────────────────────────────────────

  describe('index consistency', () => {
    it('should track files in hasFile() and getArchivedFilePaths()', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'content', filePath: '/a.ts' });
      archive.store({ iteration: 2, toolName: 'fs_read', toolInput: {}, fullOutput: 'content', filePath: '/b.ts' });

      expect(archive.hasFile('/a.ts')).toBe(true);
      expect(archive.hasFile('/c.ts')).toBe(false);
      expect(archive.getArchivedFilePaths()).toContain('/a.ts');
      expect(archive.getArchivedFilePaths()).toContain('/b.ts');
      expect(archive.getArchivedFilePaths()).toHaveLength(2);
    });
  });

  // ── Eviction ──────────────────────────────────────────────────────

  describe('eviction', () => {
    it('should evict oldest entries when exceeding maxEntries', () => {
      const small = new ArchiveMemory({ maxEntries: 3, maxTotalChars: 10_000_000 });

      small.store({ iteration: 1, toolName: 't', toolInput: {}, fullOutput: 'old' });
      small.store({ iteration: 2, toolName: 't', toolInput: {}, fullOutput: 'mid' });
      small.store({ iteration: 3, toolName: 't', toolInput: {}, fullOutput: 'new' });
      const { evicted } = small.store({ iteration: 4, toolName: 't', toolInput: {}, fullOutput: 'newest' });

      expect(evicted).toBe(1);
      expect(small.getStats().totalEntries).toBe(3);
      // Oldest (iter 1) should be evicted
      expect(small.recallByIteration(1)).toHaveLength(0);
    });

    it('should evict when exceeding maxTotalChars', () => {
      const small = new ArchiveMemory({ maxEntries: 100, maxTotalChars: 30 });

      small.store({ iteration: 1, toolName: 't', toolInput: {}, fullOutput: '0123456789' }); // 10 chars
      small.store({ iteration: 2, toolName: 't', toolInput: {}, fullOutput: '0123456789' }); // 10 chars
      small.store({ iteration: 3, toolName: 't', toolInput: {}, fullOutput: '0123456789' }); // 10 chars → 30 total
      const { evicted } = small.store({ iteration: 4, toolName: 't', toolInput: {}, fullOutput: '0123456789' }); // 10 → 40 total

      expect(evicted).toBeGreaterThan(0);
      expect(small.getStats().totalChars).toBeLessThanOrEqual(30);
    });

    it('should clean up indices after eviction', () => {
      const small = new ArchiveMemory({ maxEntries: 2, maxTotalChars: 10_000_000 });

      small.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'content', filePath: '/evicted.ts' });
      small.store({ iteration: 2, toolName: 't', toolInput: {}, fullOutput: 'keep1' });
      small.store({ iteration: 3, toolName: 't', toolInput: {}, fullOutput: 'keep2' });

      // /evicted.ts entry was evicted
      expect(small.hasFile('/evicted.ts')).toBe(false);
    });
  });

  // ── Summary Hint ──────────────────────────────────────────────────

  describe('getSummaryHint()', () => {
    it('should return empty string for empty archive', () => {
      expect(archive.getSummaryHint()).toBe('');
    });

    it('should return compact summary', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'x'.repeat(1000), filePath: '/a.ts' });
      archive.store({ iteration: 2, toolName: 'grep_search', toolInput: {}, fullOutput: 'y'.repeat(500) });

      const hint = archive.getSummaryHint();
      expect(hint).toContain('1 files');
      expect(hint).toContain('2 tool outputs');
      expect(hint).toContain('archive_recall');
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('should return correct stats', () => {
      archive.store({ iteration: 1, toolName: 'fs_read', toolInput: {}, fullOutput: 'abcde', filePath: '/a.ts' });
      archive.store({ iteration: 2, toolName: 'grep', toolInput: {}, fullOutput: 'xyz' });

      const stats = archive.getStats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.totalChars).toBe(8);
      expect(stats.uniqueFiles).toBe(1);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────

  describe('persist() / load()', () => {
    it('should roundtrip through persistence', async () => {
      const { tmpdir } = await import('node:os');
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');

      const dir = mkdtempSync(join(tmpdir(), 'archive-test-'));
      const persistable = new ArchiveMemory({ persistDir: dir });

      persistable.store({
        iteration: 1,
        toolName: 'fs_read',
        toolInput: { path: '/src/index.ts' },
        fullOutput: 'export function init() {}',
        filePath: '/src/index.ts',
      });

      persistable.store({
        iteration: 2,
        toolName: 'grep_search',
        toolInput: { pattern: 'TODO' },
        fullOutput: 'line 5: // TODO fix this',
      });

      await persistable.persist();

      // Load from disk
      const loaded = await ArchiveMemory.load({ persistDir: dir });
      expect(loaded.getStats().totalEntries).toBe(2);
      expect(loaded.hasFile('/src/index.ts')).toBe(true);
      expect(loaded.recallByFilePath('/src/index.ts')?.fullOutput).toBe('export function init() {}');
    });
  });
});
