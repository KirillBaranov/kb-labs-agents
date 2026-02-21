/**
 * ArchiveMemory - Tier 2: Cold Storage
 *
 * Stores full untruncated tool outputs for later retrieval via archive_recall tool.
 * Not injected into LLM context directly — agent queries it on demand.
 *
 * Features:
 * - Full output preservation (no truncation)
 * - Indexed by file path, tool name, iteration
 * - Keyword search across all archived outputs
 * - Eviction of oldest entries when limits exceeded
 * - Optional persistence to disk
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArchiveEntry } from '@kb-labs/agent-contracts';
import { AGENT_MEMORY } from '../constants.js';

export interface ArchiveMemoryConfig {
  maxEntries?: number;
  maxTotalChars?: number;
  /** Directory for persistence (e.g., .kb/memory/{sessionId}) */
  persistDir?: string;
}

export class ArchiveMemory {
  private entries = new Map<string, ArchiveEntry>();
  private filePathIndex = new Map<string, string[]>(); // filePath → entryIds
  private toolNameIndex = new Map<string, string[]>(); // toolName → entryIds
  private nextId = 1;
  private totalChars = 0;
  private readonly maxEntries: number;
  private readonly maxTotalChars: number;
  private readonly persistDir?: string;

  constructor(config: ArchiveMemoryConfig = {}) {
    this.maxEntries = config.maxEntries ?? AGENT_MEMORY.archiveMaxEntries;
    this.maxTotalChars = config.maxTotalChars ?? AGENT_MEMORY.archiveMaxTotalChars;
    this.persistDir = config.persistDir;
  }

  /**
   * Store a tool output in the archive. Returns the entry and eviction count.
   */
  store(params: {
    iteration: number;
    toolName: string;
    toolInput: Record<string, unknown>;
    fullOutput: string;
    filePath?: string;
    keyFacts?: string[];
  }): { entry: ArchiveEntry; evicted: number } {
    const id = `archive_${this.nextId++}`;
    const entry: ArchiveEntry = {
      id,
      iteration: params.iteration,
      toolName: params.toolName,
      toolInput: params.toolInput,
      fullOutput: params.fullOutput,
      outputLength: params.fullOutput.length,
      estimatedTokens: Math.ceil(params.fullOutput.length / 4),
      timestamp: new Date().toISOString(),
      filePath: params.filePath,
      keyFacts: params.keyFacts,
    };

    this.entries.set(id, entry);
    this.totalChars += entry.outputLength;

    // Update indices
    if (params.filePath) {
      const existing = this.filePathIndex.get(params.filePath) || [];
      existing.push(id);
      this.filePathIndex.set(params.filePath, existing);
    }
    {
      const existing = this.toolNameIndex.get(params.toolName) || [];
      existing.push(id);
      this.toolNameIndex.set(params.toolName, existing);
    }

    // Evict if over limits
    const evicted = this.enforceLimit();

    return { entry, evicted };
  }

