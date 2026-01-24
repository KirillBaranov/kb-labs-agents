/**
 * Zod Schemas for Agent Configuration Validation
 *
 * Provides runtime validation for agent configs loaded from YAML
 */

import { z } from "zod";
import { ToolStrategyConfigSchema } from "./tool-strategy-schemas.js";

/**
 * Agent schema version
 */
export const AgentSchemaSchema = z.literal("kb.agent/1");

/**
 * LLM tier schema
 */
const LLMTierSchema = z.enum(["small", "medium", "large"]);

/**
 * LLM configuration schema
 */
export const AgentLLMConfigSchema = z.object({
  tier: LLMTierSchema,
  escalationLadder: z.array(LLMTierSchema).optional(),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().positive(),
});

/**
 * Policy configuration schema
 */
export const AgentPolicyConfigSchema = z.object({
  allowWrite: z.boolean().optional(),
  restrictedPaths: z.array(z.string()).optional(),
  requireConfirmation: z.boolean().optional(),
});

/**
 * Execution limits schema
 */
export const AgentLimitsSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  forcedReasoningInterval: z.number().int().positive().default(3).optional(),
});

/**
 * Static context schema
 */
export const AgentStaticContextSchema = z.object({
  system: z.string().optional(),
  contextFile: z.string().optional(),
});

/**
 * Dynamic context schema
 */
export const AgentDynamicContextSchema = z.object({
  enabled: z.boolean(),
  scope: z.string().optional(),
  maxChunks: z.number().int().positive().optional(),
});

/**
 * Context configuration schema
 */
export const AgentContextConfigSchema = z.object({
  static: AgentStaticContextSchema.optional(),
  dynamic: AgentDynamicContextSchema.optional(),
});

/**
 * Input schema
 */
export const AgentInputSchemaSchema = z.object({
  schema: z.unknown(), // JSON Schema - can be any valid JSON structure
});

/**
 * Output schema
 */
export const AgentOutputSchemaSchema = z.object({
  schema: z.unknown(), // JSON Schema - can be any valid JSON structure
});

/**
 * Agent capabilities enum
 */
export const AgentCapabilitySchema = z.enum([
  "code-search",
  "code-reading",
  "code-writing",
  "code-editing",
  "architecture-analysis",
  "dependency-analysis",
  "command-execution",
  "testing",
  "documentation",
]);

/**
 * Agent metadata schema (optional orchestrator hints)
 */
export const AgentMetadataInlineSchema = z
  .object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    examples: z.array(z.string()).optional(),
  })
  .optional();

/**
 * Complete agent configuration schema
 */
export const AgentConfigV1Schema = z.object({
  schema: AgentSchemaSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: AgentMetadataInlineSchema,
  llm: AgentLLMConfigSchema,
  limits: AgentLimitsSchema,
  capabilities: z.array(AgentCapabilitySchema).optional(),
  context: AgentContextConfigSchema.optional(),
  tools: ToolStrategyConfigSchema,
  constraints: z.array(z.string()).optional(),
  input: AgentInputSchemaSchema.optional(),
  output: AgentOutputSchemaSchema.optional(),
  policies: AgentPolicyConfigSchema.optional(),
});

/**
 * Parse agent config from unknown data
 *
 * @param data - Raw data (e.g., from YAML.parse)
 * @returns Parsed and validated agent config
 * @throws ZodError if validation fails
 */
export function parseAgentConfig(data: unknown) {
  return AgentConfigV1Schema.parse(data);
}

/**
 * Validate agent config (returns success/error)
 *
 * @param data - Raw data to validate
 * @returns Validation result with data or error
 */
export function validateAgentConfig(data: unknown): {
  success: boolean;
  data?: z.infer<typeof AgentConfigV1Schema>;
  error?: z.ZodError;
} {
  const result = AgentConfigV1Schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: result.error };
  }
}
