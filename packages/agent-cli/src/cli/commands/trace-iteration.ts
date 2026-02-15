/**
 * agent:trace:iteration - View specific iteration details (AI-friendly)
 *
 * Usage:
 *   pnpm kb agent:trace:iteration <taskId> --iteration=3
 *   pnpm kb agent:trace:iteration <taskId> --iteration=5 --json
 */

import { defineCommand, useLogger, type PluginContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  TraceCommandResponse,
  IterationResponse,
  TraceErrorCode,
} from '@kb-labs/agent-contracts';
import type { DetailedTraceEntry, LLMCallEvent, ToolExecutionEvent } from '@kb-labs/agent-contracts';

type TraceIterationInput = {
  taskId?: string;
  iteration?: number;
  json?: boolean;
};

type TraceIterationResult = { exitCode: number; response?: TraceCommandResponse };

export default defineCommand({
  id: 'trace:iteration',
  description: 'View all events for a specific iteration',

  handler: {
    async execute(ctx: PluginContextV3, input: TraceIterationInput): Promise<TraceIterationResult> {
      const logger = useLogger();
      const flags = (input as any).flags ?? input;
      const taskId = flags.taskId as string | undefined;
      const iteration = typeof flags.iteration === 'string' ? parseInt(flags.iteration, 10) : (flags.iteration as number | undefined);

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

    if (iteration === undefined || iteration < 1) {
      const err = error('INVALID_ITERATION', 'Missing or invalid --iteration flag (must be >= 1)');
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

      // Filter by iteration
      const filtered = events.filter((e) => (e as any).iteration === iteration);

      if (filtered.length === 0) {
        const err = error('INVALID_ITERATION', `No events found for iteration ${iteration}`);
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      }

      // Calculate summary
      const summary = calculateIterationSummary(filtered);

      // Build response
      const response: TraceCommandResponse<IterationResponse> = {
        success: true,
        command: 'trace:iteration',
        taskId,
        data: {
          taskId,
          iteration,
          events: filtered,
          summary,
        },
        summary: {
          message: `Iteration ${iteration}: ${summary.eventCount} events, ${summary.llmCalls} LLM calls, ${summary.toolCalls} tool calls`,
          severity: summary.errors > 0 ? 'warning' : 'info',
          actionable: summary.errors > 0,
        },
      };

      // Output
      if (flags.json) {
        ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
      } else {
        printHumanReadable(ctx, iteration, filtered, summary);
      }

      return { exitCode: 0, response };
    } catch (err) {
      logger.error('trace:iteration error:', err instanceof Error ? err : undefined);
      const errResponse = error('IO_ERROR', err instanceof Error ? err.message : String(err));
      ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
      return { exitCode: 1, response: errResponse };
    }
    },
  },
});

/**
 * Calculate iteration summary
 */
function calculateIterationSummary(events: DetailedTraceEntry[]): IterationResponse['summary'] {
  const llmEvents = events.filter((e) => e.type === 'llm:call') as LLMCallEvent[];
  const toolEvents = events.filter((e) => e.type === 'tool:execution') as ToolExecutionEvent[];
  const errorEvents = events.filter((e) => e.type === 'error:captured');

  // Calculate duration (from first to last event timestamp)
  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  const durationMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

  return {
    eventCount: events.length,
    llmCalls: llmEvents.length,
    toolCalls: toolEvents.length,
    errors: errorEvents.length,
    durationMs,
  };
}

/**
 * Print human-readable output
 */
function printHumanReadable(
  ctx: PluginContextV3,
  iteration: number,
  events: DetailedTraceEntry[],
  summary: IterationResponse['summary']
): void {
  ctx.ui.write('\n');
  ctx.ui.write(`🔄 Iteration ${iteration}\n`);
  ctx.ui.write('\n');

  ctx.ui.write('📊 Summary:\n');
  ctx.ui.write(`  Total events: ${summary.eventCount}\n`);
  ctx.ui.write(`  LLM calls: ${summary.llmCalls}\n`);
  ctx.ui.write(`  Tool calls: ${summary.toolCalls}\n`);
  ctx.ui.write(`  Errors: ${summary.errors}\n`);
  ctx.ui.write(`  Duration: ${summary.durationMs}ms\n`);
  ctx.ui.write('\n');

  ctx.ui.write('📝 Events Timeline:\n');
  ctx.ui.write('\n');

  // Group events by type for better readability
  const grouped = new Map<string, DetailedTraceEntry[]>();
  for (const event of events) {
    const existing = grouped.get(event.type) || [];
    existing.push(event);
    grouped.set(event.type, existing);
  }

  // Show event counts
  for (const [type, typeEvents] of grouped) {
    ctx.ui.write(`  ${type}: ${typeEvents.length}\n`);

    // Show details for important events
    if (type === 'llm:call' && typeEvents.length > 0) {
      const llmEvent = typeEvents[0] as LLMCallEvent;
      ctx.ui.write(`    Model: ${llmEvent.request.model}\n`);
      ctx.ui.write(`    Tokens: ${llmEvent.response.usage.totalTokens}\n`);
      ctx.ui.write(`    Cost: $${llmEvent.cost.totalCost.toFixed(6)}\n`);
    } else if (type === 'tool:execution') {
      const toolNames = (typeEvents as ToolExecutionEvent[]).map((e) => e.tool.name);
      ctx.ui.write(`    Tools: ${[...new Set(toolNames)].join(', ')}\n`);
    } else if (type === 'error:captured' && typeEvents.length > 0) {
      const errorEvent = typeEvents[0] as any;
      ctx.ui.write(`    ⚠️  ${errorEvent.error.message.substring(0, 100)}\n`);
    }
  }

  ctx.ui.write('\n');
  ctx.ui.write('Use --json flag to see full event details\n');
}

/**
 * Create error response
 */
function error(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:iteration',
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
