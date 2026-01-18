/**
 * Specialist Registry (V2 Architecture)
 *
 * Discovers and manages specialists from .kb/specialists/ directory
 */

import { findRepoRoot, type PluginContextV3 } from '@kb-labs/sdk';
import type { SpecialistConfigV1, SpecialistMetadata } from '@kb-labs/agent-contracts';
import { parseSpecialistConfig, validateSpecialistConfig } from '@kb-labs/agent-contracts';
import { parse as parseYAML } from 'yaml';
import { join } from 'path';

/**
 * Specialist Registry
 *
 * Manages specialist lifecycle:
 * - Discovery: scan .kb/specialists/ for specialist directories
 * - Loading: load specialist.yml and context files
 * - Validation: validate specialist configurations
 */
export class SpecialistRegistry {
  private specialistsDirPromise: Promise<string>;
  private repoRootPromise: Promise<string>;

  constructor(private ctx: PluginContextV3) {
    // Lazy initialization - find repo root async
    this.repoRootPromise = findRepoRoot(ctx.cwd);
    this.specialistsDirPromise = this.repoRootPromise.then(root =>
      join(root, '.kb', 'specialists')
    );
  }

  /**
   * Get specialists directory path
   */
  private async getSpecialistsDir(): Promise<string> {
    return this.specialistsDirPromise;
  }

  /**
   * Initialize .kb/specialists/ directory
   */
  async init(): Promise<void> {
    const fs = this.ctx.runtime.fs;
    const specialistsDir = await this.getSpecialistsDir();

    try {
      await fs.mkdir(specialistsDir, { recursive: true});
      this.ctx.platform.logger.info('Initialized .kb/specialists/ directory', {
        path: specialistsDir,
      });
    } catch (error) {
      throw new Error(
        `Failed to initialize .kb/specialists/: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Discover all specialists in .kb/specialists/
   *
   * Scans for directories containing specialist.yml files
   */
  async discover(): Promise<SpecialistMetadata[]> {
    const fs = this.ctx.runtime.fs;
    const specialistsDir = await this.getSpecialistsDir();

    try {
      // Check if .kb/specialists/ exists
      const exists = await this.directoryExists(specialistsDir);
      if (!exists) {
        return [];
      }

      // Read all entries in .kb/specialists/
      const entries = await fs.readdir(specialistsDir);

      // Filter for directories only (check with stat)
      const specialistIds: string[] = [];
      for (const entry of entries) {
        const entryPath = join(specialistsDir, entry);
        try {
          const stat = await fs.stat(entryPath);
          if (stat.isDirectory()) {
            specialistIds.push(entry);
          }
        } catch {
          // Skip if can't stat
          continue;
        }
      }

      // Load metadata for each specialist
      const metadata: SpecialistMetadata[] = [];
      for (const specialistId of specialistIds) {
        const specialistPath = join(specialistsDir, specialistId);
        const configPath = join(specialistPath, 'specialist.yml');

        // Check if specialist.yml exists
        const configExists = await this.fileExists(configPath);
        if (!configExists) {
          metadata.push({
            id: specialistId,
            name: specialistId,
            description: '',
            capabilities: [],
            tier: 'small',
            path: specialistPath,
            configPath,
            valid: false,
            error: 'specialist.yml not found',
          });
          continue;
        }

        // Try to parse config
        try {
          const configContent = await fs.readFile(configPath, 'utf-8');
          const configData = parseYAML(configContent);
          const validation = validateSpecialistConfig(configData);

          if (validation.success && validation.data) {
            metadata.push({
              id: validation.data.id,
              name: validation.data.name,
              description: validation.data.description,
              capabilities: validation.data.capabilities || [],
              tier: validation.data.llm.tier,
              path: specialistPath,
              configPath,
              valid: true,
            });
          } else {
            // Format validation errors in a user-friendly way
            const errorMessages: string[] = [];
            if (validation.error) {
              for (const err of validation.error.errors) {
                const path = err.path.join('.');
                const message = err.message;
                errorMessages.push(`  • ${path}: ${message}`);
              }
            }
            const formattedError =
              errorMessages.length > 0
                ? `Validation errors:\n${errorMessages.join('\n')}`
                : 'Invalid config';

            this.ctx.platform.logger.warn(`Specialist config validation failed: ${specialistId}`, {
              errors: errorMessages,
              configPath,
            });

            metadata.push({
              id: specialistId,
              name: specialistId,
              description: '',
              capabilities: [],
              tier: 'small',
              path: specialistPath,
              configPath,
              valid: false,
              error: formattedError,
            });
          }
        } catch (error) {
          metadata.push({
            id: specialistId,
            name: specialistId,
            description: '',
            capabilities: [],
            tier: 'small',
            path: specialistPath,
            configPath,
            valid: false,
            error: `Failed to parse config: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      return metadata;
    } catch (error) {
      throw new Error(
        `Failed to discover specialists: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load a specific specialist by ID
   *
   * @param specialistId - Specialist ID (directory name)
   * @returns Specialist configuration
   * @throws Error if specialist not found or invalid
   */
  async load(specialistId: string): Promise<SpecialistConfigV1> {
    const fs = this.ctx.runtime.fs;
    const specialistsDir = await this.getSpecialistsDir();
    const specialistPath = join(specialistsDir, specialistId);
    const configPath = join(specialistPath, 'specialist.yml');

    // Check if specialist directory exists
    const dirExists = await this.directoryExists(specialistPath);
    if (!dirExists) {
      throw new Error(`Specialist not found: ${specialistId}`);
    }

    // Check if specialist.yml exists
    const configExists = await this.fileExists(configPath);
    if (!configExists) {
      throw new Error(`Specialist config not found: ${configPath}`);
    }

    // Load and parse config
    const configContent = await fs.readFile(configPath, 'utf-8');
    const configData = parseYAML(configContent);
    const config = parseSpecialistConfig(configData);

    // Load context files if specified
    if (config.context?.static?.contextFile) {
      const contextFilePath = join(specialistPath, config.context.static.contextFile);
      const contextExists = await this.fileExists(contextFilePath);
      if (contextExists) {
        const contextContent = await fs.readFile(contextFilePath, 'utf-8');
        // Inject context content into config
        config.context.static.system =
          (config.context.static.system || '') + '\n\n' + contextContent;
      } else {
        this.ctx.platform.logger.warn('Context file not found', {
          specialistId,
          contextFile: config.context.static.contextFile,
        });
      }
    }

    return config;
  }

  /**
   * List all valid specialists
   */
  async list(): Promise<SpecialistMetadata[]> {
    const all = await this.discover();
    return all.filter(s => s.valid);
  }

  /**
   * Get specialist by ID (metadata only)
   */
  async get(specialistId: string): Promise<SpecialistMetadata | null> {
    const all = await this.discover();
    return all.find(s => s.id === specialistId) || null;
  }

  // Helper methods

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await this.ctx.runtime.fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await this.ctx.runtime.fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
