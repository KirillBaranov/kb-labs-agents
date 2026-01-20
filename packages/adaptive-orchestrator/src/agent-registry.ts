/**
 * Orchestrator Agent Registry
 *
 * Dynamically loads agent metadata from .kb/agents/ directory.
 * Used by AdaptiveOrchestrator to select agent agents for subtasks.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { AgentOrchestratorMetadata, AgentInfo } from '@kb-labs/agent-contracts';

/**
 * Registry for discovering and managing agents available to orchestrator
 */
export class OrchestratorAgentRegistry {
  private agents: Map<string, AgentInfo> = new Map();
  private agentsDir: string;

  constructor(cwd: string, agentsDir: string = '.kb/agents') {
    // Convert to absolute path based on provided cwd
    this.agentsDir = resolve(cwd, agentsDir);
  }

  /**
   * Load all agents from filesystem
   *
   * Scans .kb/agents/ directory and loads agent.yml files.
   * Only agents with valid metadata are included.
   */
  async loadAgents(): Promise<void> {
    this.agents.clear();

    try {
      const dirs = await readdir(this.agentsDir, { withFileTypes: true });

      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;

        const agentId = dir.name;
        const configPath = join(this.agentsDir, agentId, 'agent.yml');

        try {
          const content = await readFile(configPath, 'utf-8');
          const config = loadYaml(content) as any;

          // Skip agents without metadata (not orchestrator-aware)
          if (!config.metadata) {
            continue;
          }

          // Extract agent info
          const agentInfo: AgentInfo = {
            id: config.id || agentId,
            name: config.name || agentId,
            description: config.description || '',
            metadata: {
              description: config.metadata.description,
              tags: config.metadata.tags || [],
              examples: config.metadata.examples || [],
              keywords: config.metadata.keywords || [],
              capabilities: config.metadata.capabilities || [],
            },
            tier: config.llm?.tier || 'medium',
            path: join(this.agentsDir, agentId),
            configPath,
          };

          this.agents.set(agentInfo.id, agentInfo);
        } catch (error) {
          // Skip invalid agents (missing file, parse error, etc.)
          console.warn(`Failed to load agent: ${agentId}`, error);
        }
      }
    } catch (error) {
      // .kb/agents directory doesn't exist or isn't readable
      console.warn(`Failed to load agents from ${this.agentsDir}`, error);
    }
  }

  /**
   * Get all registered agents
   */
  getAll(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent by ID
   */
  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }

  /**
   * Find agents by tags
   *
   * @param tags - Tags to search for
   * @returns Agents that have ANY of the specified tags
   */
  findByTags(tags: string[]): AgentInfo[] {
    return this.getAll().filter((agent) =>
      tags.some((tag) => agent.metadata.tags?.includes(tag)),
    );
  }

  /**
   * Find agents by keyword match in metadata
   *
   * Searches in: description, tags, examples
   *
   * @param query - Search query (case-insensitive)
   * @returns Agents matching the query
   */
  findByKeywords(query: string): AgentInfo[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter((agent) => {
      const searchText = [
        agent.metadata.description,
        ...(agent.metadata.tags || []),
        ...(agent.metadata.examples || []),
      ]
        .join(' ')
        .toLowerCase();

      return searchText.includes(lowerQuery);
    });
  }

  /**
   * Format agents for orchestrator prompt
   *
   * Returns a formatted string that can be injected into the planning prompt.
   * Shows agent name, description, tags, and example tasks.
   */
  toPromptFormat(): string {
    const agents = this.getAll();

    if (agents.length === 0) {
      return 'No agent agents available. Use generic LLM for all subtasks.';
    }

    return agents
      .map((agent) => {
        const parts = [
          `**${agent.name}** (ID: \`${agent.id}\`)`,
          `- ${agent.metadata.description}`,
        ];

        if (agent.metadata.tags && agent.metadata.tags.length > 0) {
          parts.push(`- Tags: ${agent.metadata.tags.join(', ')}`);
        }

        if (agent.metadata.examples && agent.metadata.examples.length > 0) {
          parts.push(`- Examples:`);
          agent.metadata.examples.forEach((example) => {
            parts.push(`  • ${example}`);
          });
        }

        return parts.join('\n');
      })
      .join('\n\n---\n\n');
  }

  /**
   * Get count of loaded agents
   */
  count(): number {
    return this.agents.size;
  }

  /**
   * Check if any agents are loaded
   */
  hasAgents(): boolean {
    return this.agents.size > 0;
  }
}
