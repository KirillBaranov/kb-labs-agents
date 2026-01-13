/**
 * V3 Manifest for KB Labs Agents
 *
 * Defines CLI commands for agent management and execution
 */

import { defineManifest, defineCommandFlags, generateExamples } from '@kb-labs/sdk';
import type { PermissionSpec } from '@kb-labs/sdk';

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
            description: 'Agent ID to execute',
            required: true,
            alias: 'a',
          },
          task: {
            type: 'string',
            description: 'Task description for the agent',
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
            description: 'Run coding agent',
            flags: { agentId: 'coding-agent', task: 'Fix the bug in auth.ts' }
          },
          {
            description: 'Run with JSON output',
            flags: { agentId: 'coding-agent', task: 'Add tests', json: true }
          },
        ]),
        handler: './cli/commands/run.js#default',
        handlerPath: './cli/commands/run.js',
        permissions: runPermissions,
      }
    ]
  },
  permissions: pluginPermissions
});

export default manifest;
