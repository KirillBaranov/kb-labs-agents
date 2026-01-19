/**
 * Zod Schemas for Specialist Configuration Validation
 *
 * Provides runtime validation for specialist configs loaded from YAML
 */

import { z } from 'zod';
import { AgentLLMConfigSchema, AgentPolicyConfigSchema } from './agent-schemas.js';
import { ToolStrategyConfigSchema } from './tool-strategy-schemas.js';

/**
 * Specialist schema version
 */
export const SpecialistSchemaSchema = z.literal('kb.specialist/1');

/**
 * Execution limits schema
 */
export const SpecialistLimitsSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  forcedReasoningInterval: z.number().int().positive().default(3).optional(),
});

/**
 * Static context schema
 */
export const SpecialistStaticContextSchema = z.object({
  system: z.string().optional(),
  contextFile: z.string().optional(),
});

/**
 * Dynamic context schema
 */
export const SpecialistDynamicContextSchema = z.object({
  enabled: z.boolean(),
  scope: z.string().optional(),
  maxChunks: z.number().int().positive().optional(),
});

/**
 * Context configuration schema
 */
export const SpecialistContextConfigSchema = z.object({
  static: SpecialistStaticContextSchema.optional(),
  dynamic: SpecialistDynamicContextSchema.optional(),
});

/**
 * Input schema
 */
export const SpecialistInputSchemaSchema = z.object({
  schema: z.unknown(), // JSON Schema - can be any valid JSON structure
});

/**
 * Output schema
 */
export const SpecialistOutputSchemaSchema = z.object({
  schema: z.unknown(), // JSON Schema - can be any valid JSON structure
});

/**
 * Specialist capabilities enum
 */
export const SpecialistCapabilitySchema = z.enum([
  'code-search',
  'code-reading',
  'code-writing',
  'code-editing',
  'architecture-analysis',
  'dependency-analysis',
  'command-execution',
  'testing',
  'documentation',
]);

/**
 * Specialist metadata schema (optional orchestrator hints)
 */
export const SpecialistMetadataInlineSchema = z
  .object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    examples: z.array(z.string()).optional(),
  })
  .optional();

/**
 * Complete specialist configuration schema
 */
export const SpecialistConfigV1Schema = z.object({
  schema: SpecialistSchemaSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: SpecialistMetadataInlineSchema,
  llm: AgentLLMConfigSchema,
  limits: SpecialistLimitsSchema,
  capabilities: z.array(SpecialistCapabilitySchema).optional(),
  context: SpecialistContextConfigSchema.optional(),
  tools: ToolStrategyConfigSchema,
  constraints: z.array(z.string()).optional(),
  input: SpecialistInputSchemaSchema.optional(),
  output: SpecialistOutputSchemaSchema.optional(),
  policies: AgentPolicyConfigSchema.optional(),
});

/**
 * Parse specialist config from unknown data
 *
 * @param data - Raw data (e.g., from YAML.parse)
 * @returns Parsed and validated specialist config
 * @throws ZodError if validation fails
 */
export function parseSpecialistConfig(data: unknown) {
  return SpecialistConfigV1Schema.parse(data);
}

/**
 * Validate specialist config (returns success/error)
 *
 * @param data - Raw data to validate
 * @returns Validation result with data or error
 */
export function validateSpecialistConfig(data: unknown): {
  success: boolean;
  data?: z.infer<typeof SpecialistConfigV1Schema>;
  error?: z.ZodError;
} {
  const result = SpecialistConfigV1Schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: result.error };
  }
}
