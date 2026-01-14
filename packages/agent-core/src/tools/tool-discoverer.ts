/**
 * Tool Discoverer
 *
 * Discovers available tools from KB Labs plugin manifests using auto-discovery
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type { ToolDefinition } from '@kb-labs/agent-contracts';
import { glob } from 'glob';
import { join, dirname } from 'path';
import { readFileSync, existsSync } from 'fs';

/**
 * Discovered plugin manifest (KB Labs v3 schema)
 */
interface DiscoveredManifest {
  id: string;
  name?: string;
  cli?: {
    commands?: Array<{
      id: string;
      description?: string;
      flags?: Record<string, any>;
    }>;
  };
}

/**
 * Tool Discoverer
 *
 * Scans plugin manifests and creates ToolDefinitions for agent use:
 * - Built-in tools (fs:*, shell:*)
 * - KB Labs plugin commands (devkit:*, mind:*, workflow:*)
 *
 * Uses auto-discovery to find plugin manifests similar to CLI API approach
 */
export class ToolDiscoverer {
  private static readonly CACHE_KEY = 'agent:discovered-manifests';
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private ctx: PluginContextV3) {}

  /**
   * Discover all available tools based on agent configuration
   *
   * @param config - Agent tools configuration
   * @returns Array of ToolDefinitions
   */
  async discover(config: {
    filesystem?: { enabled: boolean };
    shell?: { enabled: boolean };
    kbLabs?: { mode: 'allowlist' | 'denylist'; allow?: string[]; deny?: string[] };
  }): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    // Add filesystem tools if enabled
    if (config.filesystem?.enabled) {
      tools.push(...this.getFilesystemTools());
    }

    // Add shell tools if enabled
    if (config.shell?.enabled) {
      tools.push(...this.getShellTools());
    }

    // Add KB Labs plugin tools if configured
    if (config.kbLabs) {
      const kbLabsTools = await this.discoverKBLabsTools(config.kbLabs);
      tools.push(...kbLabsTools);
    }

    this.ctx.platform.logger.debug('Discovered tools', {
      count: tools.length,
      tools: tools.map((t) => t.name),
    });

    return tools;
  }

  /**
   * Get built-in filesystem tools
   */
  private getFilesystemTools(): ToolDefinition[] {
    return [
      {
        name: 'fs:read',
        description: 'Read contents of a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to file to read',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'fs:write',
        description: 'Write content to a file (creates or overwrites)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to file to write',
            },
            content: {
              type: 'string',
              description: 'Content to write to file',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'fs:edit',
        description: 'Edit a file using search/replace',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to file to edit',
            },
            search: {
              type: 'string',
              description: 'Text to search for',
            },
            replace: {
              type: 'string',
              description: 'Text to replace with',
            },
          },
          required: ['path', 'search', 'replace'],
        },
      },
      {
        name: 'fs:list',
        description: 'List files and directories in a path',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to list (defaults to current directory)',
            },
            recursive: {
              type: 'boolean',
              description: 'List recursively',
            },
          },
        },
      },
      {
        name: 'fs:search',
        description: 'Search for text in files using glob patterns',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern for files to search (e.g., "**/*.ts")',
            },
            text: {
              type: 'string',
              description: 'Text to search for',
            },
            caseInsensitive: {
              type: 'boolean',
              description: 'Case insensitive search',
            },
          },
          required: ['pattern', 'text'],
        },
      },
    ];
  }

  /**
   * Get built-in shell tools
   */
  private getShellTools(): ToolDefinition[] {
    return [
      {
        name: 'shell:exec',
        description: 'Execute a shell command',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Command to execute',
            },
          },
          required: ['command'],
        },
      },
    ];
  }

  /**
   * Discover KB Labs plugin tools from manifests using auto-discovery
   */
  private async discoverKBLabsTools(config: {
    mode: 'allowlist' | 'denylist';
    allow?: string[];
    deny?: string[];
  }): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    try {
      // Auto-discover plugin manifests in the workspace
      const manifests = await this.discoverManifests();

      for (const manifest of manifests) {
        // Check if manifest has commands (KB Labs v3: cli.commands)
        if (!manifest.cli?.commands || manifest.cli.commands.length === 0) {
          continue;
        }

        // Process each command
        // Note: command.id already contains full format like "mind:rag-query"
        for (const command of manifest.cli.commands) {
          const toolName = command.id;

          // Check against allowlist/denylist
          if (!this.shouldIncludeTool(toolName, config)) {
            continue;
          }

          // Create ToolDefinition from command
          tools.push({
            name: toolName,
            description: command.description || `Execute ${toolName}`,
            inputSchema: this.commandToInputSchema(command),
          });
        }
      }

      this.ctx.platform.logger.info('Discovered KB Labs tools', {
        count: tools.length,
        manifests: manifests.length,
      });
    } catch (error) {
      this.ctx.platform.logger.warn('Failed to discover KB Labs tools', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return tools;
  }

  /**
   * Discover plugin manifests in the workspace
   *
   * Similar to discoverCLIPackages in shared-cli-ui
   * Results are cached for 5 minutes
   */
  private async discoverManifests(): Promise<DiscoveredManifest[]> {
    // Check cache first
    const cached = await this.ctx.platform.cache.get<DiscoveredManifest[]>(ToolDiscoverer.CACHE_KEY);
    if (cached) {
      return cached;
    }

    // Cache miss - perform discovery (same approach as CLI PkgStrategy)
    const manifests: DiscoveredManifest[] = [];
    const rootDir = this.ctx.cwd;

    // Find all packages in node_modules (prefer .pnpm for pnpm workspaces)
    const patterns = [
      'node_modules/.pnpm/node_modules/@*/*/package.json',
      'node_modules/@*/*/package.json',
    ];

    try {
      for (const pattern of patterns) {
        const pkgFiles = await glob(pattern, {
          cwd: rootDir,
          absolute: false,
        });

        for (const pkgFile of pkgFiles) {
          try {
            const pkgPath = join(rootDir, pkgFile);
            // Use Node.js fs to read package.json (not runtime.fs which is sandboxed)
            const pkgContent = readFileSync(pkgPath, 'utf-8');
            const pkg = JSON.parse(pkgContent);

            // Check for manifest path in kbLabs.manifest or kb.manifest
            const manifestPathRel = pkg.kbLabs?.manifest || pkg.kb?.manifest;
            if (!manifestPathRel) {
              continue;
            }

            const pkgDir = dirname(pkgPath);
            const manifestPath = join(pkgDir, manifestPathRel);

            // Check if manifest exists
            if (!existsSync(manifestPath)) {
              continue;
            }

            // Dynamic import of manifest module
            const manifestUrl = `file://${manifestPath}`;
            const manifestModule = await import(manifestUrl);
            const manifest = (manifestModule.default || manifestModule.manifest || manifestModule) as DiscoveredManifest;

            // Validate manifest has required fields (KB Labs v3: cli.commands)
            if (manifest.id && manifest.cli?.commands) {
              manifests.push(manifest);
            }
          } catch (error) {
            // Skip invalid packages/manifests
            this.ctx.platform.logger.debug('Failed to load manifest', {
              file: pkgFile,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Cache the results
      await this.ctx.platform.cache.set(
        ToolDiscoverer.CACHE_KEY,
        manifests,
        ToolDiscoverer.CACHE_TTL
      );

      this.ctx.platform.logger.debug('Discovered and cached manifests', {
        count: manifests.length,
      });
    } catch (error) {
      this.ctx.platform.logger.warn('Failed to discover manifests', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return manifests;
  }

  /**
   * Extract plugin name from manifest ID
   *
   * Examples:
   * - "@kb-labs/mind-cli" -> "mind"
   * - "@kb-labs/devkit-cli" -> "devkit"
   * - "my-plugin" -> "my-plugin"
   */
  private extractPluginName(manifestId: string): string {
    // Remove scope if present
    const withoutScope = manifestId.replace(/^@[^/]+\//, '');

    // Remove -cli suffix if present
    const withoutCli = withoutScope.replace(/-cli$/, '');

    // Remove kb-labs- prefix if present
    const withoutPrefix = withoutCli.replace(/^kb-labs-/, '');

    return withoutPrefix;
  }

  /**
   * Check if tool should be included based on allowlist/denylist
   */
  private shouldIncludeTool(
    toolName: string,
    config: { mode: 'allowlist' | 'denylist'; allow?: string[]; deny?: string[] }
  ): boolean {
    if (config.mode === 'allowlist') {
      // Only include if matches allow patterns
      const allowPatterns = config.allow || [];
      return allowPatterns.some((pattern) => this.matchesPattern(toolName, pattern));
    } else {
      // Include unless matches deny patterns
      const denyPatterns = config.deny || [];
      return !denyPatterns.some((pattern) => this.matchesPattern(toolName, pattern));
    }
  }

  /**
   * Match tool name against pattern (supports wildcards)
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Example: "devkit:*" -> /^devkit:.*$/
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\*/g, '.*'); // Replace * with .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
  }

  /**
   * Convert plugin command to ToolDefinition input schema
   */
  private commandToInputSchema(command: any): ToolDefinition['inputSchema'] {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    // Hardcoded schemas for known commands (TODO: parse from Zod schemas in handlers)
    const knownSchemas: Record<string, ToolDefinition['inputSchema']> = {
      'mind:rag-query': {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Semantic question or query to search for in the codebase',
          },
          mode: {
            type: 'string',
            description: 'Query mode: instant (fast), auto (balanced), or thinking (deep analysis)',
            enum: ['instant', 'auto', 'thinking'],
          },
          scope: {
            type: 'string',
            description: 'Scope ID to search within (default: "default")',
          },
        },
        required: ['text'],
      },
      'mind:rag-status': {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: 'Scope ID to check status for',
          },
        },
      },
    };

    // Return hardcoded schema if available
    const knownSchema = knownSchemas[command.id];
    if (knownSchema) {
      return knownSchema;
    }

    // Extract flags from command (legacy support)
    if (command.flags) {
      for (const [flagName, flagConfig] of Object.entries(command.flags as Record<string, any>)) {
        properties[flagName] = {
          type: this.flagTypeToJsonType(flagConfig.type),
          description: flagConfig.description || '',
        };

        if (flagConfig.required) {
          required.push(flagName);
        }
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  /**
   * Convert flag type to JSON schema type
   */
  private flagTypeToJsonType(flagType: string): string {
    switch (flagType) {
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return 'array';
      default:
        return 'string';
    }
  }
}
