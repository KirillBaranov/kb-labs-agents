/**
 * Zod Schemas for Agent Configuration Validation
 *
 * Provides runtime validation for agent configs loaded from YAML
 */

import { z } from 'zod';

/**
 * Agent schema version
 */
export const AgentSchemaSchema = z.literal('kb.agent/1');

/**
 * LLM configuration schema
 */
export const AgentLLMConfigSchema = z.object({
  tier: z.enum(['small', 'medium', 'large']),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().positive(),
  maxToolCalls: z.number().int().positive().default(20).optional(),
});

/**
 * Prompt configuration schema
 */
export const AgentPromptConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  examples: z.string().optional(),
});

/**
 * Context file schema
 */
export const AgentContextFileSchema = z.object({
  path: z.string(),
  description: z.string().optional(),
});

/**
 * Context configuration schema
 */
export const AgentContextConfigSchema = z.object({
  files: z.array(AgentContextFileSchema).optional(),
});

/**
 * KB Labs tools configuration schema
 */
export const AgentKBLabsToolsConfigSchema = z.object({
  mode: z.enum(['allowlist', 'denylist']),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

/**
 * Filesystem permissions schema
 */
export const AgentFilesystemPermissionsSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
});

/**
 * Filesystem configuration schema
 */
export const AgentFilesystemConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['allowlist', 'denylist']).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  permissions: AgentFilesystemPermissionsSchema.optional(),
});

/**
 * Shell configuration schema
 */
export const AgentShellConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['allowlist', 'denylist']).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
});

/**
 * Tools configuration schema
 */
export const AgentToolsConfigSchema = z.object({
  kbLabs: AgentKBLabsToolsConfigSchema.optional(),
  filesystem: AgentFilesystemConfigSchema.optional(),
  shell: AgentShellConfigSchema.optional(),
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
 * Complete agent configuration schema
 */
export const AgentConfigV1Schema = z.object({
  schema: AgentSchemaSchema,
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Agent ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1),
  description: z.string().optional(),
  llm: AgentLLMConfigSchema,
  prompt: AgentPromptConfigSchema.optional(),
  context: AgentContextConfigSchema.optional(),
  tools: AgentToolsConfigSchema,
  policies: AgentPolicyConfigSchema.optional(),
});

/**
 * Tool input schema validator
 */
export const ToolInputSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.unknown()),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});

/**
 * Tool definition schema
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: ToolInputSchemaSchema,
});

/**
 * Tool call schema
 */
export const ToolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
  id: z.string().optional(),
});

/**
 * Tool error schema
 */
export const ToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

/**
 * Tool result schema
 */
export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  error: ToolErrorSchema.optional(),
  metadata: z.object({
    durationMs: z.number().optional(),
    tokensUsed: z.number().optional(),
  }).passthrough().optional(),
});

/**
 * Parse and validate agent configuration
 */
export function parseAgentConfig(data: unknown): z.infer<typeof AgentConfigV1Schema> {
  return AgentConfigV1Schema.parse(data);
}

/**
 * Validate agent configuration without throwing
 */
export function validateAgentConfig(data: unknown): {
  success: boolean;
  data?: z.infer<typeof AgentConfigV1Schema>;
  error?: z.ZodError;
} {
  const result = AgentConfigV1Schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
