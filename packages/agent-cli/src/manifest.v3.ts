/**
 * V3 Manifest for KB Labs Agents
 *
 * Defines CLI commands for agent management and execution
 */

import { defineManifest, defineCommandFlags, generateExamples } from '@kb-labs/sdk';
import type { PermissionSpec } from '@kb-labs/sdk';
// import { AGENTS_BASE_PATH, AGENTS_ROUTES } from '@kb-labs/agent-contracts';

/**
 * Plugin permissions - needs full filesystem and shell access for agents
 */
const pluginPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/agents/**', '.kb/cache/**', '.kb/mind/**', '**'],
    write: ['.kb/agents/**', '.kb/cache/**', '**'],
  },
  shell: {
    allow: ['*'],
  },
  env: {
    read: ['*'],
  },
  platform: {
    llm: true,
    cache: true,
  },
  quotas: {
    timeoutMs: 3600000, // 1 hour for agent execution (will be background jobs later)
    memoryMb: 512,
  },
};

const initPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/agents/**'],
    write: ['.kb/agents/**'],
  },
  quotas: {
    timeoutMs: 10000,
    memoryMb: 64,
  },
};

const listPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/agents/**'],
  },
  platform: {
    cache: true,
  },
  quotas: {
    timeoutMs: 30000,
    memoryMb: 128,
  },
};

const runPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/**', '**'], // Agents need full access
    write: ['.kb/**', '**'],
  },
  shell: {
    allow: ['*'], // Agents can execute any shell command
  },
  env: {
    read: ['*'],
  },
  platform: {
    llm: true,
    cache: true,
  },
  invoke: {
    allow: ['*'], // Agents can invoke any plugin
  },
  quotas: {
    timeoutMs: 3600000, // 1 hour for testing (background jobs in future)
    memoryMb: 512,
  },
};

export const manifest = defineManifest({
  schema: 'kb.plugin/3',
  id: '@kb-labs/agents-cli',
  version: '0.1.0',
  display: {
    name: 'KB Labs Agents',
    description: 'Autonomous agents powered by LLMs with tool calling capabilities',
    tags: ['agents', 'llm', 'automation', 'tools']
  },
  cli: {
    commands: [
      {
        id: 'agent:init',
        group: 'agent',
        describe: 'Initialize .kb/agents/ directory for agent definitions',
        longDescription: 'Creates the .kb/agents/ directory where agent configuration files (YAML) can be placed. This is the first step in setting up agents in your project.',
        flags: defineCommandFlags({
          force: {
            type: 'boolean',
            description: 'Force re-initialization even if directory exists',
            default: false,
            alias: 'f',
          },
        }),
        examples: generateExamples('init', 'agent', [
          { description: 'Initialize agents directory', flags: {} },
          { description: 'Force re-initialization', flags: { force: true } },
        ]),
        handler: './cli/commands/init.js#default',
        handlerPath: './cli/commands/init.js',
        permissions: initPermissions,
      },
      {
        id: 'agent:list',
        group: 'agent',
        describe: 'List all discovered agent definitions',
        longDescription: 'Scans .kb/agents/ directory and displays all available agent configurations with their tools and capabilities.',
        flags: defineCommandFlags({
          json: {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          },
        }),
        examples: generateExamples('list', 'agent', [
          { description: 'List all agents', flags: {} },
          { description: 'Output as JSON', flags: { json: true } },
        ]),
        handler: './cli/commands/list.js#default',
        handlerPath: './cli/commands/list.js',
        permissions: listPermissions,
      },
      {
        id: 'agent:inspect',
        group: 'agent',
        describe: 'Inspect agent configuration (tools, prompt, output schema)',
        longDescription: 'Shows the agent configuration including system prompt, available tools (including submit_result), output schema, and execution limits. Useful for debugging agent behavior.',
        flags: defineCommandFlags({
          agentId: {
            type: 'string',
            description: 'Agent ID to inspect',
            required: true,
          },
        }),
        examples: generateExamples('inspect', 'agent', [
          { description: 'Inspect implementer agent', flags: { agentId: 'implementer' } },
          { description: 'Inspect researcher agent', flags: { agentId: 'researcher' } },
          { description: 'Inspect reviewer agent', flags: { agentId: 'reviewer' } },
        ]),
        handler: './cli/commands/inspect.js#default',
        handlerPath: './cli/commands/inspect.js',
        permissions: listPermissions,
      },
      {
        id: 'agent:run',
        group: 'agent',
        describe: 'Execute a complex task via orchestrator with agent delegation',
        longDescription: 'Runs an orchestrator that breaks complex tasks into subtasks, delegates them to agents, and synthesizes results into a coherent answer. Uses smart tier LLM for planning and synthesis.',
        flags: defineCommandFlags({
          task: {
            type: 'string',
            description: 'Task description for the orchestrator',
            required: true,
            alias: 't',
          },
          json: {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          },
        }),
        examples: generateExamples('run', 'agent', [
          {
            description: 'Execute complex multi-step task',
            flags: { task: 'Analyze the V2 agent architecture and create implementation plan' }
          },
          {
            description: 'Research and implement feature',
            flags: { task: 'Find how hybrid search works and add similar functionality to workflow engine' }
          },
          {
            description: 'Output as JSON',
            flags: { task: 'Explain the plugin system architecture', json: true }
          },
        ]),
        handler: './cli/commands/agent-run.js#default',
        handlerPath: './cli/commands/agent-run.js',
        permissions: runPermissions,
      }
    ]
  },

  // REST API routes for Studio integration (TODO: fix to work with new AgentOutcome structure)
  // rest: {
  //   basePath: AGENTS_BASE_PATH,
  //   routes: [
  //     // GET / - List all available agents
  //     {
  //       method: 'GET',
  //       path: AGENTS_ROUTES.LIST,
  //       handler: './rest/list-agents.js#default',
  //       output: {
  //         zod: '@kb-labs/agent-contracts#ListAgentsResponseSchema',
  //       },
  //     },
  //     // POST /run - Execute an agent
  //     {
  //       method: 'POST',
  //       path: AGENTS_ROUTES.RUN,
  //       handler: './rest/run-agent.js#default',
  //       input: {
  //         zod: '@kb-labs/agent-contracts#RunAgentRequestSchema',
  //       },
  //       output: {
  //         zod: '@kb-labs/agent-contracts#AgentResponseSchema',
  //       },
  //       timeoutMs: 3600000, // 1 hour for agent execution (will be background jobs later)
  //     },
  //   ],
  // },

  permissions: pluginPermissions
});

export default manifest;
