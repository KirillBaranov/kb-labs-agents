/**
 * agent:trace:stats - Show trace statistics (AI-friendly)
 *
 * Usage:
 *   pnpm kb agent:trace:stats <taskId>
 *   pnpm kb agent:trace:stats <taskId> --json
 */

import { defineCommand, useLogger } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  TraceCommandResponse,
  StatsResponse,
  TraceErrorCode,
} from '@kb-labs/agent-contracts';
import type { DetailedTraceEntry, LLMCallEvent, ToolExecutionEvent } from '@kb-labs/agent-contracts';

type TraceStatsInput = {
  taskId?: string;
  json?: boolean;
};

type TraceStatsResult = { exitCode: number; response?: TraceCommandResponse };

export default defineCommand({
  id: 'trace:stats',
  description: 'Show trace statistics with cost and performance metrics',

  handler: {
    async execute(ctx: PluginContextV3, input: TraceStatsInput): Promise<TraceStatsResult> {
      const logger = useLogger();
      const flags = (input as any).flags ?? input;
      const taskId = flags.taskId as string | undefined;

    // Validate taskId
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

      if (events.length === 0) {
        const err = error('CORRUPTED_TRACE', 'Trace file is empty');
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { exitCode: 1, response: err };
      }

      // Calculate stats
      const stats = calculateStats(events);

      // Build response
      const response: TraceCommandResponse<StatsResponse> = {
        success: true,
        command: 'trace:stats',
        taskId,
        data: stats,
        summary: {
          message: `${stats.iterations.total} iterations, ${stats.llm.calls} LLM calls, $${stats.cost.total.toFixed(4)} cost`,
          severity: stats.errors > 0 ? 'warning' : 'info',
          actionable: stats.errors > 5,
        },
      };

      // Output
      if (flags.json) {
        ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
      } else {
        printHumanReadable(ctx, stats);
      }

      return { exitCode: 0, response };
    } catch (err) {
      logger.error('trace:stats error:', err instanceof Error ? err : undefined);
      const errResponse = error('IO_ERROR', err instanceof Error ? err.message : String(err));
      ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
      return { exitCode: 1, response: errResponse };
    }
    },
  },
});

/**
 * Calculate statistics from trace events
 */
