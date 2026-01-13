/**
 * Agent Registry
 *
 * Discovers and manages agents from .kb/agents/ directory
 */

import { findRepoRoot, type PluginContextV3 } from '@kb-labs/sdk';
import type {
  AgentConfigV1,
  AgentMetadata,
  AgentContext,
  AgentTemplate,
} from '@kb-labs/agent-contracts';
import { parseAgentConfig, validateAgentConfig } from '@kb-labs/agent-contracts';
import { parse as parseYAML } from 'yaml';
import { join } from 'path';

/**
 * Agent Registry
 *
 * Manages agent lifecycle:
 * - Discovery: scan .kb/agents/ for agent directories
 * - Loading: load agent.yml and context files
 * - Creation: create new agents from templates
 * - Validation: validate agent configurations
 */
export class AgentRegistry {
  private agentsDirPromise: Promise<string>;
  private repoRootPromise: Promise<string>;

  constructor(private ctx: PluginContextV3) {
    // Lazy initialization - find repo root async
    this.repoRootPromise = findRepoRoot(ctx.cwd);
    this.agentsDirPromise = this.repoRootPromise.then(root => join(root, '.kb', 'agents'));
  }

  /**
   * Get agents directory path
   */
  private async getAgentsDir(): Promise<string> {
    return this.agentsDirPromise;
  }

  /**
   * Initialize .kb/agents/ directory
   */
  async init(): Promise<void> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getAgentsDir();

