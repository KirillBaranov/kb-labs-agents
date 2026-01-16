/**
 * @module @kb-labs/agent-contracts/routes
 * REST API route constants for agents plugin
 */

/**
 * Base path for agents REST API routes
 */
export const AGENTS_BASE_PATH = '/v1/plugins/agents' as const;

/**
 * REST API route paths (relative to basePath)
 */
export const AGENTS_ROUTES = {
  /** GET - List all available agents */
  LIST: '',

  /** POST /run - Execute an agent with a task */
  RUN: '/run',
} as const;
