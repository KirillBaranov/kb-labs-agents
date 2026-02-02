/**
 * Memory tools for persistent context and session management
 *
 * ARCHITECTURE:
 * - Shared memory (.kb/memory/shared/) - persistent across sessions
 *   - preferences: user preferences (e.g., "use TypeScript strict mode")
 *   - constraints: project rules (e.g., "never modify /legacy/")
 *
 * - Session memory (.kb/memory/session-xxx/) - handled by FileMemory
 *   - corrections: user corrections for current session
 *   - findings: agent discoveries
 *   - blockers: current blockers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import type { MemoryEntry, SessionEntry } from '@kb-labs/agent-contracts';

/**
 * Shared memory structure (persistent)
 */
interface SharedMemory {
  preferences: MemoryEntry[];
  constraints: MemoryEntry[];
  sessions: SessionEntry[];
  projectContext: {
    name: string;
    description: string;
    technologies: string[];
    structure: string;
  };
}

/**
 * Get memory file path
 * Uses .kb/memory/shared/ for cross-session persistent memory
 */
function getMemoryPath(context: ToolContext): string {
  // Use .kb/memory/shared/ for persistent memory across sessions
  const memoryDir = path.join(context.workingDir, '.kb', 'memory', 'shared');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  return path.join(memoryDir, 'memory.json');
}

/**
 * Load shared memory from disk
 */
function loadSharedMemory(context: ToolContext): SharedMemory {
  const memoryPath = getMemoryPath(context);

  const defaultMemory: SharedMemory = {
    preferences: [],
    constraints: [],
    sessions: [],
    projectContext: {
      name: '',
      description: '',
      technologies: [],
      structure: '',
    },
  };

  if (!fs.existsSync(memoryPath)) {
    return defaultMemory;
  }

  try {
    const content = fs.readFileSync(memoryPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Migration: convert old format (facts array) to new format
    if (parsed.facts && Array.isArray(parsed.facts)) {
      const preferences = parsed.facts.filter((f: MemoryEntry) => f.type === 'user_preference');
      const constraints = parsed.facts.filter((f: MemoryEntry) => f.type === 'constraint');
      return {
        preferences,
        constraints,
        sessions: parsed.sessions || [],
        projectContext: parsed.projectContext || defaultMemory.projectContext,
      };
    }

    return {
      ...defaultMemory,
      ...parsed,
    };
  } catch {
    return defaultMemory;
  }
}

/**
 * Save shared memory to disk
 */
function saveSharedMemory(context: ToolContext, memory: SharedMemory): void {
  const memoryPath = getMemoryPath(context);
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2), 'utf-8');
}

/**
 * Get shared memory (preferences, constraints, project context)
 */
export function createMemoryGetTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_get',
        description:
          'Retrieve shared memory: user preferences, project constraints, and session history. Use at the start of tasks to understand project rules and user preferences.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Optional session ID to get specific session context',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string | undefined;
      const memory = loadSharedMemory(context);

      // Format preferences
      const preferencesText =
        memory.preferences.length > 0
          ? memory.preferences.map((p) => `- ${p.content}`).join('\n')
          : 'No preferences set';

      // Format constraints
      const constraintsText =
        memory.constraints.length > 0
          ? memory.constraints.map((c) => `- ${c.content}`).join('\n')
          : 'No constraints set';

      // Format sessions
      const sessions = sessionId
        ? memory.sessions.filter((s) => s.sessionId === sessionId)
        : memory.sessions.slice(-5);

      const sessionInfo = sessions
        .map((s) => {
          const tasks = s.tasks.join(', ');
          return `Session ${s.sessionId} (${s.timestamp}):\n  Tasks: ${tasks}\n  Learnings: ${s.learnings}`;
        })
        .join('\n\n');

      const output = [
        '=== Shared Memory ===',
        '',
        '## 👤 User Preferences (persistent)',
        preferencesText,
        '',
        '## 🚫 Constraints (persistent)',
        constraintsText,
        '',
        '## Project Context',
        `Name: ${memory.projectContext.name || 'Unknown'}`,
        `Description: ${memory.projectContext.description || 'N/A'}`,
        `Technologies: ${memory.projectContext.technologies.join(', ') || 'N/A'}`,
        '',
        '## Session History',
        sessionInfo || 'No sessions yet',
        '',
        '---',
        'Note: Corrections, findings, and blockers are stored in session memory.',
      ].join('\n');

      return {
        success: true,
        output,
      };
    },
  };
}