function calculateStats(events: DetailedTraceEntry[]): StatsResponse {
  // Find iteration events (supports both new and legacy formats)
  const iterationEvents = events.filter((e) => e.type === 'iteration:detail');

  // Find LLM events (supports both 'llm:call' new format and 'llm_call' legacy format)
  const llmEvents = events.filter((e) =>
    e.type === 'llm:call' || (e as any).type === 'llm_call'
  ) as LLMCallEvent[];

  // Find tool events (supports both 'tool:execution' new format and 'tool_call' legacy format)
  const toolEvents = events.filter((e) =>
    e.type === 'tool:execution' || (e as any).type === 'tool_call'
  ) as ToolExecutionEvent[];

  const errorEvents = events.filter((e) => e.type === 'error:captured');

  // Calculate LLM stats (handle both new and legacy data structures)
  const inputTokens = llmEvents.reduce((sum, e) => {
    // New format: e.response.usage.inputTokens
    // Legacy format: e.data.tokensUsed (approximate, only has total)
    const tokens = (e as any).response?.usage?.inputTokens || 0;
    return sum + tokens;
  }, 0);

  const outputTokens = llmEvents.reduce((sum, e) => {
    // New format: e.response.usage.outputTokens
    const tokens = (e as any).response?.usage?.outputTokens || 0;
    return sum + tokens;
  }, 0);

  // Legacy fallback: if no input/output tokens, use total from legacy format
  const legacyTotalTokens = llmEvents.reduce((sum, e) => {
    const tokens = (e as any).data?.tokensUsed || 0;
    return sum + tokens;
  }, 0);

  // Calculate cost (new format only, legacy doesn't have cost data)
  const totalCost = llmEvents.reduce((sum, e) => {
    const cost = (e as any).cost?.totalCost || 0;
    return sum + cost;
  }, 0);

  // Calculate tool stats (handle both new and legacy formats)
  const toolCounts: Record<string, number> = {};
  let successfulTools = 0;
  let failedTools = 0;

  for (const tool of toolEvents) {
    // New format: tool.tool.name
    // Legacy format: tool.data.toolName or extract from data
    const toolName = (tool as any).tool?.name || (tool as any).data?.toolName || 'unknown';
    toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;

    // New format: tool.output.success
    // Legacy format: tool.data.success (or assume success if no error)
    const success = (tool as any).output?.success ?? (tool as any).data?.success ?? true;
    if (success) {
      successfulTools++;
    } else {
      failedTools++;
    }
  }

  // Calculate timing
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const startedAt = firstEvent?.timestamp || new Date().toISOString();
  const completedAt = lastEvent?.timestamp || new Date().toISOString();
  const totalDurationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

  return {
    taskId: 'unknown', // Will be set by caller
    status: errorEvents.length > 0 ? 'failed' : 'success',

    iterations: {
      total: iterationEvents.length,
      completed: iterationEvents.length,
    },

    llm: {
      calls: llmEvents.length,
      inputTokens,
      outputTokens,
      // Use explicit tokens if available, otherwise fall back to legacy total
      totalTokens: (inputTokens + outputTokens) || legacyTotalTokens,
    },

    tools: {
      totalCalls: toolEvents.length,
      byTool: toolCounts,
      successful: successfulTools,
      failed: failedTools,
    },

    timing: {
      startedAt,
      completedAt,
      totalDurationMs,
      durationFormatted: formatDuration(totalDurationMs),
    },

    cost: {
      total: totalCost,
      currency: 'USD',
    },

    errors: errorEvents.length,
  };
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Print human-readable output
 */
function printHumanReadable(ctx: PluginContextV3, stats: StatsResponse): void {
  ctx.ui.write('\n');
  ctx.ui.write('📊 Trace Statistics\n');
  ctx.ui.write('\n');

  ctx.ui.write(`Status: ${stats.status === 'success' ? '✅ Success' : '❌ Failed'}\n`);
  ctx.ui.write(`Iterations: ${stats.iterations.total}\n`);
  ctx.ui.write('\n');

  ctx.ui.write('🤖 LLM Usage:\n');
  ctx.ui.write(`  Calls: ${stats.llm.calls}\n`);
  ctx.ui.write(`  Input tokens: ${stats.llm.inputTokens.toLocaleString()}\n`);
  ctx.ui.write(`  Output tokens: ${stats.llm.outputTokens.toLocaleString()}\n`);
  ctx.ui.write(`  Total tokens: ${stats.llm.totalTokens.toLocaleString()}\n`);
  ctx.ui.write('\n');

  ctx.ui.write('🔧 Tool Usage:\n');
  ctx.ui.write(`  Total calls: ${stats.tools.totalCalls}\n`);
  ctx.ui.write(`  Successful: ${stats.tools.successful}\n`);
  ctx.ui.write(`  Failed: ${stats.tools.failed}\n`);
  ctx.ui.write('  By tool:\n');
  for (const [tool, count] of Object.entries(stats.tools.byTool)) {
    ctx.ui.write(`    ${tool}: ${count}\n`);
  }
  ctx.ui.write('\n');

  ctx.ui.write('⏱️  Timing:\n');
  ctx.ui.write(`  Started: ${stats.timing.startedAt}\n`);
  ctx.ui.write(`  Completed: ${stats.timing.completedAt}\n`);
  ctx.ui.write(`  Duration: ${stats.timing.durationFormatted}\n`);
  ctx.ui.write('\n');

  ctx.ui.write('💰 Cost:\n');
  ctx.ui.write(`  Total: $${stats.cost.total.toFixed(4)} ${stats.cost.currency}\n`);
  ctx.ui.write('\n');

  if (stats.errors > 0) {
    ctx.ui.write(`⚠️  Errors: ${stats.errors}\n`);
    ctx.ui.write('\n');
  }
}

/**
 * Create error response
 */
function error(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:stats',
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
