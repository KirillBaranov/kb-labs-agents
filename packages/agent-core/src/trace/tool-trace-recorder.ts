/**
 * ToolTraceRecorder - Runtime Proxy for Recording Tool Invocations
 *
 * Wraps ToolExecutor to automatically record every tool call to ToolTrace.
 * This is the runtime truth system for verification.
 */

import { randomUUID, createHash } from "node:crypto";
import type {
  ToolCall,
  ToolResult,
  ToolInvocation,
  EvidenceRef,
} from "@kb-labs/agent-contracts";
import type { IToolTraceStore } from "./tool-trace-store.js";

/**
 * Tool trace recorder configuration
 */
export interface ToolTraceRecorderConfig {
  /** Trace ID to record invocations to */
  traceId: string;
  /** Tool trace store */
  store: IToolTraceStore;
  /** Purpose of tool invocations (execution or verification) */
  purpose?: "execution" | "verification";
}

/**
 * ToolTraceRecorder
 *
 * Records tool invocations to ToolTrace during execution.
 * Acts as a runtime proxy around tool execution.
 */
export class ToolTraceRecorder {
  private config: ToolTraceRecorderConfig;

  constructor(config: ToolTraceRecorderConfig) {
    this.config = config;
  }

  /**
   * Record a tool invocation (before execution)
   *
   * Creates a ToolInvocation record and appends it to the trace.
   * Returns the invocationId for updating after execution.
   *
   * @param toolCall - Tool call to record
   * @returns Invocation ID for later update
   */
  async recordStart(toolCall: ToolCall): Promise<string> {
    const invocationId = randomUUID();
    const argsHash = this.hashArgs(toolCall.input);

    // Create invocation record (will be updated with result later)
    const invocation: ToolInvocation = {
      invocationId,
      tool: toolCall.name,
      argsHash,
      args: toolCall.input,
      timestamp: new Date(),
      purpose: this.config.purpose || "execution",
      status: "success", // Will be updated
      evidenceRefs: [],
      // output, durationMs, error will be added later
    };

    // Append to trace
    await this.config.store.append(this.config.traceId, invocation);

    return invocationId;
  }

  /**
   * Record tool invocation result (after execution)
   *
   * Updates the ToolInvocation record with execution results.
   * This method modifies the invocation in-place in the trace.
   *
   * @param invocationId - Invocation ID from recordStart()
   * @param toolCall - Original tool call
   * @param result - Tool execution result
   * @param durationMs - Execution duration
   */
  async recordResult(
    invocationId: string,
    toolCall: ToolCall,
    result: ToolResult,
    durationMs: number,
  ): Promise<void> {
    // Load the trace to update the invocation
    const trace = await this.config.store.load(`trace:${this.config.traceId}`);
    const invocation = trace.invocations.find(
      (inv) => inv.invocationId === invocationId,
    );

    if (!invocation) {
      throw new Error(`Invocation not found: ${invocationId}`);
    }

    // Update status based on result
    if (result.success) {
      invocation.status = "success";
      invocation.output = result.output;
    } else {
      invocation.status =
        result.error?.code === "TIMEOUT" ? "timeout" : "error";
      invocation.error = result.error
        ? {
            code: result.error.code,
            message: result.error.message,
            stack: undefined, // Add if available
          }
        : undefined;
    }

    // Add duration
    invocation.durationMs = durationMs;

    // Generate evidence refs based on tool type
    invocation.evidenceRefs = this.generateEvidenceRefs(toolCall, result);

    // Generate digest for fast verification
    invocation.digest = this.generateDigest(toolCall, result);
  }

  /**
   * Hash tool arguments for deduplication
   *
   * Creates SHA-256 hash of arguments for detecting duplicate calls.
   *
   * @param args - Tool arguments
   * @returns SHA-256 hash (hex)
   */
  private hashArgs(args: unknown): string {
    const normalized =
      typeof args === "string"
        ? args
        : JSON.stringify(args, Object.keys((args as any) || {}).sort());

    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Generate evidence references for verification
   *
   * Creates EvidenceRef records based on tool type and result.
   * These provide proof that the tool was executed.
   *
   * @param toolCall - Tool call
   * @param result - Tool execution result
   * @returns Array of evidence references
   */
  private generateEvidenceRefs(
    toolCall: ToolCall,
    result: ToolResult,
  ): EvidenceRef[] {
    const refs: EvidenceRef[] = [];

    // For filesystem tools, record file paths as evidence
    if (toolCall.name.startsWith("fs:")) {
      const input = toolCall.input as Record<string, any> | undefined;
      const path = input?.path;

      if (path) {
        refs.push({
          kind: "file",
          ref: path,
          // TODO: Add SHA-256 hash of file content for verification
        });
      }
    }

    // For shell tools, record command as log evidence
    if (toolCall.name.startsWith("shell:")) {
      const input = toolCall.input as Record<string, any> | undefined;
      const command = input?.command;

      if (command) {
        refs.push({
          kind: "log",
          ref: `shell:${command}`,
          meta: {
            exitCode: result.success ? 0 : 1,
          },
        });
      }
    }

    // For plugin tools, record invocation as receipt
    if (
      toolCall.name.includes(":") &&
      !toolCall.name.startsWith("fs:") &&
      !toolCall.name.startsWith("shell:")
    ) {
      refs.push({
        kind: "receipt",
        ref: toolCall.name,
        sha256: this.hashArgs(toolCall.input),
        meta: {
          success: result.success,
        },
      });
    }

    return refs;
  }

  /**
   * Generate execution digest for fast verification
   *
   * Summarizes key events and metrics without parsing full output.
   *
   * @param toolCall - Tool call
   * @param result - Tool execution result
   * @returns Execution digest
   */
  private generateDigest(
    toolCall: ToolCall,
    result: ToolResult,
  ): ToolInvocation["digest"] {
    const keyEvents: string[] = [];
    const counters: Record<string, number> = {};

    // Track success/failure
    if (result.success) {
      keyEvents.push("success");
    } else {
      keyEvents.push("failed");
      counters.errors = 1;
    }

    // Track tool category
    if (toolCall.name.startsWith("fs:")) {
      keyEvents.push("filesystem");

      // Track specific filesystem operations
      if (toolCall.name === "fs:write") {
        keyEvents.push("file_created");
        counters.files_written = 1;
      } else if (toolCall.name === "fs:edit") {
        keyEvents.push("file_modified");
        counters.files_edited = 1;
      } else if (toolCall.name === "fs:read") {
        keyEvents.push("file_read");
        counters.files_read = 1;
      }
    } else if (toolCall.name.startsWith("shell:")) {
      keyEvents.push("shell");
      counters.commands_executed = 1;
    } else if (toolCall.name.startsWith("code:")) {
      keyEvents.push("code_analysis");
    } else {
      keyEvents.push("plugin_tool");
    }

    // Track from cache
    if (result.metadata?.fromCache) {
      keyEvents.push("from_cache");
    }

    return {
      keyEvents,
      counters,
    };
  }
}

/**
 * Create a tool trace recorder
 *
 * Factory function for creating recorder.
 *
 * @param config - Recorder configuration
 * @returns ToolTraceRecorder instance
 */
export function createToolTraceRecorder(
  config: ToolTraceRecorderConfig,
): ToolTraceRecorder {
  return new ToolTraceRecorder(config);
}
