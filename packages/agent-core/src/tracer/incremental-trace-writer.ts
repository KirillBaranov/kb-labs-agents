/**
 * Incremental Trace Writer - NDJSON append-only tracer with crash safety
 *
 * Features:
 * - NDJSON format (newline-delimited JSON) for append-only writes
 * - Automatic flush every 100ms OR every 10 events
 * - Race condition protection with flushing flag
 * - Process cleanup handler for setInterval
 * - Privacy redaction on trace() call
 * - Auto-cleanup (keep last 30 traces)
 * - Index generation for fast CLI queries
 */

import { promises as fs, mkdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import type { Tracer } from '@kb-labs/agent-contracts';
import type { DetailedTraceEntry } from '@kb-labs/agent-contracts';
import { redactTraceEvent } from './privacy-redactor.js';

/**
 * Trace configuration interface
 */
export interface TraceConfig {
  version: string;
  enabled: boolean;
  level: 'minimal' | 'standard' | 'detailed' | 'debug';

  incremental: {
    enabled: boolean;
    flushIntervalMs: number; // Default: 100ms
    maxBufferSize: number; // Default: 10 events
    format: 'ndjson';
  };

  capture: {
    prompts: boolean;
    toolOutputs: boolean;
    memorySnapshots: boolean;
    decisions: boolean;
  };

  retention: {
    maxTraces: number; // Default: 30
    maxDays: number; // Default: 30
    cleanupOnFinalize: boolean; // Default: true
    archiveOlderThan: number; // Days, default: 7
    compressArchived: boolean; // Default: true
  };

  privacy: {
    redactSecrets: boolean; // Default: true
    redactPaths: boolean; // Default: true
    secretPatterns: string[]; // Regex patterns
    pathReplacements: Record<string, string>;
  };

  storage: {
    path: string; // Default: ".kb/traces/incremental"
    indexPath: string; // Default: ".kb/traces/incremental"
  };
}

/**
 * Trace index for fast CLI queries
 */
export interface TraceIndex {
  version: string;
  taskId: string;
  createdAt: string;
  finalizedAt: string;

  summary: {
    totalEvents: number;
    iterations: number;
    status: 'success' | 'failed' | 'incomplete';
    eventCounts: Record<string, number>;
  };

  timing: {
    startedAt: string;
    completedAt: string;
    totalDurationMs: number;
  };

  cost: {
    totalCost: number;
    currency: 'USD';
  };

  errors: number;

  iterations: Array<{
    iteration: number;
    eventCount: number;
    llmCalls: number;
    toolCalls: number;
  }>;
}

/**
 * Default trace configuration
 */
export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  version: '1.0.0',
  enabled: true,
  level: 'detailed',

  incremental: {
    enabled: true,
    flushIntervalMs: 100,
    maxBufferSize: 10,
    format: 'ndjson',
  },

  capture: {
    prompts: true,
    toolOutputs: true,
    memorySnapshots: true,
    decisions: true,
  },

  retention: {
    maxTraces: 30,
    maxDays: 30,
    cleanupOnFinalize: true,
    archiveOlderThan: 7,
    compressArchived: true,
  },

  privacy: {
    redactSecrets: true,
    redactPaths: true,
    secretPatterns: [
      'sk-[a-zA-Z0-9]{20,}', // OpenAI API keys
      'Bearer\\s+[a-zA-Z0-9_-]+', // Bearer tokens
      'password[\'"]?\\s*[:=]\\s*[\'"][^\'"]+([\'"]})', // Passwords
      'api[_-]?key[\'"]?\\s*[:=]\\s*[\'"][^\'"]+[\'"]', // Generic API keys
    ],
    pathReplacements: {
      '/Users/': '~/',
      '/home/': '~/',
      '\\Users\\': '~\\',
    },
  },

  storage: {
    path: '.kb/traces/incremental',
    indexPath: '.kb/traces/incremental',
  },
};

/**
 * Incremental Trace Writer - crash-safe NDJSON tracer
 */
export class IncrementalTraceWriter implements Tracer {
  private buffer: DetailedTraceEntry[] = [];
  private seq: number = 0;
  private flushing: boolean = false;
  private flushTimer?: NodeJS.Timeout;
  private filepath: string;
  private indexPath: string;
  private config: TraceConfig;
  private taskId: string;
  private startTime: string;