/**
 * Add user preference to shared memory (persistent)
 */
export function createMemoryPreferenceTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_preference',
        description:
          'Store a user preference that persists across sessions. Use for coding style preferences, tool preferences, or workflow preferences. Examples: "Always use TypeScript strict mode", "Prefer functional components over class components".',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The preference to store (e.g., "Always use TypeScript strict mode")',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags for categorization (e.g., ["typescript", "style"])',
            },
          },
          required: ['content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string;
      const tags = input.tags as string[] | undefined;

      const memory = loadSharedMemory(context);

      const preference: MemoryEntry = {
        content,
        category: 'user_input',
        timestamp: new Date().toISOString(),
        type: 'user_preference',
        metadata: {
          importance: 0.9,
          source: 'user',
          scope: 'project',
          tags,
        },
      };

      memory.preferences.push(preference);

      // Keep only last 50 preferences
      if (memory.preferences.length > 50) {
        memory.preferences = memory.preferences.slice(-50);
      }

      saveSharedMemory(context, memory);

      return {
        success: true,
        output: `👤 Preference stored: ${content}`,
      };
    },
  };
}

/**
 * Add constraint to shared memory (persistent)
 */
export function createMemoryConstraintTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_constraint',
        description:
          'Store a project constraint or rule that must be followed. Persists across sessions. Use for project rules like "never modify files in /legacy/" or "all API endpoints must be versioned".',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The constraint (e.g., "Do not modify files in /legacy/ directory")',
            },
          },
          required: ['content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string;

      const memory = loadSharedMemory(context);

      const constraint: MemoryEntry = {
        content,
        category: 'project_rules',
        timestamp: new Date().toISOString(),
        type: 'constraint',
        metadata: {
          importance: 1.0,
          source: 'user',
          scope: 'project',
        },
      };

      memory.constraints.push(constraint);

      // Keep only last 50 constraints
      if (memory.constraints.length > 50) {
        memory.constraints = memory.constraints.slice(-50);
      }

      saveSharedMemory(context, memory);

      return {
        success: true,
        output: `🚫 Constraint stored: ${content}`,
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Session Memory Tools - corrections, findings, blockers (session-scoped)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get session memory directory path
 * Creates directory if it doesn't exist
 */
function getSessionMemoryPath(context: ToolContext, sessionId?: string): string {
  const id = sessionId || `session-${Date.now()}`;
  const sessionDir = path.join(context.workingDir, '.kb', 'memory', id);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Save entry to session memory
 */
function saveToSession(context: ToolContext, entry: MemoryEntry, sessionId?: string): void {
  const sessionDir = getSessionMemoryPath(context, sessionId);
  const entryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const filePath = path.join(sessionDir, `${entryId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...entry, id: entryId }, null, 2), 'utf-8');
}

/**
 * Add user correction to session memory
 * Session-scoped - only valid for current session
 */
export function createMemoryCorrectionTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_correction',
        description:
          'Store a user correction in session memory. Use when the user corrects your understanding or provides accurate information that overrides your assumptions. Session-scoped (not persistent across sessions).',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description:
                'The correction (e.g., "AuthService is in packages/auth/, not src/services/")',
            },
            supersedes: {
              type: 'string',
              description: 'Optional: what this correction replaces',
            },
            sessionId: {
              type: 'string',
              description: 'Optional: session ID (defaults to current timestamp-based session)',
            },
          },
          required: ['content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string;
      const supersedes = input.supersedes as string | undefined;
      const sessionId = input.sessionId as string | undefined;

      const correction: MemoryEntry = {
        content,
        category: 'user_input',
        timestamp: new Date().toISOString(),
        type: 'user_correction',
        metadata: {
          importance: 1.0,
          source: 'user',
          supersedes,
          scope: 'session',
        },
      };

      saveToSession(context, correction, sessionId);

      const supersedesInfo = supersedes ? ` (replaces: ${supersedes})` : '';
      return {
        success: true,
        output: `⚠️ Correction stored in session${supersedesInfo}: ${content}`,
      };
    },
  };
}

/**
 * Add finding to session memory
 */
export function createMemoryFindingTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_finding',
        description:
          'Store a discovery or finding in session memory. Use when you discover something important about the codebase with a confidence level.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The finding (e.g., "All services use Repository pattern")',
            },
            confidence: {
              type: 'number',
              description: 'Confidence level 0-1 (e.g., 0.9 for high confidence)',
            },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source files that support this finding',
            },
            sessionId: {
              type: 'string',
              description: 'Optional: session ID',
            },
          },
          required: ['content', 'confidence'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string;
      const confidence = input.confidence as number;
      const sources = input.sources as string[] | undefined;
      const sessionId = input.sessionId as string | undefined;

      const finding: MemoryEntry = {
        content,
        category: 'learning',
        timestamp: new Date().toISOString(),
        type: 'finding',
        metadata: {
          importance: confidence,
          confidence,
          source: 'agent',
          tags: sources,
          scope: 'session',
        },
      };

      saveToSession(context, finding, sessionId);

      return {
        success: true,
        output: `🔍 Finding stored (confidence: ${(confidence * 100).toFixed(0)}%): ${content}`,
      };
    },
  };
}

/**
 * Add blocker to session memory
 */
export function createMemoryBlockerTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_blocker',
        description:
          'Store a blocker in session memory. Use when you cannot proceed without additional information or user input.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The blocker (e.g., "Cannot find database config. Need DATABASE_URL")',
            },
            taskId: {
              type: 'string',
              description: 'Optional: related task ID',
            },
            sessionId: {
              type: 'string',
              description: 'Optional: session ID',
            },
          },
          required: ['content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const content = input.content as string;
      const taskId = input.taskId as string | undefined;
      const sessionId = input.sessionId as string | undefined;

      const blocker: MemoryEntry = {
        content,
        category: 'agent_state',
        timestamp: new Date().toISOString(),
        type: 'blocker',
        metadata: {
          importance: 1.0,
          source: 'agent',
          taskId,
          scope: 'session',
        },
      };

      saveToSession(context, blocker, sessionId);

      return {
        success: true,
        output: `🛑 Blocker stored: ${content}`,
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Session Summary Tool
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save session summary (shared)
 */
export function createSessionSaveTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'session_save',
        description:
          'Save session summary and learnings to shared memory. Use at the end of a session to record what was accomplished. This helps future sessions understand project history.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier',
            },
            tasks: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of tasks completed in this session',
            },
            learnings: {
              type: 'string',
              description: 'Summary of what was learned or discovered',
            },
          },
          required: ['sessionId', 'tasks', 'learnings'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;
      const tasks = input.tasks as string[];
      const learnings = input.learnings as string;

      const memory = loadSharedMemory(context);

      const session: SessionEntry = {
        sessionId,
        timestamp: new Date().toISOString(),
        tasks,
        learnings,
      };

      memory.sessions.push(session);

      // Keep only last 50 sessions
      if (memory.sessions.length > 50) {
        memory.sessions = memory.sessions.slice(-50);
      }

      saveSharedMemory(context, memory);

      return {
        success: true,
        output: `Session ${sessionId} saved with ${tasks.length} task(s)`,
      };
    },
  };
}
