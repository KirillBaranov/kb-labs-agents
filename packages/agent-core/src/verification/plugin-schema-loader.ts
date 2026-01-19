/**
 * Plugin Schema Loader - Dynamic Schema Resolution
 *
 * Level 2 validation: Loads Zod schemas from plugin manifests
 * for validating plugin tool outputs.
 *
 * Part of the anti-hallucination verification system (ADR-0002).
 */

import type { z } from 'zod';
import { useLogger } from '@kb-labs/sdk';

/**
 * Schema reference format
 *
 * Examples:
 * - '@kb-labs/commit-contracts/schema#ResetOutput'
 * - './schemas/query.ts#QueryResultSchema'
 */
export interface SchemaRef {
  /** Package name (e.g., '@kb-labs/commit-contracts') */
  packageName: string;

  /** Module path (e.g., '/schema', './schemas/query.ts') */
  modulePath: string;

  /** Export name (e.g., 'ResetOutput', 'QueryResultSchema') */
  exportName: string;
}

/**
 * Plugin schema loader
 *
 * Dynamically loads Zod schemas from plugin contracts for validation.
 */
export class PluginSchemaLoader {
  /** Schema cache (key: full ref, value: Zod schema) */
  private schemaCache = new Map<string, z.ZodSchema>();

  /**
   * Load schema from plugin contract reference
   *
   * @param ref - Schema reference (e.g., '@kb-labs/commit-contracts/schema#ResetOutput')
   * @returns Zod schema or null if not found
   */
  async loadSchema(ref: string): Promise<z.ZodSchema | null> {
    const logger = useLogger();

    // Check cache first
    if (this.schemaCache.has(ref)) {
      return this.schemaCache.get(ref)!;
    }

    // Parse reference
    const parsed = this.parseRef(ref);
    if (!parsed) {
      await logger.warn('Invalid schema ref', { ref });
      return null;
    }

    try {
      // Dynamic import from package
      const moduleName = `${parsed.packageName}${parsed.modulePath}`;
      const module = await import(moduleName);

      // Look for schema export
      // Convention: ExportName + 'Schema' (e.g., ResetOutput → ResetOutputSchema)
      const schemaName = `${parsed.exportName}Schema`;
      const schema = module[schemaName];

      if (!schema) {
        await logger.warn('Schema not found', { schemaName, moduleName });
        return null;
      }

      // Cache schema
      this.schemaCache.set(ref, schema);
      return schema;
    } catch (error) {
      await logger.warn('Failed to load schema', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Parse schema reference
   *
   * Format: '@package/name/path#ExportName'
   *
   * @param ref - Schema reference string
   * @returns Parsed reference or null if invalid
   */
  private parseRef(ref: string): SchemaRef | null {
    // Split by '#'
    const parts = ref.split('#');
    if (parts.length !== 2) {
      return null;
    }

    const [modulePart, exportName] = parts;

    // TypeScript guard: ensure both parts exist
    if (!modulePart || !exportName) {
      return null;
    }

    // Split module part into package + path
    // Examples:
    // - '@kb-labs/commit-contracts/schema' → package='@kb-labs/commit-contracts', path='/schema'
    // - './schemas/query' → package='.', path='/schemas/query'

    let packageName: string;
    let modulePath: string;

    if (modulePart.startsWith('@')) {
      // Scoped package: '@org/package/path'
      const slashIndex = modulePart.indexOf('/', modulePart.indexOf('/') + 1);
      if (slashIndex === -1) {
        // No path: '@org/package'
        packageName = modulePart;
        modulePath = '';
      } else {
        packageName = modulePart.substring(0, slashIndex);
        modulePath = modulePart.substring(slashIndex);
      }
    } else if (modulePart.startsWith('.')) {
      // Relative path: './schemas/query'
      packageName = '.';
      modulePath = modulePart.substring(1);
    } else {
      // Unscoped package: 'package/path'
      const slashIndex = modulePart.indexOf('/');
      if (slashIndex === -1) {
        packageName = modulePart;
        modulePath = '';
      } else {
        packageName = modulePart.substring(0, slashIndex);
        modulePath = modulePart.substring(slashIndex);
      }
    }

    return {
      packageName,
      modulePath,
      exportName,
    };
  }

  /**
   * Clear schema cache
   *
   * Useful for testing or after plugin updates.
   */
  clearCache(): void {
    this.schemaCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; refs: string[] } {
    return {
      size: this.schemaCache.size,
      refs: Array.from(this.schemaCache.keys()),
    };
  }
}

/**
 * Global schema loader instance
 *
 * Shared across all verification tasks for cache efficiency.
 */
let globalLoader: PluginSchemaLoader | null = null;

/**
 * Get or create global schema loader
 */
export function getSchemaLoader(): PluginSchemaLoader {
  if (!globalLoader) {
    globalLoader = new PluginSchemaLoader();
  }
  return globalLoader;
}
