/**
 * Result processor that collects and enriches metrics
 */

import type { ResultProcessor, TaskResult, TraceEntry } from '@kb-labs/agent-contracts';

/**
 * Collects detailed metrics from trace
 */
export class MetricsCollectorProcessor implements ResultProcessor {
  async process(result: TaskResult): Promise<TaskResult> {
    if (!result.trace || result.trace.length === 0) {
      return result;
    }

    const metrics = this.calculateMetrics(result.trace);

    return {
      ...result,
      metrics,
    };
  }

  private calculateMetrics(trace: TraceEntry[]): Record<string, unknown> {
    const llmCalls = trace.filter(e => e.type === 'llm_call');
    const toolCalls = trace.filter(e => e.type === 'tool_call');
    const toolResults = trace.filter(e => e.type === 'tool_result');

    const llmDuration = llmCalls.reduce((sum, e) => sum + (e.durationMs || 0), 0);
    const toolDuration = toolCalls.reduce((sum, e) => sum + (e.durationMs || 0), 0);
    const totalDuration = trace.reduce((sum, e) => sum + (e.durationMs || 0), 0);

    // Tool success rate
    const successfulTools = toolResults.filter(e => e.data.success === true).length;
    const toolSuccessRate = toolResults.length > 0
      ? (successfulTools / toolResults.length) * 100
      : 0;

    // Tool usage breakdown
    const toolUsage: Record<string, number> = {};
    for (const call of toolCalls) {
      const toolName = call.data.toolName as string;
      toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
    }

    return {
      llmCalls: llmCalls.length,
      toolCalls: toolCalls.length,
      totalDuration,
      llmDuration,
      toolDuration,
      avgLLMDuration: llmCalls.length > 0 ? llmDuration / llmCalls.length : 0,
      avgToolDuration: toolCalls.length > 0 ? toolDuration / toolCalls.length : 0,
      toolSuccessRate,
      toolUsage,
      efficiency: {
        llmTimePercent: totalDuration > 0 ? (llmDuration / totalDuration) * 100 : 0,
        toolTimePercent: totalDuration > 0 ? (toolDuration / totalDuration) * 100 : 0,
      },
    };
  }
}
