/**
 * Tool Strategy Configuration
 *
 * Defines how agents discover, prioritize, and use tools.
 * Supports grouped tools with priorities, hints, and gating.
 *
 * @example Researcher agent config:
 * ```yaml
 * tools:
 *   strategy: prioritized
 *   groups:
 *     - name: semantic
 *       priority: 1
 *       tools: ['mind:rag-query']
 *       hints: ['Use first for finding code']
 *     - name: classical
 *       priority: 2
 *       unlockAfter: semantic
 *       tools: ['fs:search', 'fs:glob']
 * ```
 */

/**
 * Tool strategy mode
 *
 * - `prioritized`: Tools are ordered by group priority, hints injected into prompt
 * - `gated`: Groups are locked until `unlockAfter` group is used
 * - `unrestricted`: All tools available equally (flat list)
 */
export type ToolStrategyMode = 'prioritized' | 'gated' | 'unrestricted';

/**
 * Built-in tool categories
 */
export type BuiltInToolCategory =
  | 'fs'      // Filesystem: read, write, edit, list, search, glob, exists
  | 'shell'   // Shell: exec
  | 'code';   // Code analysis: find-definition, find-usages, ast-query

/**
 * Hint for LLM on when/how to use tools in this group
 */
export type ToolHint = string;

/**
 * Tool group configuration
 */
export interface ToolGroup {
  /**
   * Group name (for reference in unlockAfter, logging)
   * @example 'semantic', 'classical', 'direct'
   */
  name: string;

  /**
   * Priority (1 = highest, use first)
   * Lower number = higher priority
   */
  priority: number;

  /**
   * Tool patterns in this group
   * Supports glob patterns: 'mind:*', 'fs:read', 'code:find-*'
   */
  tools: string[];

  /**
   * Hints injected into system prompt
   * Help LLM understand when to use these tools
   */
  hints?: ToolHint[];

  /**
   * Gate: only unlock after specified group was used
   * Only applies in 'gated' strategy mode
   *
   * @example 'semantic' - this group unlocks after semantic group tools used
   */
  unlockAfter?: string;

  /**
   * Minimum confidence from previous group to unlock
   * Only applies with unlockAfter
   *
   * @example 0.5 - unlock if semantic search returned <0.5 confidence
   */
  unlockWhenConfidenceBelow?: number;
}

/**
 * Filesystem permissions
 */
export interface FsPermissions {
  /** Glob patterns for allowed read paths */
  read?: string[];
  /** Glob patterns for allowed write paths */
  write?: string[];
}

/**
 * Shell permissions
 */
export interface ShellPermissions {
  /** Allowed command patterns (glob) */
  allow?: string[];
  /** Denied command patterns (glob) */
  deny?: string[];
}

/**
 * KB Labs plugin tools permissions
 */
export interface KBLabsPermissions {
  /** Allowed tool patterns (glob): ['mind:*', 'devkit:check-*'] */
  allow?: string[];
  /** Denied tool patterns (glob): ['workflow:delete'] */
  deny?: string[];
}

/**
 * Tool permissions configuration
 */
export interface ToolPermissions {
  /** Filesystem permissions */
  fs?: FsPermissions;
  /** Shell permissions */
  shell?: ShellPermissions;
  /** KB Labs plugin tools */
  kbLabs?: KBLabsPermissions;
}

/**
 * Complete tool strategy configuration
 *
 * Replaces old AgentToolsConfig with cleaner, more powerful API
 */
export interface ToolStrategyConfig {
  /**
   * Strategy mode
   * @default 'unrestricted'
   */
  strategy: ToolStrategyMode;

  /**
   * Tool groups with priorities and hints
   * Required for 'prioritized' and 'gated' modes
   */
  groups?: ToolGroup[];

  /**
   * Permissions for tool categories
   * Controls what tools can access
   */
  permissions?: ToolPermissions;

  /**
   * Enable/disable built-in tool categories
   * @default All enabled
   */
  builtIn?: {
    /** Filesystem tools: fs:read, fs:write, fs:edit, fs:list, fs:search, fs:glob, fs:exists */
    fs?: boolean;
    /** Shell tools: shell:exec */
    shell?: boolean;
    /** Code analysis tools: code:find-definition, code:find-usages, code:ast-query */
    code?: boolean;
  };
}

/**
 * Runtime tool state (tracked during execution)
 */
export interface ToolExecutionState {
  /** Groups that have been used */
  usedGroups: Set<string>;
  /** Tool calls with their results */
  toolCalls: Array<{
    tool: string;
    group: string;
    timestamp: number;
    confidence?: number;
  }>;
  /** Currently unlocked groups */
  unlockedGroups: Set<string>;
}

/**
 * Tool availability check result
 */
export interface ToolAvailability {
  /** Whether tool is available */
  available: boolean;
  /** Reason if not available */
  reason?: string;
  /** Hint for LLM */
  hint?: string;
  /** Group this tool belongs to */
  group?: string;
}
