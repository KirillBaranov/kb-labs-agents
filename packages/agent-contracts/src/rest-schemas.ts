/**
 * REST API Schemas for Agent Execution
 *
 * Zod schemas for REST API request/response validation
 */

import { z } from "zod";

/**
 * Request to run an agent
 */
export const RunAgentRequestSchema = z.object({
  /** Agent ID to execute */
  agentId: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9-]+$/,
      "Agent ID must be lowercase alphanumeric with hyphens",
    ),
  /** Task description for the agent */
  task: z.string().min(1),
  /** Optional progress streaming (future: SSE support) */
  stream: z.boolean().optional().default(false),
});

/**
 * Tool call information in response
 */
export const ToolCallInfoSchema = z.object({
  /** Tool name */
  name: z.string(),
  /** Tool input */
  input: z.unknown(),
  /** Tool output */
  output: z.string().optional(),
  /** Whether tool execution succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
  /** Duration in milliseconds */
  durationMs: z.number().optional(),
});

/**
 * Execution step information
 */
export const ExecutionStepSchema = z.object({
  /** Step number */
  step: z.number().int().positive(),
  /** Tool calls in this step */
  toolCalls: z.array(ToolCallInfoSchema).optional(),
  /** Tokens used in this step */
  tokensUsed: z.number().int().nonnegative().optional(),
  /** Step duration */
  durationMs: z.number().nonnegative().optional(),
});

/**
 * Agent execution statistics
 */
export const AgentStatsSchema = z.object({
  /** Total steps executed */
  steps: z.number().int().nonnegative(),
  /** Total tokens used */
  totalTokens: z.number().int().nonnegative(),
  /** Total duration in milliseconds */
  durationMs: z.number().nonnegative(),
  /** Number of tool calls made */
  toolCallCount: z.number().int().nonnegative().optional(),
  /** Tools used (unique names) */
  toolsUsed: z.array(z.string()).optional(),
});

/**
 * Response from running an agent (success)
 */
export const RunAgentResponseSchema = z.object({
  /** Whether execution succeeded */
  success: z.literal(true),
  /** Agent ID that was executed */
  agentId: z.string(),
  /** Task that was executed */
  task: z.string(),
  /** Final result/answer from agent */
  result: z.string(),
  /** Execution statistics */
  stats: AgentStatsSchema,
  /** Execution steps (for debugging) */
  steps: z.array(ExecutionStepSchema).optional(),
});

/**
 * Response from running an agent (error)
 */
export const RunAgentErrorResponseSchema = z.object({
  /** Whether execution succeeded */
  success: z.literal(false),
  /** Agent ID that was executed */
  agentId: z.string(),
  /** Task that was attempted */
  task: z.string(),
  /** Error details */
  error: z.object({
    /** Error message */
    message: z.string(),
    /** Error code */
    code: z.string().optional(),
    /** Stack trace (development only) */
    stack: z.string().optional(),
  }),
  /** Partial execution statistics (if any) */
  stats: AgentStatsSchema.optional(),
  /** Partial execution steps (if any) */
  steps: z.array(ExecutionStepSchema).optional(),
});

/**
 * Union type for agent response
 */
export const AgentResponseSchema = z.union([
  RunAgentResponseSchema,
  RunAgentErrorResponseSchema,
]);

/**
 * List agents request (query params)
 */
export const ListAgentsRequestSchema = z.object({
  /** Filter by tag */
  tag: z.string().optional(),
  /** Return full config or just metadata */
  full: z.boolean().optional().default(false),
});

/**
 * Agent metadata (lightweight)
 */
export const AgentMetadataSchema = z.object({
  /** Agent ID */
  id: z.string(),
  /** Agent name */
  name: z.string(),
  /** Description */
  description: z.string().optional(),
  /** Available tools */
  tools: z.array(z.string()).optional(),
});

/**
 * List agents response
 */
export const ListAgentsResponseSchema = z.object({
  /** List of available agents */
  agents: z.array(AgentMetadataSchema),
  /** Total count */
  total: z.number().int().nonnegative(),
});

// Type exports
export type RunAgentRequest = z.infer<typeof RunAgentRequestSchema>;
export type RunAgentResponse = z.infer<typeof RunAgentResponseSchema>;
export type RunAgentErrorResponse = z.infer<typeof RunAgentErrorResponseSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type ToolCallInfo = z.infer<typeof ToolCallInfoSchema>;
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
export type AgentStats = z.infer<typeof AgentStatsSchema>;
export type ListAgentsRequest = z.infer<typeof ListAgentsRequestSchema>;
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;
