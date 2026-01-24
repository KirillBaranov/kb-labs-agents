/**
 * JSON Schema to Zod Schema Converter
 *
 * Converts JSON Schema (used in agent configs) to Zod schemas for runtime validation.
 * Fully dynamic - no hardcoding of agent-specific schemas.
 */

import { z } from "zod";

/**
 * Convert JSON Schema to Zod schema at runtime
 *
 * @param jsonSchema - JSON Schema object
 * @returns Zod schema for runtime validation
 * @throws Error if schema is invalid or unsupported
 */
export function jsonSchemaToZod(jsonSchema: any): z.ZodType {
  if (!jsonSchema || typeof jsonSchema !== "object") {
    throw new Error("JSON Schema must be an object");
  }

  // Handle object type
  if (jsonSchema.type === "object") {
    return convertObject(jsonSchema);
  }

  // Handle array type
  if (jsonSchema.type === "array") {
    return convertArray(jsonSchema);
  }

  // Handle string type
  if (jsonSchema.type === "string") {
    return convertString(jsonSchema);
  }

  // Handle number/integer type
  if (jsonSchema.type === "number" || jsonSchema.type === "integer") {
    return convertNumber(jsonSchema);
  }

  // Handle boolean type
  if (jsonSchema.type === "boolean") {
    return z.boolean();
  }

  // Handle null type
  if (jsonSchema.type === "null") {
    return z.null();
  }

  // Fallback for unknown types
  console.warn(
    `Unsupported JSON Schema type: ${jsonSchema.type}. Using z.unknown()`,
  );
  return z.unknown();
}

/**
 * Convert object schema
 */
function convertObject(schema: any): z.ZodType {
  const properties = schema.properties || {};
  const required = schema.required || [];

  const shape: Record<string, z.ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = jsonSchemaToZod(propSchema);

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    // Add description if present
    if ((propSchema as any).description) {
      zodType = zodType.describe((propSchema as any).description);
    }

    shape[key] = zodType;
  }

  let result: z.ZodType = z.object(shape);

  // Add strict mode if additionalProperties is false
  if (schema.additionalProperties === false) {
    result = (result as z.ZodObject<any>).strict();
  }

  return result;
}

/**
 * Convert array schema
 */
function convertArray(schema: any): z.ZodArray<any> {
  if (!schema.items) {
    // Array without items specification
    return z.array(z.unknown());
  }

  const itemSchema = jsonSchemaToZod(schema.items);
  let result = z.array(itemSchema);

  // Add length constraints
  if (schema.minItems !== undefined) {
    result = result.min(schema.minItems);
  }
  if (schema.maxItems !== undefined) {
    result = result.max(schema.maxItems);
  }

  return result;
}

/**
 * Convert string schema
 */
function convertString(schema: any): z.ZodType {
  // Handle enum first (returns ZodEnum, not ZodString)
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  let result = z.string();

  // Add length constraints
  if (schema.minLength !== undefined) {
    result = result.min(schema.minLength);
  }
  if (schema.maxLength !== undefined) {
    result = result.max(schema.maxLength);
  }

  // Add pattern (regex) validation
  if (schema.pattern) {
    try {
      result = result.regex(new RegExp(schema.pattern));
    } catch (err) {
      console.warn(`Invalid regex pattern "${schema.pattern}": ${err}`);
    }
  }

  // Add format validation (basic support)
  if (schema.format) {
    switch (schema.format) {
      case "email":
        result = result.email();
        break;
      case "url":
        result = result.url();
        break;
      case "uuid":
        result = result.uuid();
        break;
      // Add more formats as needed
    }
  }

  return result;
}

/**
 * Convert number/integer schema
 */
function convertNumber(schema: any): z.ZodNumber {
  let result = schema.type === "integer" ? z.number().int() : z.number();

  // Add range constraints
  if (schema.minimum !== undefined) {
    result = result.min(schema.minimum);
  }
  if (schema.maximum !== undefined) {
    result = result.max(schema.maximum);
  }

  // Exclusive minimum/maximum
  if (schema.exclusiveMinimum !== undefined) {
    result = result.gt(schema.exclusiveMinimum);
  }
  if (schema.exclusiveMaximum !== undefined) {
    result = result.lt(schema.exclusiveMaximum);
  }

  // Multiple of
  if (schema.multipleOf !== undefined) {
    result = result.multipleOf(schema.multipleOf);
  }

  return result;
}

/**
 * Validate that a JSON Schema is convertible to Zod
 *
 * @param schema - JSON Schema to validate
 * @throws Error with clear message if schema is invalid
 */
export function validateJsonSchema(schema: any): void {
  if (!schema || typeof schema !== "object") {
    throw new Error("Schema must be an object");
  }

  if (!schema.type) {
    throw new Error('Schema must have a "type" field');
  }

  if (schema.type === "object") {
    if (!schema.properties || typeof schema.properties !== "object") {
      throw new Error('Object schema must have "properties" field');
    }

    if (Object.keys(schema.properties).length === 0) {
      throw new Error("Object schema must have at least one property");
    }

    // Recursively validate nested schemas
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      try {
        validateJsonSchema(propSchema);
      } catch (err) {
        throw new Error(
          `Invalid schema for property "${key}": ${(err as Error).message}`,
        );
      }
    }
  }

  if (schema.type === "array") {
    if (schema.items) {
      try {
        validateJsonSchema(schema.items);
      } catch (err) {
        throw new Error(
          `Invalid array items schema: ${(err as Error).message}`,
        );
      }
    }
  }

  // Test conversion
  try {
    jsonSchemaToZod(schema);
  } catch (err) {
    throw new Error(`Schema conversion failed: ${(err as Error).message}`);
  }
}