  constructor(
    taskId: string,
    config: Partial<TraceConfig> = {},
    outputDir?: string
  ) {
    this.taskId = taskId;
    this.config = { ...DEFAULT_TRACE_CONFIG, ...config };
    this.startTime = new Date().toISOString();

    const dir = outputDir || this.config.storage.path;
    this.filepath = path.join(dir, `${taskId}.ndjson`);
    this.indexPath = path.join(dir, `${taskId}-index.json`);

    // Create output directory if not exists
    this.ensureDirectoryExists(dir);

    // Start flush interval timer
    if (this.config.incremental.enabled) {
      this.startFlushInterval();
    }

    // Register cleanup handler for process exit (prevents setInterval leak)
    process.on('exit', () => this.stopFlushInterval());
  }

  /**
   * Record a trace entry
   */
  trace(entry: any): void {
    try {
      // Auto-increment sequence
      const seq = ++this.seq;

      // Add timestamp if missing
      const timestamp = entry.timestamp || new Date().toISOString();

      // Build entry
      const fullEntry: DetailedTraceEntry = {
        ...entry,
        seq,
        timestamp,
      };

      // Apply privacy redaction
      const redacted = this.redact(fullEntry);

      // Add to buffer
      this.buffer.push(redacted);

      // Check size-based flush
      if (this.buffer.length >= this.config.incremental.maxBufferSize) {
        // Don't await - let it run async
        void this.flush();
      }
    } catch (error) {
      console.error('[IncrementalTraceWriter] trace() error:', error);
      // Don't crash agent - tracing failure should not stop execution
    }
  }

