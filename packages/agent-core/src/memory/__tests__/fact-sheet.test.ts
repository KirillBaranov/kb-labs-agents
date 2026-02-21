import { describe, it, expect, beforeEach } from 'vitest';
import { FactSheet } from '../fact-sheet';
import type { FactCategory } from '@kb-labs/agent-contracts';

describe('FactSheet', () => {
  let sheet: FactSheet;

  beforeEach(() => {
    sheet = new FactSheet({ maxTokens: 5000, maxEntries: 60 });
  });

  // ── Core CRUD ──────────────────────────────────────────────────────

  describe('addFact()', () => {
    it('should add a fact and return entry with id', () => {
      const { entry, merged } = sheet.addFact({
        category: 'finding',
        fact: 'Found 3 TODO items in src/index.ts',
        confidence: 0.8,
        source: 'grep_search',
        iteration: 1,
      });

      expect(merged).toBe(false);
      expect(entry.id).toMatch(/^fact_\d+$/);
      expect(entry.category).toBe('finding');
      expect(entry.fact).toBe('Found 3 TODO items in src/index.ts');
      expect(entry.confidence).toBe(0.8);
      expect(entry.confirmations).toBe(1);
      expect(entry.updatedAt).toBeTruthy();
    });

    it('should handle supersedes by removing old fact', () => {
      const { entry: first } = sheet.addFact({
        category: 'finding',
        fact: 'Old fact',
        confidence: 0.5,
        source: 'test',
        iteration: 1,
      });

      sheet.addFact({
        category: 'correction',
        fact: 'Updated understanding',
        confidence: 0.9,
        source: 'test',
        iteration: 2,
        supersedes: first.id,
      });

      expect(sheet.getAllFacts()).toHaveLength(1);
      expect(sheet.getAllFacts()[0]!.category).toBe('correction');
    });
  });

  describe('removeFact()', () => {
    it('should remove an existing fact and return true', () => {
      const { entry } = sheet.addFact({
        category: 'finding',
        fact: 'test fact',
        confidence: 0.5,
        source: 'test',
        iteration: 1,
      });

      expect(sheet.removeFact(entry.id)).toBe(true);
      expect(sheet.getAllFacts()).toHaveLength(0);
    });

    it('should return false for non-existent id', () => {
      expect(sheet.removeFact('nonexistent')).toBe(false);
    });
  });

  describe('getAllFacts()', () => {
    it('should return facts sorted by category priority then recency', () => {
      sheet.addFact({ category: 'finding', fact: 'a finding', confidence: 0.7, source: 't', iteration: 1 });
      sheet.addFact({ category: 'correction', fact: 'a correction', confidence: 0.9, source: 't', iteration: 2 });
      sheet.addFact({ category: 'tool_result', fact: 'a tool result', confidence: 0.6, source: 't', iteration: 3 });

      const all = sheet.getAllFacts();
      expect(all).toHaveLength(3);
      expect(all[0]!.category).toBe('correction'); // highest priority
      expect(all[1]!.category).toBe('finding');
      expect(all[2]!.category).toBe('tool_result'); // lowest priority
    });

    it('should sort by recency within same category (newest first)', () => {
      sheet.addFact({ category: 'finding', fact: 'first', confidence: 0.7, source: 't', iteration: 1 });
      sheet.addFact({ category: 'finding', fact: 'second', confidence: 0.7, source: 't', iteration: 5 });
      sheet.addFact({ category: 'finding', fact: 'third', confidence: 0.7, source: 't', iteration: 3 });

      const all = sheet.getAllFacts();
      expect(all[0]!.fact).toBe('second'); // iter 5
      expect(all[1]!.fact).toBe('third'); // iter 3
      expect(all[2]!.fact).toBe('first'); // iter 1
    });
  });

  describe('getByCategory()', () => {
    it('should return only facts of the specified category', () => {
      sheet.addFact({ category: 'finding', fact: 'f1', confidence: 0.7, source: 't', iteration: 1 });
      sheet.addFact({ category: 'blocker', fact: 'b1', confidence: 0.9, source: 't', iteration: 2 });
      sheet.addFact({ category: 'finding', fact: 'f2', confidence: 0.6, source: 't', iteration: 3 });

      const findings = sheet.getByCategory('finding');
      expect(findings).toHaveLength(2);
      expect(findings.every((f) => f.category === 'finding')).toBe(true);
    });
  });

  // ── Dedup & Merge ─────────────────────────────────────────────────

  describe('deduplication', () => {
    it('should merge facts with same file path in file_content category', () => {
      // file_content dedup is by extracted file path (not word overlap)
      sheet.addFact({
        category: 'file_content',
        fact: 'Read src/utils.ts (50 lines). Contains helper functions',
        confidence: 0.8,
        source: 'fs_read',
        iteration: 1,
      });

      const { merged } = sheet.addFact({
        category: 'file_content',
        fact: 'Read src/utils.ts (50 lines). Contains helper functions and exports init',
        confidence: 0.85,
        source: 'fs_read',
        iteration: 3,
      });

      expect(merged).toBe(true);
      expect(sheet.getAllFacts()).toHaveLength(1);

      const fact = sheet.getAllFacts()[0]!;
      expect(fact.confirmations).toBe(2);
      expect(fact.confidence).toBe(0.85); // max of two
      // Longer text wins
      expect(fact.fact).toContain('exports init');
    });

    it('should NOT merge facts with <60% word overlap', () => {
      sheet.addFact({
        category: 'finding',
        fact: 'The authentication module uses JWT tokens',
        confidence: 0.8,
        source: 'test',
        iteration: 1,
      });

      const { merged } = sheet.addFact({
        category: 'finding',
        fact: 'The database layer uses Prisma ORM for queries',
        confidence: 0.7,
        source: 'test',
        iteration: 2,
      });

      expect(merged).toBe(false);
      expect(sheet.getAllFacts()).toHaveLength(2);
    });

    it('should NOT merge facts in different categories even with high overlap', () => {
      sheet.addFact({
        category: 'finding',
        fact: 'Read src/utils.ts has 50 lines with helper functions',
        confidence: 0.8,
        source: 'test',
        iteration: 1,
      });

      const { merged } = sheet.addFact({
        category: 'file_content',
        fact: 'Read src/utils.ts has 50 lines with helper functions',
        confidence: 0.8,
        source: 'test',
        iteration: 2,
      });

      expect(merged).toBe(false);
      expect(sheet.getAllFacts()).toHaveLength(2);
    });
  });

  // ── Token Budget & Eviction ───────────────────────────────────────

  describe('eviction', () => {
    it('should evict when exceeding maxEntries', () => {
      const tinySheet = new FactSheet({ maxTokens: 100000, maxEntries: 3 });

      // Use different categories and distinct texts to prevent dedup
      tinySheet.addFact({ category: 'finding', fact: 'Authentication module uses JWT tokens for session management', confidence: 0.5, source: 't', iteration: 1 });
      tinySheet.addFact({ category: 'architecture', fact: 'Database layer uses PostgreSQL with Prisma ORM adapter', confidence: 0.6, source: 't', iteration: 2 });
      tinySheet.addFact({ category: 'tool_result', fact: 'Grep search revealed fifteen TODO comments in source code', confidence: 0.7, source: 't', iteration: 3 });
      tinySheet.addFact({ category: 'environment', fact: 'Node runtime version eighteen with TypeScript five point three', confidence: 0.8, source: 't', iteration: 4 });

      expect(tinySheet.getAllFacts()).toHaveLength(3);
      // The lowest confidence fact (0.5, finding about auth) should be evicted
      expect(tinySheet.getAllFacts().some((f) => f.fact.includes('Authentication'))).toBe(false);
    });

    it('should NEVER evict correction or blocker categories', () => {
      const tinySheet = new FactSheet({ maxTokens: 100000, maxEntries: 2 });

      tinySheet.addFact({ category: 'correction', fact: 'critical correction', confidence: 0.1, source: 't', iteration: 1 });
      tinySheet.addFact({ category: 'blocker', fact: 'critical blocker', confidence: 0.1, source: 't', iteration: 2 });
      tinySheet.addFact({ category: 'finding', fact: 'regular finding', confidence: 0.9, source: 't', iteration: 3 });

      const all = tinySheet.getAllFacts();
      expect(all).toHaveLength(2);
      // correction and blocker should survive despite lowest confidence
      const categories = all.map((f) => f.category);
      expect(categories).toContain('correction');
      expect(categories).toContain('blocker');
    });

    it('should evict by lowest confidence → fewest confirmations → oldest iteration', () => {
      const tinySheet = new FactSheet({ maxTokens: 100000, maxEntries: 2 });

      // Same confidence, same confirmations — oldest iteration evicted
      tinySheet.addFact({ category: 'finding', fact: 'old fact iter one', confidence: 0.5, source: 't', iteration: 1 });
      tinySheet.addFact({ category: 'tool_result', fact: 'new fact iter five', confidence: 0.5, source: 't', iteration: 5 });
      tinySheet.addFact({ category: 'architecture', fact: 'newest fact iter ten', confidence: 0.5, source: 't', iteration: 10 });

      const all = tinySheet.getAllFacts();
      expect(all).toHaveLength(2);
      // Oldest (iter 1) should be evicted
      expect(all.some((f) => f.fact.includes('old fact'))).toBe(false);
    });
  });

  // ── Rendering ─────────────────────────────────────────────────────

  describe('render()', () => {
    it('should return empty string for empty sheet', () => {
      expect(sheet.render()).toBe('');
    });

    it('should render markdown with categories in priority order', () => {
      sheet.addFact({ category: 'finding', fact: 'A finding', confidence: 0.7, source: 't', iteration: 1 });
      sheet.addFact({ category: 'correction', fact: 'A correction', confidence: 0.9, source: 't', iteration: 2 });
      sheet.addFact({ category: 'tool_result', fact: 'A tool result', confidence: 0.5, source: 't', iteration: 3 });

      const rendered = sheet.render();
      const correctionIdx = rendered.indexOf('Corrections');
      const findingIdx = rendered.indexOf('Findings');
      const toolIdx = rendered.indexOf('Tool Results');

      expect(correctionIdx).toBeLessThan(findingIdx);
      expect(findingIdx).toBeLessThan(toolIdx);
    });

    it('should include confidence annotation for low-confidence facts', () => {
      // Use completely distinct text to avoid dedup
      sheet.addFact({ category: 'finding', fact: 'Database uses PostgreSQL version fourteen', confidence: 0.5, source: 't', iteration: 1 });
      sheet.addFact({ category: 'architecture', fact: 'Authentication module relies on JWT tokens', confidence: 0.9, source: 't', iteration: 2 });

      const rendered = sheet.render();
      expect(rendered).toContain('[conf:0.5]');
      expect(rendered).not.toContain('[conf:0.9]');
    });
  });

  // ── Serialization ─────────────────────────────────────────────────

  describe('toJSON() / fromJSON()', () => {
    it('should roundtrip all facts', () => {
      sheet.addFact({ category: 'finding', fact: 'The API uses REST with JSON responses', confidence: 0.7, source: 'test', iteration: 1 });
      sheet.addFact({ category: 'blocker', fact: 'Cannot deploy without fixing circular dependency', confidence: 0.9, source: 'test', iteration: 2 });

      const json = sheet.toJSON();
      const restored = FactSheet.fromJSON(json, { maxTokens: 5000, maxEntries: 60 });

      expect(restored.getAllFacts()).toHaveLength(2);
      expect(restored.getAllFacts()[0]!.category).toBe('blocker'); // priority order
    });

    it('should preserve nextId across roundtrip', () => {
      sheet.addFact({ category: 'finding', fact: 'First unique discovery about modules', confidence: 0.7, source: 'test', iteration: 1 });

      const json = sheet.toJSON();
      // After 1 addFact, nextId should be 2
      expect(json.nextId).toBe(2);

      const restored = FactSheet.fromJSON(json, { maxTokens: 5000, maxEntries: 60 });
      const { entry } = restored.addFact({ category: 'architecture', fact: 'Completely different architecture finding', confidence: 0.5, source: 'test', iteration: 3 });
      // Should continue from nextId=2 → fact_2
      expect(entry.id).toBe('fact_2');
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('should return correct stats', () => {
      sheet.addFact({ category: 'finding', fact: 'f1', confidence: 0.7, source: 't', iteration: 1 });
      sheet.addFact({ category: 'finding', fact: 'f2', confidence: 0.6, source: 't', iteration: 2 });
      sheet.addFact({ category: 'blocker', fact: 'b1', confidence: 0.9, source: 't', iteration: 3 });

      const stats = sheet.getStats();
      expect(stats.totalFacts).toBe(3);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
      expect(stats.byCategory).toEqual({ finding: 2, blocker: 1 });
    });
  });
});
