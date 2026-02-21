/**
 * FactSheet - Tier 1: Hot Working Memory
 *
 * Always injected into LLM context. Stores accumulated knowledge as
 * categorized, deduplicated facts with confidence tracking.
 *
 * Features:
 * - Categorized facts with priority ordering
 * - Deduplication via word overlap (60% threshold)
 * - Token budget enforcement with smart eviction
 * - Never evicts corrections or blockers
 * - Compact markdown rendering for system prompt
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FactCategory, FactSheetEntry } from '@kb-labs/agent-contracts';
import { AGENT_MEMORY } from '../constants.js';

export interface FactSheetConfig {
  maxTokens?: number;
  maxEntries?: number;
}

/** Category render/priority order (highest priority first) */
const CATEGORY_PRIORITY: FactCategory[] = [
  'correction',
  'blocker',
  'decision',
  'finding',
  'file_content',
  'architecture',
  'tool_result',
  'environment',
];

/** Categories that are never evicted */
const PROTECTED_CATEGORIES: Set<FactCategory> = new Set(['correction', 'blocker']);

/** Minimum word overlap ratio to consider facts similar (0.0-1.0) */
const DEDUP_OVERLAP_THRESHOLD = 0.6;

/**
 * Categories where dedup is based on exact file path match, not word overlap.
 * "Read /path/to/file.ts (N lines)" facts differ only by path —
 * word overlap is artificially high due to shared path segments.
 */
const PATH_DEDUP_CATEGORIES: Set<FactCategory> = new Set(['file_content']);

interface FactSheetJSON {
  facts: Array<[string, FactSheetEntry]>;
  nextId: number;
}

export class FactSheet {
  private facts = new Map<string, FactSheetEntry>();
  private nextId = 1;
  private readonly maxTokens: number;
  private readonly maxEntries: number;

  constructor(config: FactSheetConfig = {}) {
    this.maxTokens = config.maxTokens ?? AGENT_MEMORY.factSheetMaxTokens;
    this.maxEntries = config.maxEntries ?? AGENT_MEMORY.factSheetMaxEntries;
  }

  /**
   * Add a fact to the sheet. Returns the added/merged entry and whether it was merged.
   */
  addFact(params: {
    category: FactCategory;
    fact: string;
    confidence: number;
    source: string;
    iteration: number;
    supersedes?: string;
  }): { entry: FactSheetEntry; merged: boolean } {
    // Handle supersedes — remove the old fact
    if (params.supersedes && this.facts.has(params.supersedes)) {
      this.facts.delete(params.supersedes);
    }

    // Check for similar existing fact (dedup)
    const similar = this.findSimilarFact(params.category, params.fact);
    if (similar) {
      // Merge: keep longer text, bump confidence, increment confirmations
      similar.fact = params.fact.length > similar.fact.length ? params.fact : similar.fact;
      similar.confidence = Math.min(1.0, Math.max(similar.confidence, params.confidence));
      similar.confirmations += 1;
      similar.iteration = params.iteration;
      similar.updatedAt = new Date().toISOString();
      similar.source = params.source;
      this.enforceLimit();
      return { entry: similar, merged: true };
    }

    // Create new fact
    const id = `fact_${this.nextId++}`;
    const entry: FactSheetEntry = {
      id,
      iteration: params.iteration,
      category: params.category,
      fact: params.fact,
      confidence: params.confidence,
      source: params.source,
      updatedAt: new Date().toISOString(),
      confirmations: 1,
      supersedes: params.supersedes,
    };

    this.facts.set(id, entry);
    this.enforceLimit();
    return { entry, merged: false };
  }

  /**
   * Remove a fact by ID
   */
  removeFact(id: string): boolean {
    return this.facts.delete(id);
  }

  /**
   * Get all facts sorted by category priority, then recency (newest first)
   */
  getAllFacts(): FactSheetEntry[] {
    const all = Array.from(this.facts.values());
    return all.sort((a, b) => {
      const priorityA = CATEGORY_PRIORITY.indexOf(a.category);
      const priorityB = CATEGORY_PRIORITY.indexOf(b.category);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return b.iteration - a.iteration; // newest first within category
    });
  }

  /**
   * Get facts by category
   */
  getByCategory(category: FactCategory): FactSheetEntry[] {
    return Array.from(this.facts.values())
      .filter((f) => f.category === category)
      .sort((a, b) => b.iteration - a.iteration);
  }

  /**
   * Render facts as compact markdown for system prompt injection.
   * Returns empty string if no facts.
   */
  render(): string {
    if (this.facts.size === 0) return '';

    const sorted = this.getAllFacts();
    const lines: string[] = ['# Accumulated Knowledge (FactSheet)'];

    let currentCategory: FactCategory | null = null;
    for (const fact of sorted) {
      if (fact.category !== currentCategory) {
        currentCategory = fact.category;
        lines.push(`\n## ${formatCategoryHeader(currentCategory)}`);
      }
      const conf = fact.confidence >= 0.8 ? '' : ` [conf:${fact.confidence.toFixed(1)}]`;
      lines.push(`- ${fact.fact}${conf}`);
    }

    return lines.join('\n');
  }

