/**
 * Schema Validator - Runtime Validation for Plugin Tool Outputs
 *
 * Validates plugin tool outputs against their declared schemas before
 * returning to the specialist. This is part of the anti-hallucination system.
 */

import type { ToolResult } from '@kb-labs/agent-contracts';

/**
 * Schema validator interface
 *
 * Validates tool outputs against plugin manifest schemas.
 * This runs BEFORE returning results to specialist to prevent hallucinated outputs.
 */
export interface ISchemaValidator {
  /**
   * Validate tool output against schema
   *
   * @param toolName - Tool name (e.g., "mind:rag-query")
   * @param output - Tool output to validate
   * @returns Validation result
   */
  validate(toolName: string, output: unknown): Promise<ValidationResult>;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation errors (if any) */
  errors?: ValidationError[];
  /** Validated output (coerced to schema type) */
  output?: unknown;
}

/**
 * Validation error
 */
export interface ValidationError {
  /** Error path (e.g., "data.results[0].score") */
  path: string;
  /** Error message */
  message: string;
  /** Expected type/value */
  expected?: string;
  /** Actual value */
  actual?: unknown;
}

/**
 * No-op schema validator (for Phase 1)
 *
 * This is a placeholder that always passes validation.
 * In Phase 2, we'll implement actual schema validation using Zod.
 *
 * Why defer actual validation to Phase 2:
 * - Phase 1 focuses on trace infrastructure (recording tool calls)
 * - Phase 2 will add schema resolution from plugin manifests
 * - Phase 3 will integrate with verifier
 */
export class NoOpSchemaValidator implements ISchemaValidator {
  async validate(_toolName: string, output: unknown): Promise<ValidationResult> {
    // Always pass validation in Phase 1
    return {
      valid: true,
      output,
    };
  }
}

/**
 * Zod schema validator (Phase 2 implementation)
 *
 * This will validate outputs against Zod schemas from plugin manifests.
 * For now, it's a stub that will be implemented in Phase 2.
 */
export class ZodSchemaValidator implements ISchemaValidator {
  // TODO: Phase 2 - implement schema resolution from plugin manifests
  // private schemaRegistry: Map<string, ZodSchema>;

  async validate(toolName: string, output: unknown): Promise<ValidationResult> {
    // TODO: Phase 2 implementation
    // 1. Look up schema from plugin manifest
    // 2. Resolve Zod schema reference (e.g., "./schemas/query.ts#QueryResultSchema")
    // 3. Parse output using schema.safeParse()
    // 4. Return validation result with errors if any

    // For now, pass everything through
    return {
      valid: true,
      output,
    };
  }
}

/**
 * Create a schema validator
 *
 * Factory function for creating validator.
 * Returns NoOpSchemaValidator for Phase 1.
 */
export function createSchemaValidator(): ISchemaValidator {
  return new NoOpSchemaValidator();
}

/**
 * Wrap tool result with schema validation
 *
 * Helper function to validate tool output and wrap in ToolResult.
 * Used by ToolExecutor before returning results.
 *
 * @param validator - Schema validator
 * @param toolName - Tool name
 * @param result - Tool execution result
 * @returns Validated tool result
 */
export async function validateToolResult(
  validator: ISchemaValidator,
  toolName: string,
  result: ToolResult
): Promise<ToolResult> {
  // Skip validation if tool failed
  if (!result.success) {
    return result;
  }

  // Skip validation for built-in tools (fs:*, shell:*, code:*)
  // Only validate plugin tools (third-party)
  if (toolName.startsWith('fs:') || toolName.startsWith('shell:') || toolName.startsWith('code:')) {
    return result;
  }

  // Validate output
  const validation = await validator.validate(toolName, result.output);

  if (!validation.valid) {
    // Validation failed - return error instead of potentially hallucinated output
    return {
      success: false,
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        message: `Tool output failed schema validation: ${toolName}`,
        details: validation.errors,
      },
      metadata: result.metadata,
    };
  }

  // Validation passed - return result with validated output
  return {
    ...result,
    output: validation.output as string | undefined,
  };
}
