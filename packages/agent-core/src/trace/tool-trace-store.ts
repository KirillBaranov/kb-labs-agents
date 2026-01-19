/**
 * ToolTraceStore - In-Memory Implementation
 *
 * Storage for tool execution traces during specialist runs.
 * Provides CRUD operations for ToolTrace records.
 */

import { randomUUID } from 'node:crypto';
import type { ToolTrace, ToolInvocation } from '@kb-labs/agent-contracts';

/**
 * ToolTraceStore interface
 *
 * Stores and retrieves tool execution traces for verification.
 */
export interface IToolTraceStore {
  /**
   * Create a new trace for a specialist execution
   *
   * @param sessionId - Session ID (links to orchestrator session)
   * @param specialistId - Specialist ID that will generate this trace
   * @returns Newly created ToolTrace with unique traceId
   */
  create(sessionId: string, specialistId: string): Promise<ToolTrace>;

  /**
   * Append a tool invocation to an existing trace
   *
   * @param traceId - Trace ID to append to
   * @param invocation - Tool invocation record to append
   * @throws Error if trace not found
   */
  append(traceId: string, invocation: ToolInvocation): Promise<void>;

  /**
   * Load a trace by reference
   *
   * @param traceRef - Trace reference (format: "trace:<traceId>")
   * @returns ToolTrace if found
   * @throws Error if trace not found or invalid ref format
   */
  load(traceRef: string): Promise<ToolTrace>;

  /**
   * Complete a trace (mark as finished)
   *
   * @param traceId - Trace ID to complete
   * @throws Error if trace not found
   */
  complete(traceId: string): Promise<void>;

  /**
   * Delete a trace
   *
   * @param traceRef - Trace reference (format: "trace:<traceId>")
   * @throws Error if trace not found or invalid ref format
   */
  delete(traceRef: string): Promise<void>;

  /**
   * Get all traces for a session
   *
   * @param sessionId - Session ID
   * @returns Array of ToolTrace records
   */
  getBySession(sessionId: string): Promise<ToolTrace[]>;

  /**
   * Clear all traces (for testing)
   */
  clear(): Promise<void>;
}

/**
 * In-memory implementation of ToolTraceStore
 *
 * Simple Map-based storage for development and testing.
 * For production, can be replaced with Redis/PostgreSQL backend.
 */
export class InMemoryToolTraceStore implements IToolTraceStore {
  private traces = new Map<string, ToolTrace>();

  async create(sessionId: string, specialistId: string): Promise<ToolTrace> {
    const traceId = randomUUID();
    const trace: ToolTrace = {
      traceId,
      sessionId,
      specialistId,
      invocations: [],
      createdAt: new Date(),
    };

    this.traces.set(traceId, trace);
    return trace;
  }

  async append(traceId: string, invocation: ToolInvocation): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    trace.invocations.push(invocation);
  }

  async load(traceRef: string): Promise<ToolTrace> {
    // Parse traceRef format: "trace:<traceId>"
    if (!traceRef.startsWith('trace:')) {
      throw new Error(`Invalid trace reference format: ${traceRef} (expected "trace:<traceId>")`);
    }

    const traceId = traceRef.substring(6); // Remove "trace:" prefix
    const trace = this.traces.get(traceId);

    if (!trace) {
      throw new Error(`Trace not found: ${traceRef}`);
    }

    return trace;
  }

  async complete(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    trace.completedAt = new Date();
  }

  async delete(traceRef: string): Promise<void> {
    // Parse traceRef format: "trace:<traceId>"
    if (!traceRef.startsWith('trace:')) {
      throw new Error(`Invalid trace reference format: ${traceRef} (expected "trace:<traceId>")`);
    }

    const traceId = traceRef.substring(6); // Remove "trace:" prefix
    const deleted = this.traces.delete(traceId);

    if (!deleted) {
      throw new Error(`Trace not found: ${traceRef}`);
    }
  }

  async getBySession(sessionId: string): Promise<ToolTrace[]> {
    const traces: ToolTrace[] = [];
    for (const trace of this.traces.values()) {
      if (trace.sessionId === sessionId) {
        traces.push(trace);
      }
    }
    return traces;
  }

  async clear(): Promise<void> {
    this.traces.clear();
  }
}

/**
 * Create a ToolTraceStore instance
 *
 * Factory function for creating trace store.
 * Currently returns in-memory implementation.
 */
export function createToolTraceStore(): IToolTraceStore {
  return new InMemoryToolTraceStore();
}
