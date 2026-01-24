/**
 * Agent Configuration Validator
 *
 * Validates agent configs at load time to catch errors early.
 */

import { validateJsonSchema } from "./schema-converter.js";
import type { AgentConfigV1 } from "@kb-labs/agent-contracts";

/**
 * Validate agent output schema
 *
 * @param agentConfig - Agent configuration to validate
 * @throws Error if output schema is invalid
 */
export function validateAgentOutputSchema(agentConfig: AgentConfigV1): void {
  // No output schema = legacy mode, OK
  if (!agentConfig.output?.schema) {
    return;
  }

  const schema = agentConfig.output.schema as any;
  const agentId = agentConfig.id;

  // Must be object type (agents must return structured data, not primitives)
  if (schema.type !== "object") {
    throw new Error(
      `Agent "${agentId}": output.schema.type must be "object", got "${schema.type}". ` +
        `Agents must return structured objects, not primitive values.`,
    );
  }

  // Must have properties
  if (!schema.properties || typeof schema.properties !== "object") {
    throw new Error(
      `Agent "${agentId}": output.schema must have "properties" field defining the output structure.`,
    );
  }

  if (Object.keys(schema.properties).length === 0) {
    throw new Error(
      `Agent "${agentId}": output.schema.properties must have at least one property. ` +
        `Empty schemas are not allowed.`,
    );
  }

  // Validate JSON Schema is well-formed and convertible to Zod
  try {
    validateJsonSchema(schema);
  } catch (err) {
    throw new Error(
      `Agent "${agentId}": Invalid output schema: ${(err as Error).message}\n\n` +
        `Make sure your schema follows JSON Schema specification.`,
    );
  }
}

/**
 * Validate all aspects of agent configuration
 *
 * @param agentConfig - Agent configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateAgentConfig(agentConfig: AgentConfigV1): void {
  // Validate output schema if present
  validateAgentOutputSchema(agentConfig);

  // Add more validation rules here as needed
  // - Tool permissions
  // - LLM tier configuration
  // - Limit values
  // etc.
}
