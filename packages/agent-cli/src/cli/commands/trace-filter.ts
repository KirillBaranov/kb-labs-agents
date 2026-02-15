/**
 * agent:trace:filter - Filter trace events by type (AI-friendly)
 *
 * Usage:
 *   pnpm kb agent:trace:filter <taskId> --type=llm:call
 *   pnpm kb agent:trace:filter <taskId> --type=tool:execution --json
 *   pnpm kb agent:trace:filter <taskId> --type=error:captured
 */

import { defineCommand, useLogger, type PluginContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  TraceCommandResponse,
  FilterResponse,
  TraceErrorCode,
  TraceEventType,
} from '@kb-labs/agent-contracts';
import type { DetailedTraceEntry } from '@kb-labs/agent-contracts';

const VALID_EVENT_TYPES: TraceEventType[] = [
  'iteration:detail',
  'llm:call',
  'tool:execution',
  'memory:snapshot',
  'decision:point',
  'synthesis:forced',
  'error:captured',
  'prompt:diff',
  'tool:filter',
  'context:trim',
  'stopping:analysis',
  'llm:validation',
];

type TraceFilterInput = {
  taskId?: string;
  type?: string;
  json?: boolean;
};

type TraceFilterResult = { exitCode: number; response?: TraceCommandResponse };

export default defineCommand({
  id: 'trace:filter',
  description: 'Filter trace events by type for debugging',

  handler: {
    async execute(ctx: PluginContextV3, input: TraceFilterInput): Promise<TraceFilterResult> {
      const logger = useLogger();
      const flags = (input as any).flags ?? input;
      const taskId = flags.taskId as string | undefined;
      const eventType = flags.type as string | undefined;

    // Validate inputs
    if (!taskId) {
      const err = error('INVALID_TASK_ID', 'Missing required --task-id flag');
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { exitCode: 1, response: err };
    }

    // Validate taskId format (prevent path traversal)
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      const err = error('INVALID_TASK_ID', 'Task ID must contain only alphanumeric characters, hyphens, and underscores');
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { exitCode: 1, response: err };
    }

    if (!eventType) {
      const err = error('INVALID_EVENT_TYPE', 'Missing required --type flag');
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { exitCode: 1, response: err };
    }

    if (!VALID_EVENT_TYPES.includes(eventType as TraceEventType)) {
      const err = error(
        'INVALID_EVENT_TYPE',
        `Invalid event type: ${eventType}. Valid types: ${VALID_EVENT_TYPES.join(', ')}`
      );
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { exitCode: 1, response: err };
    }

    try {
      // Find trace file with path traversal protection
      const traceDir = path.join(process.cwd(), '.kb', 'traces', 'incremental');
      const tracePath = path.join(traceDir, `${taskId}.ndjson`);

      // Verify resolved path is within expected directory (prevent path traversal)
      const resolvedPath = path.resolve(tracePath);
      const resolvedDir = path.resolve(traceDir);
      const relative = path.relative(resolvedDir, resolvedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        const err = error('INVALID_TASK_ID', 'Invalid task ID: path traversal detected');
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      }

      // Check if file exists and validate size
      let fileStats;
      try {
        fileStats = await fs.stat(tracePath);
      } catch {
        const err = error('TRACE_NOT_FOUND', `Trace file not found: ${taskId}`);
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      }

      // Prevent memory exhaustion from large files (100MB limit)
      const MAX_FILE_SIZE = 100 * 1024 * 1024;
      if (fileStats.size > MAX_FILE_SIZE) {
        const err = error('FILE_TOO_LARGE', `Trace file exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      }

      // Read and parse trace with error handling for malformed NDJSON
      const content = await fs.readFile(tracePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const events: DetailedTraceEntry[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as DetailedTraceEntry);
        } catch {
          // Skip malformed lines gracefully
          console.warn(`Skipped malformed NDJSON line: ${line.substring(0, 50)}...`);
        }
      }

      // Filter by type
      const filtered = events.filter((e) => e.type === eventType);

      // Build response
      const response: TraceCommandResponse<FilterResponse> = {
        success: true,
        command: 'trace:filter',
        taskId,
        data: {
          taskId,
          eventType,
          events: filtered,
          count: filtered.length,
        },
        summary: {
          message: `Found ${filtered.length} ${eventType} events`,
          severity: 'info',
          actionable: false,
        },
      };

      // Output
      if (flags.json) {
        ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
      } else {
        printHumanReadable(ctx, eventType, filtered);
      }

      return { exitCode: 0, response };
    } catch (err) {
      logger.error('trace:filter error:', err instanceof Error ? err : undefined);
      const errResponse = error('IO_ERROR', err instanceof Error ? err.message : String(err));
      ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
      return { exitCode: 1, response: errResponse };
    }
    },
  },
});

/**
 * Print human-readable output
 */
function printHumanReadable(ctx: PluginContextV3, eventType: string, events: DetailedTraceEntry[]): void {
  ctx.ui.write('\n');
  ctx.ui.write(`🔍 Filtered Events: ${eventType}\n`);
  ctx.ui.write(`Found ${events.length} events\n`);
  ctx.ui.write('\n');

  if (events.length === 0) {
    ctx.ui.write('No events found.\n');
    return;
  }

  // Show first 10 events
  const showCount = Math.min(10, events.length);
  ctx.ui.write(`Showing first ${showCount}/${events.length}:\n`);
  ctx.ui.write('\n');

  for (let i = 0; i < showCount; i++) {
    const event = events[i];
    if (!event) {continue;}

    ctx.ui.write(`[${event.seq}] ${event.timestamp} (iteration ${(event as any).iteration || 'N/A'})\n`);

    // Show event-specific summary
    if (event.type === 'llm:call') {
      const e = event as any;
      ctx.ui.write(`  Model: ${e.request.model}, Tokens: ${e.response.usage.totalTokens}, Cost: $${e.cost.totalCost.toFixed(6)}\n`);
    } else if (event.type === 'tool:execution') {
      const e = event as any;
      ctx.ui.write(`  Tool: ${e.tool.name}, Success: ${e.output.success}, Duration: ${e.timing.durationMs}ms\n`);
    } else if (event.type === 'error:captured') {
      const e = event as any;
      ctx.ui.write(`  Error: ${e.error.message.substring(0, 100)}\n`);
    }

    ctx.ui.write('\n');
  }

  if (events.length > showCount) {
    ctx.ui.write(`... and ${events.length - showCount} more events\n`);
    ctx.ui.write('Use --json flag to see all events\n');
  }
}

/**
 * Create error response
 */
function error(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:filter',
    taskId: '',
    error: {
      code,
      message,
    },
    summary: {
      message,
      severity: 'error',
      actionable: true,
    },
  };
}
