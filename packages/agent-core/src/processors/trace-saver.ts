/**
 * Result processor that saves trace to file
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ResultProcessor, TaskResult } from '@kb-labs/agent-contracts';

/**
 * Saves execution trace to .kb/traces/ directory
 * Auto-cleans old traces, keeping only the most recent N files
 */
export class TraceSaverProcessor implements ResultProcessor {
  private workingDir: string;
  private maxTraces: number;

  constructor(workingDir: string, maxTraces = 30) {
    this.workingDir = workingDir;
    this.maxTraces = maxTraces;
  }

  async process(result: TaskResult): Promise<TaskResult> {
    if (!result.trace || result.trace.length === 0) {
      return result;
    }

    // Generate trace file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const traceDir = path.join(this.workingDir, '.kb', 'traces');
    const traceFile = path.join(traceDir, `trace-${timestamp}.json`);

    // Save trace using FileTracer-compatible format
    const { FileTracer } = await import('../tracer/file-tracer.js');
    const tracer = new FileTracer('task-' + timestamp);

    // Add all trace entries
    for (const entry of result.trace) {
      tracer.trace(entry);
    }

    // Save to file
    await tracer.save(traceFile);

    // Cleanup old traces (keep only recent N)
    await this.cleanupOldTraces(traceDir);

    // Add trace file path to result
    return {
      ...result,
      traceFile,
    };
  }

  /**
   * Cleanup old trace files, keeping only the most recent N
   */
  private async cleanupOldTraces(traceDir: string): Promise<void> {
    try {
      // Read all trace files (both .json and legacy .txt)
      const files = await fs.readdir(traceDir);
      const traceFiles = files
        .filter((f) =>
          (f.startsWith('trace-') && f.endsWith('.json')) || // New format
          f.endsWith('.txt') // Legacy format
        )
        .map((f) => path.join(traceDir, f));

      // If we're under the limit, nothing to do
      if (traceFiles.length <= this.maxTraces) {
        return;
      }

      // Get file stats and sort by modification time (newest first)
      const filesWithStats = await Promise.all(
        traceFiles.map(async (file) => ({
          path: file,
          mtime: (await fs.stat(file)).mtime,
        }))
      );

      filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Delete old files (keep only maxTraces newest)
      const filesToDelete = filesWithStats.slice(this.maxTraces);

      for (const file of filesToDelete) {
        await fs.unlink(file.path);
      }

      if (filesToDelete.length > 0) {
        console.log(
          `[TraceSaver] Cleaned up ${filesToDelete.length} old trace file(s), kept ${this.maxTraces} most recent`
        );
      }
    } catch (error) {
      // Don't fail the task if cleanup fails
      console.error('[TraceSaver] Cleanup failed:', error);
    }
  }
}
