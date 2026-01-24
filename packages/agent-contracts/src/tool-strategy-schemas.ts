/**
 * Zod Schemas for Tool Strategy Configuration
 */

import { z } from "zod";

/**
 * Tool strategy mode
 */
export const ToolStrategyModeSchema = z.enum([
  "prioritized",
  "gated",
  "unrestricted",
]);

/**
 * Tool group schema
 */
export const ToolGroupSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().positive(),
  tools: z.array(z.string().min(1)),
  hints: z.array(z.string()).optional(),
  unlockAfter: z.string().optional(),
  unlockWhenConfidenceBelow: z.number().min(0).max(1).optional(),
});

/**
 * Filesystem permissions schema
 */
export const FsPermissionsSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
});

/**
 * Shell permissions schema
 */
export const ShellPermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

/**
 * KB Labs permissions schema
 */
export const KBLabsPermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

/**
 * Tool permissions schema
 */
export const ToolPermissionsSchema = z.object({
  fs: FsPermissionsSchema.optional(),
  shell: ShellPermissionsSchema.optional(),
  kbLabs: KBLabsPermissionsSchema.optional(),
});

/**
 * Built-in tools config schema
 */
export const BuiltInToolsConfigSchema = z.object({
  fs: z.boolean().optional(),
  shell: z.boolean().optional(),
  code: z.boolean().optional(),
});

/**
 * Complete tool strategy config schema
 */
export const ToolStrategyConfigSchema = z.object({
  strategy: ToolStrategyModeSchema,
  groups: z.array(ToolGroupSchema).optional(),
  permissions: ToolPermissionsSchema.optional(),
  builtIn: BuiltInToolsConfigSchema.optional(),
});

/**
 * Validate tool strategy config
 */
export function validateToolStrategyConfig(data: unknown): {
  success: boolean;
  data?: z.infer<typeof ToolStrategyConfigSchema>;
  error?: z.ZodError;
} {
  const result = ToolStrategyConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: result.error };
  }
}