    try {
      await fs.mkdir(agentsDir, { recursive: true });
      this.ctx.platform.logger.info('Initialized .kb/agents/ directory', {
        path: agentsDir,
      });
    } catch (error) {
      throw new Error(
        `Failed to initialize .kb/agents/: ${error instanceof Error ? error.message : String(error)}`
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
    const agentsDir = await this.getAgentsDir();

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
        const configPath = join(agentPath, 'agent.yml');

        // Check if agent.yml exists
        const configExists = await this.fileExists(configPath);
        if (!configExists) {
          metadata.push({
            id: agentId,
            name: agentId,
            path: agentPath,
            configPath,
            valid: false,
            error: 'agent.yml not found',
          });
          continue;
        }

        // Try to parse config
        try {
          const configContent = await fs.readFile(configPath, 'utf-8');
          const configData = parseYAML(configContent);
          const validation = validateAgentConfig(configData);

          if (validation.success && validation.data) {
            metadata.push({
              id: validation.data.id,
              name: validation.data.name,
              description: validation.data.description,
              path: agentPath,
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
            const formattedError = errorMessages.length > 0
              ? `Validation errors:\n${errorMessages.join('\n')}`
              : 'Invalid config';

            this.ctx.platform.logger.warn(`Agent config validation failed: ${agentId}`, {
              errors: errorMessages,
              configPath,
            });

            metadata.push({
              id: agentId,
              name: agentId,
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
            path: agentPath,
            configPath,
            valid: false,
            error: `Failed to parse: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      return metadata;
    } catch (error) {
      throw new Error(
        `Failed to discover agents: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load agent configuration by ID
   */
  async loadConfig(agentId: string): Promise<AgentConfigV1> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getAgentsDir();
    const configPath = join(agentsDir, agentId, 'agent.yml');

    try {
      const configContent = await fs.readFile(configPath, 'utf-8');
      const configData = parseYAML(configContent);
      return parseAgentConfig(configData);
    } catch (error) {
      throw new Error(
        `Failed to load agent config '${agentId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load full agent context (config + prompt files)
   */
  async loadContext(agentId: string, config: AgentConfigV1): Promise<AgentContext> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getAgentsDir();
    const agentPath = join(agentsDir, agentId);

    const context: AgentContext = { config };

    // Load system prompt if specified
    if (config.prompt?.systemPrompt) {
      const promptPath = join(agentPath, config.prompt.systemPrompt);
      try {
        context.systemPrompt = await fs.readFile(promptPath, 'utf-8');
      } catch (error) {
        // Failed to load system prompt - continue without it
      }
    }

    // Load examples if specified
    if (config.prompt?.examples) {
      const examplesPath = join(agentPath, config.prompt.examples);
      try {
        context.examples = await fs.readFile(examplesPath, 'utf-8');
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to load examples', {
          agentId,
          path: examplesPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Load context files if specified
    if (config.context?.files && config.context.files.length > 0) {
      context.contextFiles = [];
      for (const file of config.context.files) {
        const filePath = join(agentPath, file.path);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          context.contextFiles.push({
            path: file.path,
            content,
          });
        } catch (error) {
          this.ctx.platform.logger.warn('Failed to load context file', {
            agentId,
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return context;
  }

  /**
   * Create a new agent from template
   */
  async create(agentId: string, template: AgentTemplate = 'basic'): Promise<string> {
    const fs = this.ctx.runtime.fs;
    const agentsDir = await this.getAgentsDir();
    const agentPath = join(agentsDir, agentId);

    // Check if agent already exists
    const exists = await this.directoryExists(agentPath);
    if (exists) {
      throw new Error(`Agent '${agentId}' already exists`);
    }

    // Create agent directory
    await fs.mkdir(agentPath, { recursive: true });

    // Get template config
    const templateConfig = this.getTemplateConfig(agentId, template);

    // Write agent.yml
    const configPath = join(agentPath, 'agent.yml');
    await fs.writeFile(configPath, templateConfig, { encoding: 'utf-8' });

    // Write default system-prompt.md
    const systemPromptPath = join(agentPath, 'system-prompt.md');
    const systemPrompt = this.getTemplateSystemPrompt(template);
    await fs.writeFile(systemPromptPath, systemPrompt, { encoding: 'utf-8' });

    this.ctx.platform.logger.info('Created agent from template', {
      agentId,
      template,
      path: agentPath,
    });

    return agentPath;
  }

  /**
   * Check if agent exists
   */
  async exists(agentId: string): Promise<boolean> {
    const agentsDir = await this.getAgentsDir();
    const agentPath = join(agentsDir, agentId);
    return this.directoryExists(agentPath);
  }

  /**
   * Get template configuration YAML
   */
  private getTemplateConfig(agentId: string, template: AgentTemplate): string {
    const templates = {
      basic: `schema: kb.agent/1
id: ${agentId}
name: "${agentId.charAt(0).toUpperCase() + agentId.slice(1)} Agent"
description: "Basic agent for general tasks"

llm:
  temperature: 0.7
  maxTokens: 4000
  maxToolCalls: 20

prompt:
  systemPrompt: "./system-prompt.md"

tools:
  filesystem:
    enabled: true
    permissions:
      read: ["./"]
      write: ["./output/**"]
  shell:
    enabled: false
`,
      coding: `schema: kb.agent/1
id: ${agentId}
name: "${agentId.charAt(0).toUpperCase() + agentId.slice(1)} Coding Agent"
description: "Coding assistant with KB Labs tools and filesystem access"

llm:
  temperature: 0.2
  maxTokens: 4000
  maxToolCalls: 30

prompt:
  systemPrompt: "./system-prompt.md"

tools:
  kbLabs:
    mode: allowlist
    allow: ["devkit:*", "mind:*"]
  filesystem:
    enabled: true
    permissions:
      read: ["./"]
      write: ["src/**", "tests/**", "!src/config/**"]
  shell:
    enabled: true
    allowedCommands:
      - "pnpm build"
      - "pnpm test"
      - "git status"

policies:
  allowWrite: true
`,
      testing: `schema: kb.agent/1
id: ${agentId}
name: "${agentId.charAt(0).toUpperCase() + agentId.slice(1)} Testing Agent"
description: "Test generation and execution agent"

llm:
  temperature: 0.3
  maxTokens: 4000
  maxToolCalls: 25

prompt:
  systemPrompt: "./system-prompt.md"

tools:
  filesystem:
    enabled: true
    permissions:
      read: ["./"]
      write: ["tests/**", "__tests__/**"]
  shell:
    enabled: true
    allowedCommands:
      - "pnpm test"
      - "pnpm test:watch"
      - "vitest run"

policies:
  allowWrite: true
  restrictedPaths: ["src/**"]
`,
    };

    return templates[template];
  }

  /**
   * Get template system prompt
   */
  private getTemplateSystemPrompt(template: AgentTemplate): string {
    const prompts = {
      basic: `# Basic Agent System Prompt

You are a helpful AI agent. Your goal is to complete tasks accurately and efficiently.

## Available Tools

You have access to filesystem tools:
- \`fs:read\` - Read file contents
- \`fs:write\` - Write content to files
- \`fs:edit\` - Edit files using search/replace
- \`fs:list\` - List files in directories
- \`fs:search\` - Search for text in files

## Guidelines

1. Always understand the task before acting
2. Use tools appropriately
3. Provide clear explanations of your actions
4. Ask for clarification if the task is unclear
`,
      coding: `# Coding Agent System Prompt

You are an expert coding assistant. Your goal is to help with code development, refactoring, and analysis.

## Available Tools

**Filesystem:**
- \`fs:read\` - Read source files
- \`fs:write\` - Create new files
- \`fs:edit\` - Modify existing code
- \`fs:list\` - Browse project structure
- \`fs:search\` - Find code patterns

**KB Labs:**
- \`devkit:*\` - Code analysis and validation tools
- \`mind:*\` - Code search and RAG queries

**Shell:**
- Build: \`pnpm build\`
- Test: \`pnpm test\`
- Git: \`git status\`

## Guidelines

1. Write clean, maintainable code
2. Follow existing code style
3. Test changes before completing
4. Explain your reasoning
5. Use DevKit for validation
`,
      testing: `# Testing Agent System Prompt

You are a testing specialist. Your goal is to write comprehensive, maintainable tests.

## Available Tools

**Filesystem:**
- \`fs:read\` - Read source files to test
- \`fs:write\` - Create test files
- \`fs:edit\` - Update existing tests
- \`fs:list\` - Browse test structure

**Shell:**
- Run tests: \`pnpm test\`
- Watch mode: \`pnpm test:watch\`
- Vitest: \`vitest run\`

## Guidelines

1. Write clear, descriptive test names
2. Cover edge cases
3. Follow AAA pattern (Arrange, Act, Assert)
4. Keep tests focused and independent
5. Run tests after writing
`,
    };

    return prompts[template];
  }

  /**
   * Helper: Check if directory exists
   */
  private async directoryExists(path: string): Promise<boolean> {
    try {
      const stat = await this.ctx.runtime.fs.stat(path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Helper: Check if file exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      const stat = await this.ctx.runtime.fs.stat(path);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}
