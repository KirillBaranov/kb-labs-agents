/**
 * Dynamic Output Tool Builder
 *
 * Builds submit_result tool from agent configuration.
 * Completely data-driven - no hardcoded schemas.
 */

import type { z } from "zod";
import { jsonSchemaToZod } from "./schema-converter.js";
import type {
  AgentConfigV1,
  ToolDefinition,
  ToolInputSchema,
} from "@kb-labs/agent-contracts";

/**
 * Output tool with validation
 * Internal representation that includes Zod schema for validation
 */
export interface OutputToolWithValidation {
  /** Tool definition for LLM (with JSON Schema) */
  definition: ToolDefinition;
  /** Zod schema for runtime validation */
  zodSchema: z.ZodType;
}

/**
 * Build output submission tool from agent config
 *
 * @param agentConfig - Agent configuration with optional output schema
 * @returns Output tool if schema defined, null if legacy mode
 */
export function buildOutputTool(
  agentConfig: AgentConfigV1,
): OutputToolWithValidation | null {
  // Legacy mode: no output schema defined
  if (!agentConfig.output?.schema) {
    return null;
  }

  const jsonSchema = agentConfig.output.schema as any;

  // Validate that schema is object type
  if (jsonSchema.type !== "object") {
    throw new Error(
      `Agent ${agentConfig.id} output schema must be type 'object', got '${jsonSchema.type}'`,
    );
  }

  // Convert JSON Schema → Zod Schema for validation
  let zodSchema: z.ZodType;
  try {
    zodSchema = jsonSchemaToZod(jsonSchema);
  } catch (err) {
    throw new Error(
      `Failed to build output tool for agent ${agentConfig.id}: ${(err as Error).message}`,
    );
  }

  return {
    definition: {
      name: "submit_result",
      description: `Submit final results to the orchestrator.

⚠️ CRITICAL: You MUST call this tool to return your findings!

The orchestrator will NOT see your text responses - only tool call results are captured.

Workflow:
1. Use input tools (fs:read, mind:rag-query, etc) to gather information
2. Analyze and process the data
3. Call submit_result() with structured results

Do NOT forget step 3 or your work will be lost!`,
      inputSchema: jsonSchema as ToolInputSchema,
    },
    zodSchema,
  };
}

/**
 * Check if agent uses structured output
 *
 * @param agentConfig - Agent configuration
 * @returns True if agent has output schema (structured mode)
 */
export function usesStructuredOutput(agentConfig: AgentConfigV1): boolean {
  return !!agentConfig.output?.schema;
}

/**
 * Get expected output type name for agent
 * Useful for error messages and debugging
 *
 * @param agentConfig - Agent configuration
 * @returns Human-readable output type name
 */
export function getOutputTypeName(agentConfig: AgentConfigV1): string {
  if (!agentConfig.output?.schema) {
    return "free-form text";
  }

  // Try to extract a meaningful name from schema
  const schema = agentConfig.output.schema as any;
  if (schema.title) {
    return schema.title;
  }

  // Default: agent ID + "Result"
  return `${agentConfig.id}Result`;
}