  /**
   * Get stats for tracing
   */
  getStats(): {
    totalFacts: number;
    estimatedTokens: number;
    byCategory: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    for (const fact of this.facts.values()) {
      byCategory[fact.category] = (byCategory[fact.category] || 0) + 1;
    }
    const rendered = this.render();
    return {
      totalFacts: this.facts.size,
      estimatedTokens: Math.ceil(rendered.length / 4),
      byCategory,
    };
  }

  /**
   * Serialize for persistence
   */
  toJSON(): FactSheetJSON {
    return {
      facts: Array.from(this.facts.entries()),
      nextId: this.nextId,
    };
  }

  /**
   * Deserialize from persistence
   */
  static fromJSON(data: FactSheetJSON, config?: FactSheetConfig): FactSheet {
    const sheet = new FactSheet(config);
    for (const [key, value] of data.facts) {
      sheet.facts.set(key, value);
    }
    sheet.nextId = data.nextId;
    return sheet;
  }

  /**
   * Persist fact sheet to disk (non-critical)
   */
  async persist(persistDir: string): Promise<void> {
    try {
      fs.mkdirSync(persistDir, { recursive: true });
      const filePath = path.join(persistDir, 'fact-sheet.json');
      fs.writeFileSync(filePath, JSON.stringify(this.toJSON()), 'utf-8');
    } catch {
      console.error('[FactSheet] Failed to persist fact sheet');
    }
  }

  /**
   * Load fact sheet from disk. Returns empty sheet if not found.
   */
  static async load(persistDir: string, config?: FactSheetConfig): Promise<FactSheet> {
    const filePath = path.join(persistDir, 'fact-sheet.json');
    try {
      if (!fs.existsSync(filePath)) return new FactSheet(config);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as FactSheetJSON;
      return FactSheet.fromJSON(data, config);
    } catch {
      return new FactSheet(config);
    }
  }

  /**
   * Find a similar fact within the same category.
   *
   * For file_content: dedup by extracted file path (exact match).
   * For other categories: 60% word overlap threshold.
   */
  private findSimilarFact(
    category: FactCategory,
    text: string
  ): FactSheetEntry | undefined {
    if (PATH_DEDUP_CATEGORIES.has(category)) {
      // Extract file path from "Read /path/to/file.ts (...)" pattern
      const inputPath = extractFilePath(text);
      if (!inputPath) return undefined;

      for (const fact of this.facts.values()) {
        if (fact.category !== category) continue;
        const factPath = extractFilePath(fact.fact);
        if (factPath && factPath === inputPath) return fact;
      }
      return undefined;
    }

    const inputWords = extractWords(text);
    if (inputWords.size === 0) return undefined;

    for (const fact of this.facts.values()) {
      if (fact.category !== category) continue;

      const factWords = extractWords(fact.fact);
      if (factWords.size === 0) continue;

      const overlap = wordOverlap(inputWords, factWords);
      if (overlap >= DEDUP_OVERLAP_THRESHOLD) {
        return fact;
      }
    }
    return undefined;
  }

  /**
   * Enforce entry count and token budget limits via eviction
   */
  private enforceLimit(): void {
    // Evict by entry count
    while (this.facts.size > this.maxEntries) {
      this.evictLowestPriority();
    }

    // Evict by token budget
    while (this.facts.size > 0) {
      const rendered = this.render();
      const estimatedTokens = Math.ceil(rendered.length / 4);
      if (estimatedTokens <= this.maxTokens) break;
      this.evictLowestPriority();
    }
  }

  /**
   * Evict one fact with lowest priority.
   * Priority: lowest confidence → fewest confirmations → oldest iteration.
   * Never evicts corrections or blockers.
   */
  private evictLowestPriority(): void {
    let candidate: FactSheetEntry | null = null;

    for (const fact of this.facts.values()) {
      // Never evict protected categories
      if (PROTECTED_CATEGORIES.has(fact.category)) continue;

      if (!candidate) {
        candidate = fact;
        continue;
      }

      // Compare: lower confidence → fewer confirmations → older iteration
      if (
        fact.confidence < candidate.confidence ||
        (fact.confidence === candidate.confidence &&
          fact.confirmations < candidate.confirmations) ||
        (fact.confidence === candidate.confidence &&
          fact.confirmations === candidate.confirmations &&
          fact.iteration < candidate.iteration)
      ) {
        candidate = fact;
      }
    }

    if (candidate) {
      this.facts.delete(candidate.id);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Extract file path from heuristic file_content facts.
 * Handles patterns like:
 *   "Read /abs/path/file.ts (N lines)..."
 *   "Read relative/path/file.ts (N lines)..."
 */
function extractFilePath(text: string): string | null {
  const match = text.match(/^Read\s+(\S+)\s*\(/i);
  return match?.[1] ?? null;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9а-яё\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
  let intersect = 0;
  for (const word of a) {
    if (b.has(word)) intersect++;
  }
  const minSize = Math.min(a.size, b.size);
  return minSize === 0 ? 0 : intersect / minSize;
}

function formatCategoryHeader(category: FactCategory): string {
  const headers: Record<FactCategory, string> = {
    correction: 'Corrections',
    blocker: 'Blockers',
    decision: 'Decisions',
    finding: 'Findings',
    file_content: 'Files Read',
    architecture: 'Architecture',
    tool_result: 'Tool Results',
    environment: 'Environment',
  };
  return headers[category] || category;
}
