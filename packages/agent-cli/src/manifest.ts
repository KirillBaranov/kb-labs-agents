/**
 * KB Labs Agent Plugin - Manifest V3
 */

import {
  combinePermissions,
  kbPlatformPreset,
  defineCommandFlags,
} from '@kb-labs/sdk';
import {
  AGENTS_BASE_PATH,
  AGENTS_WS_BASE_PATH,
  AGENTS_ROUTES,
  AGENTS_WS_CHANNELS,
} from '@kb-labs/agent-contracts';

/**
 * Command flags for agent:run (unified command with modes)
 */
const runFlags = {
  task: {
    type: 'string',
    description: 'Task description',
  },
  mode: {
    type: 'string',
    description: 'Agent mode: execute (default), plan, edit, debug',
    default: 'execute',
  },
  'session-id': {
    type: 'string',
    description: 'Session ID (auto-generated if not provided)',
  },
  complexity: {
    type: 'string',
    description: 'Task complexity (for plan mode): simple, medium, complex',
  },
  files: {
    type: 'array',
    description: 'Target files (for edit mode)',
  },
  trace: {
    type: 'string',
    description: 'Trace file path (for debug mode)',
  },
  'dry-run': {
    type: 'boolean',
    description: 'Preview changes without applying (for edit mode)',
    default: false,
  },
  verbose: {
    type: 'boolean',
    description: 'Verbose output',
    default: false,
  },
} as const;

/**
 * Plugin permissions
 */
const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withFs({
    mode: 'readWrite',
    allow: ['.agent-memory/**', '**/*'], // Allow filesystem operations in working dir
  })
  .withPlatform({
    llm: true,  // Full LLM access for agent execution
    cache: ['agent:'], // Cache namespace prefix
    analytics: true,  // Track agent usage
  })
  .withQuotas({
    timeoutMs: 1800000, // 30 min for complex tasks
    memoryMb: 1024,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/agent',
  version: '0.1.0',

  display: {
    name: 'Agent System',
    description: 'Autonomous agent system with LLM tool calling, task orchestration, and tier escalation.',
    tags: ['agent', 'autonomous', 'llm', 'orchestration'],
  },

  platform: {
    requires: ['llm'],
    optional: ['cache', 'analytics', 'logger'],
  },

  cli: {
    commands: [
      {
        id: 'agent:run',
        group: 'agent',
        describe: 'Run agent with specified mode (execute/plan/edit/debug)',
        longDescription:
          'Unified agent command with multiple modes: ' +
          'execute (default) - run task immediately, ' +
          'plan - generate execution plan without running, ' +
          'edit - modify existing files, ' +
          'debug - analyze errors with trace context. ' +
          'Supports filesystem, search, shell, memory, and user interaction tools.',

        handler: './cli/commands/run.js#default',
        handlerPath: './cli/commands/run.js',

        flags: defineCommandFlags(runFlags),

        examples: [
          'kb agent:run --task="Create analytics system"',
          'kb agent:run --mode=plan --task="Add auth" --complexity=complex',
          'kb agent:run --mode=edit --task="Fix bug" --files src/auth.ts',
          'kb agent:run --mode=debug --task="Why crash?" --trace .kb/traces/trace-123.json',
        ],
      },
    ],
  },

  capabilities: [],

  permissions: pluginPermissions,

  // REST API for Agent UI
  rest: {
    basePath: AGENTS_BASE_PATH,
    defaults: {
      timeoutMs: 1800000, // 30 min for long-running tasks
    },
    routes: [
      {
        method: 'POST',
        path: AGENTS_ROUTES.RUN,
        description: 'Start a new agent run',
        handler: './rest/handlers/run-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.RUN_STATUS,
        description: 'Get status of a run',
        handler: './rest/handlers/status-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.CORRECT,
        description: 'Send correction to running agent(s)',
        handler: './rest/handlers/correct-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.STOP,
        description: 'Stop a running agent',
        handler: './rest/handlers/stop-handler.js',
        security: ['none'],
      },
      // Session management routes
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSIONS_LIST,
        description: 'List all sessions',
        handler: './rest/handlers/list-sessions-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_GET,
        description: 'Get session details',
        handler: './rest/handlers/get-session-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_CREATE,
        description: 'Create a new session',
        handler: './rest/handlers/create-session-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_EVENTS,
        description: 'Get session events (chat history)',
        handler: './rest/handlers/get-session-events-handler.js',
        security: ['none'],
      },
    ],
  },

  // WebSocket for real-time event streaming
  ws: {
    basePath: AGENTS_WS_BASE_PATH,
    defaults: {
      auth: 'none',
      idleTimeoutMs: 3600000, // 1 hour
    },
    channels: [
      {
        path: AGENTS_WS_CHANNELS.EVENTS,
        description: 'Real-time agent event streaming',
        handler: './ws/events-handler.js',
        auth: 'none',
      },
    ],
  },

  artifacts: [
    {
      id: 'agent.memory.json',
      pathTemplate: '.agent-memory/memory.json',
      description: 'Persistent agent memory (facts, sessions, project context).',
    },
  ],
};
