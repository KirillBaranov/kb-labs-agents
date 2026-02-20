/**
 * REST API & WebSocket route constants for agents plugin
 */

/**
 * Base path for agents REST API routes
 */
export const AGENTS_BASE_PATH = '/v1/plugins/agents' as const;

/**
 * Base path for agents WebSocket channels
 */
export const AGENTS_WS_BASE_PATH = '/v1/ws/plugins/agents' as const;

/**
 * REST API route paths (relative to basePath)
 */
export const AGENTS_ROUTES = {
  /** GET - List all available agents */
  LIST: '',

  /** POST /run - Start a new agent run */
  RUN: '/run',

  /** GET /run/:runId - Get run status */
  RUN_STATUS: '/run/:runId',

  /** POST /run/:runId/correct - Send user correction to running agent */
  CORRECT: '/run/:runId/correct',

  /** POST /run/:runId/stop - Stop running agent */
  STOP: '/run/:runId/stop',

  // ═══════════════════════════════════════════════════════════════════════
  // Session Management Routes
  // ═══════════════════════════════════════════════════════════════════════

  /** GET /sessions - List all sessions */
  SESSIONS_LIST: '/sessions',

  /** GET /sessions/:sessionId - Get session details */
  SESSION_GET: '/sessions/:sessionId',

  /** POST /sessions - Create new session */
  SESSION_CREATE: '/sessions',

  /** GET /sessions/:sessionId/turns - Get session turns (turn-based UI) */
  SESSION_TURNS: '/sessions/:sessionId/turns',
} as const;

/**
 * WebSocket channel paths (relative to wsBasePath)
 */
export const AGENTS_WS_CHANNELS = {
  /** WS /session/:sessionId - Persistent session stream (all runs in session) */
  SESSION_STREAM: '/session/:sessionId',
} as const;

/**
 * Build full REST route path
 */
export function buildRestRoute(route: keyof typeof AGENTS_ROUTES, params?: Record<string, string>): string {
  let path = `${AGENTS_BASE_PATH}${AGENTS_ROUTES[route]}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, value);
    }
  }
  return path;
}

/**
 * Build full WebSocket channel path
 */
export function buildWsChannel(channel: keyof typeof AGENTS_WS_CHANNELS, params?: Record<string, string>): string {
  let path = `${AGENTS_WS_BASE_PATH}${AGENTS_WS_CHANNELS[channel]}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, value);
    }
  }
  return path;
}