  /**
   * Recall the most recent read of a file
   */
  recallByFilePath(filePath: string): ArchiveEntry | null {
    const ids = this.filePathIndex.get(filePath);
    if (!ids || ids.length === 0) return null;

    // Return the most recent (last in the array)
    for (let i = ids.length - 1; i >= 0; i--) {
      const entry = this.entries.get(ids[i]!);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Recall all reads of a file (chronological order)
   */
  recallAllByFilePath(filePath: string): ArchiveEntry[] {
    const ids = this.filePathIndex.get(filePath);
    if (!ids) return [];
    return ids
      .map((id) => this.entries.get(id))
      .filter((e): e is ArchiveEntry => e !== undefined);
  }

  /**
   * Recall recent outputs of a specific tool
   */
  recallByToolName(toolName: string, limit = 10): ArchiveEntry[] {
    const ids = this.toolNameIndex.get(toolName);
    if (!ids) return [];
    const entries = ids
      .map((id) => this.entries.get(id))
      .filter((e): e is ArchiveEntry => e !== undefined);
    return entries.slice(-limit);
  }

  /**
   * Recall all outputs from a specific iteration
   */
  recallByIteration(iteration: number): ArchiveEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) => e.iteration === iteration
    );
  }

  /**
   * Keyword search across all archived outputs
   */
  search(keyword: string, limit = 10): ArchiveEntry[] {
    const lower = keyword.toLowerCase();
    const results: ArchiveEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.fullOutput.toLowerCase().includes(lower)) {
        results.push(entry);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get a compact hint for system prompt injection
   */
  getSummaryHint(): string {
    if (this.entries.size === 0) return '';

    const uniqueFiles = this.filePathIndex.size;
    const totalK = Math.round(this.totalChars / 1000);
    return `Archive available: ${uniqueFiles} files, ${this.entries.size} tool outputs (${totalK}K chars). Use archive_recall to retrieve.`;
  }

  /**
   * Get all archived file paths
   */
  getArchivedFilePaths(): string[] {
    return Array.from(this.filePathIndex.keys());
  }

  /**
   * Check if a file has been archived
   */
  hasFile(filePath: string): boolean {
    const ids = this.filePathIndex.get(filePath);
    return ids !== undefined && ids.length > 0;
  }

  /**
   * Get stats for tracing
   */
  getStats(): {
    totalEntries: number;
    totalChars: number;
    uniqueFiles: number;
  } {
    return {
      totalEntries: this.entries.size,
      totalChars: this.totalChars,
      uniqueFiles: this.filePathIndex.size,
    };
  }

  /**
   * Persist archive to disk
   */
  async persist(): Promise<void> {
    if (!this.persistDir) return;

    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      const data = {
        entries: Array.from(this.entries.entries()),
        nextId: this.nextId,
      };
      const filePath = path.join(this.persistDir, 'archive-memory.json');
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    } catch {
      // Non-critical — log and continue
      console.error('[ArchiveMemory] Failed to persist archive');
    }
  }

  /**
   * Load archive from disk
   */
  static async load(config: ArchiveMemoryConfig): Promise<ArchiveMemory> {
    const archive = new ArchiveMemory(config);
    if (!config.persistDir) return archive;

    const filePath = path.join(config.persistDir, 'archive-memory.json');
    try {
      if (!fs.existsSync(filePath)) return archive;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        entries: Array<[string, ArchiveEntry]>;
        nextId: number;
      };

      for (const [id, entry] of data.entries) {
        archive.entries.set(id, entry);
        archive.totalChars += entry.outputLength;

        // Rebuild indices
        if (entry.filePath) {
          const existing = archive.filePathIndex.get(entry.filePath) || [];
          existing.push(id);
          archive.filePathIndex.set(entry.filePath, existing);
        }
        {
          const existing =
            archive.toolNameIndex.get(entry.toolName) || [];
          existing.push(id);
          archive.toolNameIndex.set(entry.toolName, existing);
        }
      }
      archive.nextId = data.nextId;
    } catch {
      // Non-critical — start with empty archive
    }
    return archive;
  }

  /**
   * Enforce entry count and char limits. Returns number of entries evicted.
   */
  private enforceLimit(): number {
    let evicted = 0;

    // Evict by entry count
    while (this.entries.size > this.maxEntries) {
      this.evictOldest();
      evicted++;
    }

    // Evict by total chars
    let prevSize = -1;
    while (this.totalChars > this.maxTotalChars && this.entries.size > 0) {
      const sizeBefore = this.entries.size;
      this.evictOldest();
      evicted++;
      // Guard: if size didn't decrease, break to prevent infinite loop
      if (this.entries.size === prevSize) break;
      prevSize = sizeBefore;
    }

    return evicted;
  }

  /**
   * Evict the oldest entry (by iteration, then timestamp)
   */
  private evictOldest(): void {
    let oldest: ArchiveEntry | null = null;
    for (const entry of this.entries.values()) {
      if (
        !oldest ||
        entry.iteration < oldest.iteration ||
        (entry.iteration === oldest.iteration &&
          entry.timestamp < oldest.timestamp)
      ) {
        oldest = entry;
      }
    }

    if (oldest) {
      this.removeEntry(oldest.id);
    }
  }

  /**
   * Remove an entry and clean up indices
   */
  private removeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    this.entries.delete(id);
    this.totalChars -= entry.outputLength;

    // Clean file path index
    if (entry.filePath) {
      const ids = this.filePathIndex.get(entry.filePath);
      if (ids) {
        const filtered = ids.filter((i) => i !== id);
        if (filtered.length === 0) {
          this.filePathIndex.delete(entry.filePath);
        } else {
          this.filePathIndex.set(entry.filePath, filtered);
        }
      }
    }

    // Clean tool name index
    {
      const ids = this.toolNameIndex.get(entry.toolName);
      if (ids) {
        const filtered = ids.filter((i) => i !== id);
        if (filtered.length === 0) {
          this.toolNameIndex.delete(entry.toolName);
        } else {
          this.toolNameIndex.set(entry.toolName, filtered);
        }
      }
    }
  }
}
