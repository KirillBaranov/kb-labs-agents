/**
 * Agent Registry (V2 Architecture)
 *
 * Discovers and manages agents from .kb/agents/ directory
 */

import { findRepoRoot, type PluginContextV3 } from "@kb-labs/sdk";
import type { AgentMetadata, AgentConfigV1 } from "@kb-labs/agent-contracts";
import {
  parseAgentConfig,
  validateAgentConfig,
} from "@kb-labs/agent-contracts";
import { parse as parseYAML } from "yaml";
import { join } from "path";

/**
 * Agent Registry
 *
 * Manages agent lifecycle:
 * - Discovery: scan .kb/agents/ for agent directories
 * - Loading: load agent.yml and context files
 * - Validation: validate agent configurations
 */
export class AgentRegistry {
  private agentsDirPromise: Promise<string>;
  private repoRootPromise: Promise<string>;

  constructor(private ctx: PluginContextV3) {
    // Lazy initialization - find repo root async
    this.repoRootPromise = findRepoRoot(ctx.cwd);
    this.agentsDirPromise = this.repoRootPromise.then((root) =>
      join(root, ".kb", "agents"),
    );
  }

  /**
   * Get agents directory path
   */
  private async getSpecialistsDir(): Promise<string> {
    return this.agentsDirPromise;
  }

  /**
   * Initialize .kb/agents/ directory
   */
  async init(): Promise<void> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getSpecialistsDir();

    try {
      await fs.mkdir(agentsDir, { recursive: true });
      this.ctx.platform.logger.info("Initialized .kb/agents/ directory", {
        path: agentsDir,
      });
    } catch (error) {
      throw new Error(
        `Failed to initialize .kb/agents/: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Discover all agents in .kb/agents/
   *
   * Scans for directories containing agent.yml files
   */
  async discover(): Promise<AgentMetadata[]> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getSpecialistsDir();

    try {
      // Check if .kb/agents/ exists
      const exists = await this.directoryExists(agentsDir);
      if (!exists) {
        return [];
      }

      // Read all entries in .kb/agents/
      const entries = await fs.readdir(agentsDir);

      // Filter for directories only (check with stat)
      const agentIds: string[] = [];
      for (const entry of entries) {
        const entryPath = join(agentsDir, entry);
        try {
          const stat = await fs.stat(entryPath);
          if (stat.isDirectory()) {
            agentIds.push(entry);
          }
        } catch {
          // Skip if can't stat
          continue;
        }
      }

      // Load metadata for each agent
      const metadata: AgentMetadata[] = [];
      for (const agentId of agentIds) {
        const agentPath = join(agentsDir, agentId);
        const configPath = join(agentPath, "agent.yml");

        // Check if agent.yml exists
        const configExists = await this.fileExists(configPath);
        if (!configExists) {
          metadata.push({
            id: agentId,
            name: agentId,
            description: "",
            capabilities: [],
            tier: "small",
            path: agentPath,
            configPath,
            valid: false,
            error: "agent.yml not found",
          });
          continue;
        }

        // Try to parse config
        try {
          const configContent = await fs.readFile(configPath, "utf-8");
          const configData = parseYAML(configContent);
          const validation = validateAgentConfig(configData);

          console.log(`\n🔍 Validating agent: ${agentId}`);
          console.log(`   Success: ${validation.success}`);
          if (!validation.success && validation.error) {
            console.log(`   Errors:`);
            validation.error.errors.forEach((err) => {
              console.log(`     - ${err.path.join(".")}: ${err.message}`);
            });
          }

          if (validation.success && validation.data) {
            metadata.push({
              id: validation.data.id,
              name: validation.data.name,
              description: validation.data.description,
              capabilities: validation.data.capabilities || [],
              tier: validation.data.llm.tier,
              path: agentPath,
              configPath,
              valid: true,
            });
          } else {
            // Format validation errors in a user-friendly way
            const errorMessages: string[] = [];
            if (validation.error) {
              for (const err of validation.error.errors) {
                const path = err.path.join(".");
                const message = err.message;
                errorMessages.push(`  • ${path}: ${message}`);
              }
            }
            const formattedError =
              errorMessages.length > 0
                ? `Validation errors:\n${errorMessages.join("\n")}`
                : "Invalid config";

            this.ctx.platform.logger.warn(
              `Agent config validation failed: ${agentId}`,
              {
                errors: errorMessages,
                configPath,
              },
            );

            metadata.push({
              id: agentId,
              name: agentId,
              description: "",
              capabilities: [],
              tier: "small",
              path: agentPath,
              configPath,
              valid: false,
              error: formattedError,
            });
          }
        } catch (error) {
          metadata.push({
            id: agentId,
            name: agentId,
            description: "",
            capabilities: [],
            tier: "small",
            path: agentPath,
            configPath,
            valid: false,
            error: `Failed to parse config: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      return metadata;
    } catch (error) {
      throw new Error(
        `Failed to discover agents: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Load a specific agent by ID
   *
   * @param agentId - Agent ID (directory name)
   * @returns Agent configuration
   * @throws Error if agent not found or invalid
   */
  async load(agentId: string): Promise<AgentConfigV1> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getSpecialistsDir();
    const agentPath = join(agentsDir, agentId);
    const configPath = join(agentPath, "agent.yml");

    // Check if agent directory exists
    const dirExists = await this.directoryExists(agentPath);
    if (!dirExists) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Check if agent.yml exists
    const configExists = await this.fileExists(configPath);
    if (!configExists) {
      throw new Error(`Agent config not found: ${configPath}`);
    }

    // Load and parse config
    const configContent = await fs.readFile(configPath, "utf-8");
    const configData = parseYAML(configContent);
    const config = parseAgentConfig(configData);

    // Load context files if specified
    if (config.context?.static?.contextFile) {
      const contextFilePath = join(
        agentPath,
        config.context.static.contextFile,
      );
      const contextExists = await this.fileExists(contextFilePath);
      if (contextExists) {
        const contextContent = await fs.readFile(contextFilePath, "utf-8");
        // Inject context content into config
        config.context.static.system =
          (config.context.static.system || "") + "\n\n" + contextContent;
      } else {
        this.ctx.platform.logger.warn("Context file not found", {
          agentId,
          contextFile: config.context.static.contextFile,
        });
      }
    }

    return config;
  }

  /**
   * List all valid agents
   */
  async list(): Promise<AgentMetadata[]> {
    const all = await this.discover();
    return all.filter((s) => s.valid);
  }

  /**
   * Get agent by ID (metadata only)
   */
  async get(agentId: string): Promise<AgentMetadata | null> {
    const all = await this.discover();
    return all.find((s) => s.id === agentId) || null;
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
