/**
 * Agent Configuration Types
 *
 * Defines the structure for agent configuration stored in .kb/agents/{agent-id}/agent.yml
 */

import type { LLMTier } from './outcome.js';

/**
 * Agent configuration schema version
 */
export type AgentSchema = 'kb.agent/1';

/**
 * LLM configuration for the agent
 */
export interface AgentLLMConfig {
  /**
   * LLM tier (small/medium/large) - resolved to actual model via kb.config.json
   *
   * IMPORTANT: Use abstract tiers for flexibility!
   * DO NOT hardcode model names - platform resolves tier to model.
   *
   * @example 'small' - Fast, cheap (resolved to gpt-4o-mini)
   * @example 'medium' - Balanced (resolved to claude-sonnet-4-5)
   * @example 'large' - Powerful (resolved to claude-opus-4-5)
   */
  tier: LLMTier;

  /**
   * Escalation ladder for automatic tier upgrade on failures (Phase 4)
   *
   * If specialist fails with initial tier, orchestrator will retry with next tier.
   * Stops at first success or end of ladder.
   *
   * @example ['small', 'medium'] - Researcher (escalate to medium, but not large - too expensive)
   * @example ['medium', 'large'] - Implementer (start with medium, escalate to large if needed)
   * @example ['small'] - No escalation (always use small tier)
   *
   * Default: Uses tier as single-element ladder (no escalation)
   */
  escalationLadder?: LLMTier[];

  /** Temperature (0-1). Lower = more deterministic, higher = more creative */
  temperature: number;
  /** Maximum tokens for LLM response */
  maxTokens: number;
  /** Maximum tool calls per agent run (default: 20) */
  maxToolCalls?: number;
}

/**
 * Custom prompt configuration
 */
export interface AgentPromptConfig {
  /** Inline system prompt (directly in YAML) */
  system?: string;
  /** Path to system prompt file (relative to agent directory, e.g., "./system-prompt.md") */
  systemPrompt?: string;
  /** Path to examples file (relative to agent directory, e.g., "./examples.json") */
  examples?: string;
}

/**
 * Context files configuration
 */
export interface AgentContextFile {
  /** Path to context file (relative to agent directory) */
  path: string;
  /** Description of what this context provides */
  description?: string;
}

/**
 * Context configuration
 */
export interface AgentContextConfig {
  /** Additional context files to include in agent prompt */
  files?: AgentContextFile[];
}

/**
 * KB Labs tools allowlist/denylist configuration
 */
export interface AgentKBLabsToolsConfig {
  /** Mode: 'allowlist' (only allow specified) or 'denylist' (allow all except specified) */
  mode: 'allowlist' | 'denylist';
  /** Patterns to allow (e.g., ["mind:*", "devkit:check-*"]) */
  allow?: string[];
  /** Patterns to deny (e.g., ["workflow:delete"]) */
  deny?: string[];
}

/**
 * Filesystem permissions for agent
 */
export interface AgentFilesystemPermissions {
  /** Paths allowed for reading (glob patterns, e.g., ["./", "src/**"]) */
  read: string[];
  /** Paths allowed for writing (glob patterns, e.g., ["src/**", "!src/config/**"]) */
  write: string[];
}

/**
 * Filesystem tools configuration
 */
export interface AgentFilesystemConfig {
  /** Enable filesystem tools (fs:read, fs:write, fs:edit, fs:list, fs:search) */
  enabled: boolean;
  /** Mode: 'allowlist' (only allow specified tools) or 'denylist' (allow all except specified) */
  mode?: 'allowlist' | 'denylist';
  /** Tool names to allow (e.g., ["fs:read", "fs:list"]) */
  allow?: string[];
  /** Tool names to deny (e.g., ["fs:delete"]) */
  deny?: string[];
  /** Filesystem permissions */
  permissions?: AgentFilesystemPermissions;
}

/**
 * Shell tools configuration
 */
export interface AgentShellConfig {
  /** Enable shell tools */
  enabled: boolean;
  /** Mode: 'allowlist' (only allow specified tools) or 'denylist' (allow all except specified) */
  mode?: 'allowlist' | 'denylist';
  /** Tool names/commands to allow (e.g., ["shell:exec"]) or command patterns (e.g., ["git *", "pnpm build"]) */
  allow?: string[];
  /** Tool names/commands to deny */
  deny?: string[];
  /** @deprecated Use allow/deny with mode instead. Allowed shell commands (e.g., ["git status", "pnpm build"]) */
  allowedCommands?: string[];
}

/**
 * Tools configuration
 */
export interface AgentToolsConfig {
  /** KB Labs plugin tools (mind:*, devkit:*, etc.) */
  kbLabs?: AgentKBLabsToolsConfig;
  /** Filesystem tools (fs:read, fs:write, etc.) */
  filesystem?: AgentFilesystemConfig;
  /** Shell command execution */
  shell?: AgentShellConfig;
}

/**
 * Policy configuration for agent behavior
 */
export interface AgentPolicyConfig {
  /** Allow agent to write files (default: true if filesystem.write is configured) */
  allowWrite?: boolean;
  /** Paths that are always restricted (even if in filesystem.write) */
  restrictedPaths?: string[];
  /** Require confirmation for destructive operations (default: false for MVP) */
  requireConfirmation?: boolean;
}

/**
 * Complete agent configuration (stored in agent.yml)
 */
export interface AgentConfigV1 {
  /** Schema version */
  schema: AgentSchema;
  /** Unique agent ID (matches directory name) */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** Orchestrator metadata (NEW - for agent-aware orchestration) */
  metadata?: {
    /** Brief description for orchestrator (1-2 sentences) */
    description: string;
    /** Optional tags for categorization */
    tags?: string[];
    /** Optional example tasks this agent handles well */
    examples?: string[];
  };
  /** LLM configuration */
  llm: AgentLLMConfig;
  /** Custom prompt configuration */
  prompt?: AgentPromptConfig;
  /** Context configuration */
  context?: AgentContextConfig;
  /** Tools configuration */
  tools: AgentToolsConfig;
  /** Policy configuration */
  policies?: AgentPolicyConfig;
}

/**
 * Agent metadata (returned by discovery)
 */
export interface AgentMetadata {
  /** Agent ID */
  id: string;
  /** Agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** Path to agent directory */
  path: string;
  /** Path to agent.yml config file */
  configPath: string;
  /** Whether agent is valid (config exists and parseable) */
  valid: boolean;
  /** Validation error if not valid */
  error?: string;
}
