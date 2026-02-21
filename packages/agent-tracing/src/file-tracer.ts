/**
 * File-based tracer that saves execution traces to JSON files
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tracer, TraceEntry } from '@kb-labs/agent-contracts';

/**
 * File tracer implementation
 */
export class FileTracer implements Tracer {
  private entries: TraceEntry[] = [];
  private taskId: string;
  private sessionId?: string;

  constructor(taskId: string, sessionId?: string) {
    this.taskId = taskId;
    this.sessionId = sessionId;
  }

  /**
   * Record a trace entry
   */
  trace(entry: TraceEntry): void {
    this.entries.push(entry);
  }

  /**
   * Get all trace entries
   */
  getEntries(): TraceEntry[] {
    return [...this.entries];
  }

  /**
   * Save trace to file
   */
  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    const traceData = {
      taskId: this.taskId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      totalEntries: this.entries.length,
      entries: this.entries,
    };

    await fs.writeFile(filePath, JSON.stringify(traceData, null, 2), 'utf-8');
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get trace summary statistics
   */
  getSummary(): {
    totalEntries: number;
    llmCalls: number;
    toolCalls: number;
    totalDuration: number;
    avgLLMDuration: number;
    avgToolDuration: number;
  } {
    const llmCalls = this.entries.filter(e => e.type === 'llm_call');
    const toolCalls = this.entries.filter(e => e.type === 'tool_call');

    const totalDuration = this.entries.reduce((sum, e) => sum + (e.durationMs || 0), 0);
    const llmDuration = llmCalls.reduce((sum, e) => sum + (e.durationMs || 0), 0);
    const toolDuration = toolCalls.reduce((sum, e) => sum + (e.durationMs || 0), 0);

    return {
      totalEntries: this.entries.length,
      llmCalls: llmCalls.length,
      toolCalls: toolCalls.length,
      totalDuration,
      avgLLMDuration: llmCalls.length > 0 ? llmDuration / llmCalls.length : 0,
      avgToolDuration: toolCalls.length > 0 ? toolDuration / toolCalls.length : 0,
    };
  }
}
