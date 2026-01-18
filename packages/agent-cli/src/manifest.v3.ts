/**
 * V3 Manifest for KB Labs Agents
 *
 * Defines CLI commands for agent management and execution
 */

import { defineManifest, defineCommandFlags, generateExamples } from '@kb-labs/sdk';
import type { PermissionSpec } from '@kb-labs/sdk';
import { AGENTS_BASE_PATH, AGENTS_ROUTES } from '@kb-labs/agent-contracts';

/**
 * Plugin permissions - needs full filesystem and shell access for agents
 */
const pluginPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/agents/**', '.kb/specialists/**', '.kb/cache/**', '.kb/mind/**', '**'],
    write: ['.kb/agents/**', '.kb/specialists/**', '.kb/cache/**', '**'],
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
    timeoutMs: 300000, // 5 minutes for agent execution
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
    timeoutMs: 300000, // 5 minutes
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
        id: 'agent:run',
        group: 'agent',
        describe: 'Execute an agent with a task',
        longDescription: 'Runs an agent with the specified task. The agent will use available tools (filesystem, shell, KB Labs plugins) to accomplish the task autonomously with LLM reasoning and loop detection.',
        flags: defineCommandFlags({
          agentId: {
            type: 'string',
            description: 'Agent ID to execute (not required with --adaptive)',
            required: false,
            alias: 'a',
          },
          task: {
            type: 'string',
            description: 'Task description for the agent',
            required: true,
            alias: 't',
          },
          adaptive: {
            type: 'boolean',
            description: 'Use adaptive orchestration (cost-optimized multi-tier execution)',
            default: false,
          },
          json: {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          },
        }),
        examples: generateExamples('run', 'agent', [
          {
            description: 'Run coding agent',
            flags: { agentId: 'coding-agent', task: 'Fix the bug in auth.ts' }
          },
          {
            description: 'Run with adaptive orchestration (cost-optimized)',
            flags: { agentId: 'coding-agent', task: 'Implement user authentication', adaptive: true }
          },
          {
            description: 'Run with JSON output',
            flags: { agentId: 'coding-agent', task: 'Add tests', json: true }
          },
        ]),
        handler: './cli/commands/run.js#default',
        handlerPath: './cli/commands/run.js',
        permissions: runPermissions,
      },
      {
        id: 'specialist:run',
        group: 'specialist',
        describe: 'Execute a specialist with a task (V2 Architecture)',
        longDescription: 'Runs a specialist agent with configurable forced reasoning, static context, and structured I/O. Specialists are domain experts with deep context loaded from .kb/specialists/.',
        flags: defineCommandFlags({
          specialistId: {
            type: 'string',
            description: 'Specialist ID to execute (e.g., researcher, implementer)',
            required: true,
            alias: 's',
          },
          task: {
            type: 'string',
            description: 'Task description for the specialist',
            required: true,
            alias: 't',
          },
          json: {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          },
        }),
        examples: generateExamples('run', 'specialist', [
          {
            description: 'Run researcher specialist',
            flags: { specialistId: 'researcher', task: 'Find implementation of Mind RAG hybrid search' }
          },
          {
            description: 'Run implementer specialist',
            flags: { specialistId: 'implementer', task: 'Add unit tests for VectorStore interface' }
          },
          {
            description: 'Output as JSON',
            flags: { specialistId: 'researcher', task: 'Explain context compression', json: true }
          },
        ]),
        handler: './cli/commands/specialist-run.js#default',
        handlerPath: './cli/commands/specialist-run.js',
        permissions: runPermissions,
      },
      {
        id: 'orchestrator:run',
        group: 'orchestrator',
        describe: 'Execute a complex task via orchestrator with specialist delegation',
        longDescription: 'Runs an orchestrator that breaks complex tasks into subtasks, delegates them to specialists, and synthesizes results into a coherent answer. Uses smart tier LLM for planning and synthesis.',
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
        examples: generateExamples('run', 'orchestrator', [
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
        handler: './cli/commands/orchestrator-run.js#default',
        handlerPath: './cli/commands/orchestrator-run.js',
        permissions: runPermissions,
      }
    ]
  },

  // REST API routes for Studio integration
  rest: {
    basePath: AGENTS_BASE_PATH,
    routes: [
      // GET / - List all available agents
      {
        method: 'GET',
        path: AGENTS_ROUTES.LIST,
        handler: './rest/list-agents.js#default',
        output: {
          zod: '@kb-labs/agent-contracts#ListAgentsResponseSchema',
        },
      },
      // POST /run - Execute an agent
      {
        method: 'POST',
        path: AGENTS_ROUTES.RUN,
        handler: './rest/run-agent.js#default',
        input: {
          zod: '@kb-labs/agent-contracts#RunAgentRequestSchema',
        },
        output: {
          zod: '@kb-labs/agent-contracts#AgentResponseSchema',
        },
        timeoutMs: 300000, // 5 minutes for agent execution
      },
    ],
  },

  permissions: pluginPermissions
});

export default manifest;
