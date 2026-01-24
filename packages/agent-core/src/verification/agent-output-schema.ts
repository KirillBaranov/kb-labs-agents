/**
 * Agent Output Schema - Zod Validation
 *
 * Level 1 validation: Validates AgentOutput structure
 * before checking plugin schemas or content.
 *
 * Part of the anti-hallucination verification system (ADR-0002).
 */

import { z } from "zod";

/**
 * Evidence reference schema
 */
export const EvidenceRefSchema = z.object({
  kind: z.enum(["file", "http", "receipt", "log", "hash"]),
  ref: z.string(),
  sha256: z.string().optional(),
  meta: z.unknown().optional(),
});

/**
 * File write claim schema
 */
export const FileWriteClaimSchema = z.object({
  kind: z.literal("file-write"),
  filePath: z.string(),
  contentHash: z.string(),
});

/**
 * File edit claim schema
 */
export const FileEditClaimSchema = z.object({
  kind: z.literal("file-edit"),
  filePath: z.string(),
  anchor: z.object({
    beforeSnippet: z.string(),
    afterSnippet: z.string(),
    contentHash: z.string(),
  }),
  editedRegion: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});

/**
 * File delete claim schema
 */
export const FileDeleteClaimSchema = z.object({
  kind: z.literal("file-delete"),
  filePath: z.string(),
});

/**
 * Command executed claim schema
 */
export const CommandExecutedClaimSchema = z.object({
  kind: z.literal("command-executed"),
  command: z.string(),
  exitCode: z.number(),
});

/**
 * Code inserted claim schema
 */
export const CodeInsertedClaimSchema = z.object({
  kind: z.literal("code-inserted"),
  filePath: z.string(),
  anchor: z.object({
    beforeSnippet: z.string(),
    afterSnippet: z.string(),
    contentHash: z.string(),
  }),
});

/**
 * Claim schema (discriminated union)
 */
export const ClaimSchema = z.discriminatedUnion("kind", [
  FileWriteClaimSchema,
  FileEditClaimSchema,
  FileDeleteClaimSchema,
  CommandExecutedClaimSchema,
  CodeInsertedClaimSchema,
]);

/**
 * Compact artifact schema
 */
export const CompactArtifactSchema = z.object({
  kind: z.enum(["code-snippet", "summary", "data"]),
  label: z.string(),
  content: z.string().max(1024, "Artifact content must be < 1KB"),
  contentHash: z.string(),
  sourceTool: z.string().optional(),
});

/**
 * Agent output schema (Level 1 validation)
 *
 * Validates the structure of agent output before
 * checking plugin schemas or filesystem state.
 */
export const AgentOutputSchema = z.object({
  /** Summary of what was accomplished */
  summary: z.string().min(1, "Summary is required"),

  /**
   * Trace reference (REQUIRED)
   *
   * Format: "trace:<traceId>"
   */
  traceRef: z.string().regex(/^trace:/, 'traceRef must start with "trace:"'),

  /**
   * Optional claims made by agent
   */
  claims: z.array(ClaimSchema).optional(),

  /**
   * Compact artifacts
   */
  artifacts: z.array(CompactArtifactSchema).optional(),
});

/**
 * TypeScript type inferred from schema
 */
export type AgentOutputValidated = z.infer<typeof AgentOutputSchema>;

/**
 * Validation result
 */
export interface AgentOutputValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Validated output (if successful) */
  output?: AgentOutputValidated;

  /** Validation errors (if failed) */
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

/**
 * Validate agent output (Level 1)
 *
 * Checks structure only, not content or plugin schemas.
 *
 * @param output - Raw agent output
 * @returns Validation result
 */
export function validateAgentOutput(
  output: unknown,
): AgentOutputValidationResult {
  const result = AgentOutputSchema.safeParse(output);

  if (result.success) {
    return {
      valid: true,
      output: result.data,
    };
  }

  // Format Zod errors
  const errors = result.error.errors.map((err) => ({
    path: err.path.join("."),
    message: err.message,
  }));

  return {
    valid: false,
    errors,
  };
}
