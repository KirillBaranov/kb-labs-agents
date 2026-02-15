/**
 * Session manager - handles agent session persistence
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentSession, AgentSessionInfo, AgentMode, AgentEvent } from '@kb-labs/agent-contracts';

/**
 * Extended session with agentId for storage
 */
interface StoredSession extends AgentSession {
  agentId: string;
  name?: string;
}

/**
 * Conversation turn extracted from events
 */
export interface ConversationTurn {
  userTask: string;
  agentResponse?: string;
  timestamp: string;
}

/**
 * Manages agent sessions (creation, persistence, retrieval)
 */
export class SessionManager {
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  /**
   * Create a new session
   */
  async createSession(config: {
    mode: AgentMode;
    task: string;
    agentId: string;
    name?: string;
    planId?: string;
  }): Promise<AgentSessionInfo> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const session: StoredSession = {
      id: sessionId,
      mode: config.mode,
      task: config.task,
      agentId: config.agentId,
      name: config.name || this.generateSessionName(config.task),
      planId: config.planId,
      workingDir: this.workingDir,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };

    await this.saveSession(session);

    return this.toSessionInfo(session, 0, undefined, now);
  }

  /**
   * Generate a human-readable session name from task
   */
  private generateSessionName(task: string): string {
    // Take first 50 chars, cut at word boundary
    const maxLen = 50;
    if (task.length <= maxLen) {return task;}
    const cut = task.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 20 ? cut.slice(0, lastSpace) + '...' : cut + '...';
  }

  /**
   * Convert stored session to session info
   */
  private toSessionInfo(
    session: StoredSession,
    runCount: number,
    lastMessage: string | undefined,
    lastActivityAt: string
  ): AgentSessionInfo {
    return {
      ...session,
      agentId: session.agentId,
      name: session.name,
      runCount,
      lastMessage,
      lastActivityAt,
    };
  }

  /**
   * Save session to disk
   */
  async saveSession(session: StoredSession | AgentSession): Promise<void> {
    const sessionDir = this.getSessionDir(session.id);
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, 'session.json');
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Load session from disk
   */
  async loadSession(sessionId: string): Promise<StoredSession | null> {
    try {
      const sessionFile = path.join(this.getSessionDir(sessionId), 'session.json');
      const content = await fs.readFile(sessionFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get session with full info
   */
  async getSessionInfo(sessionId: string): Promise<AgentSessionInfo | null> {
    const session = await this.loadSession(sessionId);
    if (!session) {return null;}

    const events = await this.getSessionEvents(sessionId);
    const runCount = events.filter((e) => e.type === 'agent:start').length;
    const lastLlmEvent = [...events].reverse().find((e) => e.type === 'llm:end');
    const lastMessage = lastLlmEvent?.data?.content as string | undefined;
    const lastEvent = events[events.length - 1];
    const lastActivityAt = lastEvent
      ? new Date(lastEvent.timestamp).toISOString()
      : session.updatedAt;

    return this.toSessionInfo(session, runCount, lastMessage?.slice(0, 100), lastActivityAt);
  }

  /**
   * Update session status
   */
  async updateSessionStatus(
    sessionId: string,
    status: AgentSession['status']
  ): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
  }

  /**
   * List all sessions with info
   */
  async listSessions(options?: {
    agentId?: string;
    status?: AgentSession['status'];
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: AgentSessionInfo[]; total: number }> {
    const sessionsRoot = path.join(this.workingDir, '.kb', 'agents', 'sessions');

    try {
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
      const sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      // Load session info in parallel for better performance
      const sessionInfos = await Promise.all(
        sessionDirs.map((sessionId) => this.getSessionInfo(sessionId))
      );

      // Filter out null results and apply user filters
      let sessions: AgentSessionInfo[] = sessionInfos
        .filter((info): info is AgentSessionInfo => {
          if (!info) {
            return false;
          }
          // Apply filters
          if (options?.agentId && info.agentId !== options.agentId) {
            return false;
          }
          if (options?.status && info.status !== options.status) {
            return false;
          }
          return true;
        });

      // Sort by last activity (newest first)
      sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

      const total = sessions.length;

      // Apply pagination
      if (options?.offset) {
        sessions = sessions.slice(options.offset);
      }
      if (options?.limit) {
        sessions = sessions.slice(0, options.limit);
      }

      return { sessions, total };
    } catch {
      return { sessions: [], total: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Storage (NDJSON format - append-safe)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add event to session (append-only, race-condition safe)
   */
  async addEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const eventsFile = this.getEventsPath(sessionId);
    const sessionDir = this.getSessionDir(sessionId);

    await fs.mkdir(sessionDir, { recursive: true });

    // Append as JSON line (NDJSON format) - safe for concurrent writes
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(eventsFile, line, 'utf-8');
  }

  /**
   * Get all events for a session
   */
  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; offset?: number; types?: string[] }
  ): Promise<AgentEvent[]> {
    const eventsFile = this.getEventsPath(sessionId);

    try {
      const content = await fs.readFile(eventsFile, 'utf-8');

      // Parse NDJSON (one JSON object per line)
      let events: AgentEvent[] = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e): e is AgentEvent => e !== null);

      // Filter by types
      if (options?.types?.length) {
        events = events.filter((e) => options.types!.includes(e.type));
      }

      // Apply pagination
      if (options?.offset) {
        events = events.slice(options.offset);
      }
      if (options?.limit) {
        events = events.slice(0, options.limit);
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Count events in session
   */
  async countEvents(sessionId: string, types?: string[]): Promise<number> {
    const events = await this.getSessionEvents(sessionId, { types });
    return events.length;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Conversation History (extracted from events)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract conversation history from session events
   *
   * Parses events.ndjson to reconstruct user-agent conversation turns.
   * Uses orchestrator:start (real user requests) NOT agent:start (includes internal subtasks).
   * Uses orchestrator:end for summaries.
   *
   * @param sessionId - Session ID
   * @param maxTurns - Maximum number of turns to return (default: 10)
   * @returns Array of conversation turns, oldest first
   */
  async getConversationHistory(
    sessionId: string,
    maxTurns = 10
  ): Promise<Array<{ userTask: string; agentResponse?: string; timestamp: string }>> {
    const events = await this.getSessionEvents(sessionId);

    if (events.length === 0) {
      return [];
    }

    const turns: Array<{ userTask: string; agentResponse?: string; timestamp: string }> = [];
    let currentTurn: { userTask: string; agentResponse?: string; timestamp: string } | null = null;

    for (const event of events) {
      // IMPORTANT: Use orchestrator:start, NOT agent:start!
      // agent:start includes internal subtasks (e.g., "Scan repository structure...")
      // orchestrator:start is the actual user request
      if (event.type === 'orchestrator:start') {
        // Save previous turn if exists
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = {
          userTask: event.data.task as string,
          timestamp: event.timestamp,
        };
      }

      // Orchestrator answer - capture synthesized response
      if (event.type === 'orchestrator:answer' && currentTurn) {
        // Truncate answer to max 500 chars
        const answer = String(event.data.answer);
        currentTurn.agentResponse = answer.length > 500
          ? answer.slice(0, 500) + '...'
          : answer;
      }
    }

    // Don't forget the last turn
    if (currentTurn) {
      turns.push(currentTurn);
    }

    // Return last N turns (excluding current one which will be added by caller)
    // Skip the last turn if it doesn't have a response yet (current run)
    const completedTurns = turns.filter(t => t.agentResponse);
    return completedTurns.slice(-maxTurns);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Path Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get session directory path
   */
  getSessionDir(sessionId: string): string {
    return path.join(this.workingDir, '.kb', 'agents', 'sessions', sessionId);
  }

  /**
   * Get events file path (NDJSON format)
   */
  getEventsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'events.ndjson');
  }

  /**
   * Get session plan file path
   */
  getSessionPlanPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'plan.json');
  }

  /**
   * Get session progress file path
   */
  getSessionProgressPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'progress.json');
  }
}
