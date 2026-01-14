/**
 * Tool Name Sanitizer
 *
 * OpenAI function calling requires tool names to match ^[a-zA-Z0-9_-]+$
 * Our tools use colons (fs:read, mind:rag-query), so we need to sanitize them.
 */

/**
 * Sanitize tool name for OpenAI (replace : with _)
 *
 * @param name - Original tool name (e.g., "fs:read", "mind:rag-query")
 * @returns Sanitized name (e.g., "fs_read", "mind_rag_query")
 *
 * @example
 * sanitizeToolName("fs:read") // "fs_read"
 * sanitizeToolName("mind:rag-query") // "mind_rag_query"
 * sanitizeToolName("shell:exec") // "shell_exec"
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[:-]/g, '_');
}

/**
 * Create a bidirectional mapping between original and sanitized tool names
 *
 * @param originalNames - Array of original tool names
 * @returns Map with sanitized -> original mapping
 *
 * @example
 * const names = ["fs:read", "mind:rag-query"];
 * const map = createToolNameMapping(names);
 * map.get("fs_read") // "fs:read"
 * map.get("mind_rag_query") // "mind:rag-query"
 */
export function createToolNameMapping(originalNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of originalNames) {
    const sanitized = sanitizeToolName(name);
    map.set(sanitized, name);
  }
  return map;
}

/**
 * Restore original tool name from sanitized version using mapping
 *
 * @param sanitizedName - Sanitized tool name (e.g., "fs_read")
 * @param mapping - Mapping from createToolNameMapping
 * @returns Original tool name (e.g., "fs:read") or sanitized name if not found
 *
 * @example
 * const map = createToolNameMapping(["fs:read", "mind:rag-query"]);
 * restoreToolName("fs_read", map) // "fs:read"
 * restoreToolName("mind_rag_query", map) // "mind:rag-query"
 * restoreToolName("unknown", map) // "unknown" (fallback)
 */
export function restoreToolName(sanitizedName: string, mapping: Map<string, string>): string {
  return mapping.get(sanitizedName) || sanitizedName;
}
