/**
 * Result processor that saves trace to file
 */

import * as path from 'node:path';
import type { ResultProcessor, TaskResult } from '@kb-labs/agent-contracts';
import { IncrementalTraceWriter } from '@kb-labs/agent-tracing';

/**
 * Saves execution trace to .kb/traces/incremental/ directory using IncrementalTraceWriter
 * Note: Cleanup is handled by IncrementalTraceWriter.finalize()
 */
export class TraceSaverProcessor implements ResultProcessor {
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  async process(result: TaskResult): Promise<TaskResult> {
    if (!result.trace || result.trace.length === 0) {
      return result;
    }

    // Generate trace file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const traceDir = path.join(this.workingDir, '.kb', 'traces', 'incremental');
    const traceFile = path.join(traceDir, `task-${timestamp}.ndjson`);

    // Save trace using IncrementalTraceWriter
    const tracer = new IncrementalTraceWriter('task-' + timestamp, {}, traceDir);

    // Add all trace entries
    for (const entry of result.trace) {
      tracer.trace(entry);
    }

    // Finalize (flush + generate index + cleanup)
    await tracer.finalize();

    // Add trace file path to result
    return {
      ...result,
      traceFile,
    };
  }

}