  /**
   * Get all trace entries (reads from NDJSON file to avoid memory leak)
   * Returns TraceEntry[] for backward compatibility, but actual format is DetailedTraceEntry[]
   */
  getEntries(): any[] {
    try {
      const content = readFileSync(this.filepath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      return lines.map((line: string) => JSON.parse(line));
    } catch {
      // File doesn't exist yet or is empty
      return [];
    }
  }

  /**
   * Save trace to file (backward compat - alias for flush)
   */
  async save(_filePath: string): Promise<void> {
    await this.flush();
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.buffer = [];
    this.seq = 0;
  }

  /**
   * Finalize trace (flush, generate index, cleanup old traces)
   */
  async finalize(): Promise<void> {
    try {
      // Stop flush interval timer
      this.stopFlushInterval();

      // Final flush
      await this.flush();

      // Generate index
      await this.createIndex();

      // Cleanup old traces
      if (this.config.retention.cleanupOnFinalize) {
        await this.cleanupOldTraces();
      }
    } catch (error) {
      console.error('[IncrementalTraceWriter] finalize() error:', error);
    }
  }

  /**
   * Create index file for fast CLI queries
   */
  async createIndex(): Promise<void> {
    try {
      const entries = this.getEntries();

      if (entries.length === 0) {
        console.warn('[IncrementalTraceWriter] No entries to index');
        return;
      }

      // Calculate summary statistics
      const stats = this.calculateIndexStatistics(entries);

      // Build index
      const index: TraceIndex = {
        version: '1.0.0',
        taskId: this.taskId,
        createdAt: this.startTime,
        finalizedAt: new Date().toISOString(),

        summary: {
          totalEvents: entries.length,
          iterations: stats.iterations.size,
          status: stats.errors > 0 ? 'failed' : 'success',
          eventCounts: stats.eventCounts,
        },

        timing: {
          startedAt: this.startTime,
          completedAt: new Date().toISOString(),
          totalDurationMs: Date.now() - new Date(this.startTime).getTime(),
        },

        cost: {
          totalCost: stats.totalCost,
          currency: 'USD',
        },

        errors: stats.errors,

        iterations: Array.from(stats.iterations.entries())
          .map(([iteration, iterStats]) => ({ iteration, ...iterStats }))
          .sort((a, b) => a.iteration - b.iteration),
      };

      // Ensure index directory exists
      const indexDir = path.dirname(this.indexPath);
      this.ensureDirectoryExists(indexDir);

      // Write index file
      await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    } catch (error) {
      console.error('[IncrementalTraceWriter] createIndex() error:', error);
      // Continue - CLI commands will work but slower (read full NDJSON)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Flush buffer to NDJSON file
   */
  private async flush(): Promise<void> {
    // Check if already flushing (prevent race condition)
    if (this.flushing) {
      return;
    }

    try {
      // Set flag
      this.flushing = true;

      // If buffer empty, return
      if (this.buffer.length === 0) {
        return;
      }

      // Convert buffer to NDJSON lines
      const ndjsonLines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';

      // Append to file
      await fs.appendFile(this.filepath, ndjsonLines, 'utf-8');

      // Clear buffer
      this.buffer = [];
    } catch (error) {
      console.error('[IncrementalTraceWriter] flush() error:', error);
      // Clear buffer anyway to prevent memory growth
      this.buffer = [];
    } finally {
      // Reset flag
      this.flushing = false;
    }
  }

  /**
   * Start flush interval timer
   */
  private startFlushInterval(): void {
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.incremental.flushIntervalMs
    );
  }

  /**
   * Stop flush interval timer
   */
  private stopFlushInterval(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Cleanup old traces (keep last N traces)
   */
  private async cleanupOldTraces(): Promise<void> {
    try {
      const dir = path.dirname(this.filepath);
      const files = await fs.readdir(dir);

      // Filter .ndjson files
      const traceFiles = files.filter((f) => f.endsWith('.ndjson'));

      // If <= maxTraces, nothing to clean
      if (traceFiles.length <= this.config.retention.maxTraces) {
        return;
      }

      // Get file stats and sort by mtime (newest first)
      const filesWithStats = await Promise.all(
        traceFiles.map(async (file) => {
          const filepath = path.join(dir, file);
          const stats = await fs.stat(filepath);
          return { file, mtime: stats.mtime.getTime(), filepath };
        })
      );

      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // Delete oldest traces
      const toDelete = filesWithStats.slice(this.config.retention.maxTraces);

      // Delete files in parallel for better performance
      await Promise.allSettled(
        toDelete.map(async ({ file, filepath }) => {
          try {
            // Delete NDJSON file
            await fs.unlink(filepath);

            // Delete index file
            const indexFile = filepath.replace('.ndjson', '-index.json');
            try {
              await fs.unlink(indexFile);
            } catch {
              // Index might not exist, ignore
            }
          } catch (error) {
            console.error(`[IncrementalTraceWriter] Failed to delete ${file}:`, error);
          }
        })
      );

      if (toDelete.length > 0) {
        console.log(
          `[IncrementalTraceWriter] Cleaned up ${toDelete.length} old traces (kept last ${this.config.retention.maxTraces})`
        );
      }
    } catch (error) {
      console.error('[IncrementalTraceWriter] cleanupOldTraces() error:', error);
      // Continue - disk space grows but agent works
    }
  }

  /**
   * Redact sensitive data from entry using optimized privacy-redactor
   *
   * Uses shallow clone optimization - only clones objects that need redaction,
   * not the entire trace event tree. Returns original if no secrets found.
   */
  private redact(entry: DetailedTraceEntry): DetailedTraceEntry {
    if (!this.config.privacy.redactSecrets && !this.config.privacy.redactPaths) {
      return entry;
    }

    try {
      return redactTraceEvent(entry, this.config.privacy);
    } catch (error) {
      console.warn('[IncrementalTraceWriter] redact() error:', error);
      return entry; // Return un-redacted (privacy risk, but better than crash)
    }
  }

  /**
   * Calculate index statistics from trace entries
   */
  private calculateIndexStatistics(entries: any[]): {
    eventCounts: Record<string, number>;
    iterations: Map<number, { eventCount: number; llmCalls: number; toolCalls: number }>;
    totalCost: number;
    errors: number;
  } {
    const eventCounts: Record<string, number> = {};
    const iterations = new Map<number, { eventCount: number; llmCalls: number; toolCalls: number }>();
    let totalCost = 0;
    let errors = 0;

    for (const entry of entries) {
      // Count by type
      eventCounts[entry.type] = (eventCounts[entry.type] || 0) + 1;

      // Count by iteration
      if (entry.iteration !== undefined) {
        if (!iterations.has(entry.iteration)) {
          iterations.set(entry.iteration, { eventCount: 0, llmCalls: 0, toolCalls: 0 });
        }
        const iter = iterations.get(entry.iteration)!;
        iter.eventCount++;

        if (entry.type === 'llm:call') {
          iter.llmCalls++;
          if ('cost' in entry && entry.cost) {
            totalCost += entry.cost.totalCost || 0;
          }
        }

        if (entry.type === 'tool:execution') {
          iter.toolCalls++;
        }
      }

      // Count errors
      if (entry.type === 'error:captured') {
        errors++;
      }
    }

    return { eventCounts, iterations, totalCost, errors };
  }

  /**
   * Ensure directory exists
   */
  private ensureDirectoryExists(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      // Check if directory already exists
      try {
        const stats = statSync(dir);
        if (!stats.isDirectory()) {
          throw new Error(`Path exists but is not a directory: ${dir}`);
        }
        // Directory exists - all good
      } catch {
        // Directory doesn't exist and couldn't be created
        throw new Error(`Failed to create trace directory: ${dir}. Error: ${error}`);
      }
    }
  }
}
