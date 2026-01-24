/**
 * Schema Validator - Runtime Validation for Plugin Tool Outputs
 *
 * Validates plugin tool outputs against their declared schemas before
 * returning to the agent. This is part of the anti-hallucination system.
 */

import type { ToolResult } from "@kb-labs/agent-contracts";
import { getSchemaLoader } from "../verification/plugin-schema-loader.js";
import type { z } from "zod";

/**
 * Schema validator interface
 *
 * Validates tool outputs against plugin manifest schemas.
 * This runs BEFORE returning results to agent to prevent hallucinated outputs.
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
  async validate(
    _toolName: string,
    output: unknown,
  ): Promise<ValidationResult> {
    // Always pass validation in Phase 1
    return {
      valid: true,
      output,
    };
  }
}

/**
 * Zod schema validator
 *
 * Validates plugin tool outputs against Zod schemas from plugin manifests.
 * Uses PluginSchemaLoader for dynamic schema resolution.
 */
export class ZodSchemaValidator implements ISchemaValidator {
  /**
   * Schema reference registry
   *
   * Maps tool names to schema references (e.g., "mind:rag-query" -> "@kb-labs/mind/schema#QueryResult")
   * This would be populated from plugin manifests in production.
   */
  private schemaRefRegistry = new Map<string, string>();

  /**
   * Register schema reference for a tool
   *
   * @param toolName - Tool name (e.g., "mind:rag-query")
   * @param schemaRef - Schema reference (e.g., "@kb-labs/mind/schema#QueryResult")
   */
  registerSchema(toolName: string, schemaRef: string): void {
    this.schemaRefRegistry.set(toolName, schemaRef);
  }

  async validate(toolName: string, output: unknown): Promise<ValidationResult> {
    // 1. Look up schema reference from registry
    const schemaRef = this.schemaRefRegistry.get(toolName);
    if (!schemaRef) {
      // No schema registered - pass through (opt-in validation)
      return {
        valid: true,
        output,
      };
    }

    // 2. Resolve Zod schema using PluginSchemaLoader
    const loader = getSchemaLoader();
    const schema = await loader.loadSchema(schemaRef);

    if (!schema) {
      // Schema not found - fail validation
      return {
        valid: false,
        errors: [
          {
            path: "",
            message: `Schema not found: ${schemaRef}`,
          },
        ],
      };
    }

    // 3. Parse output using schema.safeParse()
    const result = schema.safeParse(output);

    if (!result.success) {
      // 4. Return validation errors
      const errors = result.error.errors.map((err) => ({
        path: err.path.join("."),
        message: err.message,
        expected: "expected" in err ? String(err.expected) : undefined,
        actual: "received" in err ? err.received : undefined,
      }));

      return {
        valid: false,
        errors,
      };
    }

    // Validation passed - return coerced output
    return {
      valid: true,
      output: result.data,
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
  result: ToolResult,
): Promise<ToolResult> {
  // Skip validation if tool failed
  if (!result.success) {
    return result;
  }

  // Skip validation for built-in tools (fs:*, shell:*, code:*)
  // Only validate plugin tools (third-party)
  if (
    toolName.startsWith("fs:") ||
    toolName.startsWith("shell:") ||
    toolName.startsWith("code:")
  ) {
    return result;
  }

  // Validate output
  const validation = await validator.validate(toolName, result.output);

  if (!validation.valid) {
    // Validation failed - return error instead of potentially hallucinated output
    return {
      success: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
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
