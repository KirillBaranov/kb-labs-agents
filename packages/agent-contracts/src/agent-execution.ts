/**
 * Agent Execution Types
 *
 * Defines types for agent execution context, results, and runtime state
 */

import type { AgentConfigV1 } from "./agent-config.js";
import type { ToolDefinition } from "./tool-types.js";

/**
 * Agent context (loaded from disk)
 */
export interface AgentContext {
  /** Agent configuration */
  config: AgentConfigV1;
  /** System prompt content (loaded from file if specified) */
  systemPrompt?: string;
  /** Examples content (loaded from file if specified) */
  examples?: string;
  /** Additional context files content */
  contextFiles?: Array<{
    /** File path */
    path: string;
    /** File content */
    content: string;
  }>;
  /** Discovered tools available to the agent */
  tools?: ToolDefinition[];
}

/**
 * Agent execution step (for tracking and debugging)
 */
export interface AgentExecutionStep {
  /** Step number (1-indexed) */
  step: number;
  /** LLM response text */
  response?: string;
  /** Tool calls in this step */
  toolCalls?: Array<{
    /** Tool name */
    name: string;
    /** Tool input */
    input: unknown;
    /** Tool output */
    output: string;
    /** Whether tool execution succeeded */
    success: boolean;
    /** Error if failed */
    error?: string;
  }>;
  /** Tokens used in this step */
  tokensUsed?: number;
  /** Step duration in milliseconds */
  durationMs?: number;
}

/**
 * Loop detection state
 *
 * Tracks patterns to detect when agent is stuck in a loop
 */
export interface LoopDetectionState {
  /** Hash history of last N states (tool calls + responses) */
  stateHashes: string[];
  /** Maximum history size for loop detection (default: 5) */
  maxHistorySize: number;
  /** Identical tool call sequences (for pattern detection) */
  toolCallSequences: Array<{
    /** Sequence of tool names */
    sequence: string[];
    /** How many times this sequence occurred */
    count: number;
    /** Last occurrence step */
    lastSeen: number;
  }>;
  /** Threshold for considering something a loop (default: 3 identical sequences) */
  loopThreshold: number;
}

/**
 * Loop detection result
 */
export interface LoopDetectionResult {
  /** Whether a loop was detected */
  detected: boolean;
  /** Loop type if detected */
  type?:
    | "exact_repeat"
    | "similar_pattern"
    | "tool_sequence_repeat"
    | "stuck_reasoning";
  /** Description of the loop pattern */
  description?: string;
  /** Steps involved in the loop */
  loopSteps?: number[];
  /** Confidence score (0-1) that this is a real loop */
  confidence?: number;
}

/**
 * Progress callback for streaming agent execution updates
 *
 * Optional callbacks to receive real-time progress updates during agent execution.
 * Used for interactive CLI display, logging, or custom progress tracking.
 *
 * All callbacks are optional and use optional chaining for zero-overhead when not provided.
 */
export interface AgentProgressCallback {
  /**
   * Called when a new execution step starts
   * @param step - Current step number (1-indexed)
   * @param maxSteps - Maximum allowed steps
   */
  onStepStart?: (step: number, maxSteps: number) => void;

  /**
   * Called when LLM request starts (before chat completion)
   * @param step - Current step number
   */
  onLLMStart?: (step: number) => void;

  /**
   * Called when LLM response is received
   * @param step - Current step number
   * @param tokens - Tokens used in this response
   * @param content - LLM response text (if any)
   */
  onLLMComplete?: (step: number, tokens: number, content?: string) => void;

  /**
   * Called when a tool call is about to be executed
   * @param tool - Tool name (e.g., "fs:read", "mind:rag-query")
   * @param input - Tool input parameters
   * @param step - Current step number
   */
  onToolStart?: (tool: string, input: unknown, step: number) => void;

  /**
   * Called when a tool call completes
   * @param tool - Tool name
   * @param success - Whether tool execution succeeded
   * @param output - Tool output (if successful)
   * @param error - Error message (if failed)
   * @param durationMs - Tool execution duration
   */
  onToolComplete?: (
    tool: string,
    success: boolean,
    output?: string,
    error?: string,
    durationMs?: number,
  ) => void;

  /**
   * Called when a step completes (after all tool calls)
   * @param step - Step number that completed
   * @param totalTokens - Cumulative tokens used so far
   * @param toolCallCount - Number of tool calls in this step
   */
  onStepComplete?: (
    step: number,
    totalTokens: number,
    toolCallCount: number,
  ) => void;

  /**
   * Called when execution completes (success or failure)
   * @param result - Final execution result
   */
  onComplete?: (result: AgentResult) => void;
}

/**
 * Agent execution result
 */
export interface AgentResult {
  /** Whether agent execution succeeded */
  success: boolean;
  /** Final result/answer from agent */
  result?: string;
  /** Error details if execution failed */
  error?: {
    /** Error message */
    message: string;
    /** Error code */
    code?: string;
    /** Stack trace (if available) */
    stack?: string;
  };
  /** Execution steps (for debugging) */
  steps?: AgentExecutionStep[];
  /** Total tokens used */
  totalTokens?: number;
  /** Total execution duration in milliseconds */
  durationMs?: number;
  /**
   * Tool trace reference (for verification)
   *
   * Format: "trace:<traceId>"
   * Points to ToolTrace containing all tool invocations during execution.
   * Used by verifier to check claims and prevent hallucinations.
   */
  traceRef?: string;
  /** Number of tool calls made */
  toolCallCount?: number;
}

/**
 * Agent runtime state (for tracking during execution)
 */
export interface AgentRuntimeState {
  /** Agent ID */
  agentId: string;
  /** Task being executed */
  task: string;
  /** Tools available to agent */
  tools: ToolDefinition[];
  /** Current step number */
  currentStep: number;
  /** Maximum steps allowed */
  maxSteps: number;
  /** Execution steps so far */
  steps: AgentExecutionStep[];
  /** Total tokens used so far */
  tokensUsed: number;
  /** Start time */
  startTime: number;
  /** Loop detection state */
  loopDetection?: LoopDetectionState;
}

/**
 * Agent template type
 */
export type AgentTemplate = "basic" | "coding" | "testing";

/**
 * Agent template metadata
 */
export interface AgentTemplateMetadata {
  /** Template ID */
  id: AgentTemplate;
  /** Template name */
  name: string;
  /** Template description */
  description: string;
  /** Default configuration for this template */
  defaultConfig: Partial<AgentConfigV1>;
}
