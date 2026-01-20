/**
 * Agent Configuration Types (V2 Architecture)
 *
 * Specialists are enhanced agents with:
 * - Deep domain context (static + dynamic via Mind RAG)
 * - Configurable forced reasoning intervals
 * - Structured I/O schemas
 * - Session-aware execution
 *
 * Based on kb.agent/1 but extends it for V2 orchestration.
 */

import type { ToolStrategyConfig } from './tool-strategy.js';
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
   */
  tier: LLMTier;
  /** Escalation ladder for automatic tier upgrade on failures */
  escalationLadder?: LLMTier[];
  /** Temperature (0-1). Lower = more deterministic, higher = more creative */
  temperature: number;
  /** Maximum tokens for LLM response */
  maxTokens: number;
}

/**
 * Policy configuration for agent
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
 * Execution limits for agent
 */
export interface AgentLimits {
  /** Maximum execution steps before timeout */
  maxSteps: number;
  /** Maximum tool calls per agent run */
  maxToolCalls: number;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /**
   * Force reasoning step after N tool calls
   * Default: 3
   *
   * Prevents tool spamming by requiring reflection after every N tools.
   * Higher values = more tool calls before reasoning (faster but riskier).
   *
   * @example 3 - Researcher (balanced)
   * @example 5 - Implementer (more autonomy for writing code)
   */
  forcedReasoningInterval?: number;
}

/**
 * Static context configuration
 */
export interface AgentStaticContext {
  /**
   * Inline system prompt (agent expertise, guidelines, best practices)
   */
  system?: string;

  /**
   * Path to context file relative to agent directory
   * @example "./context.md"
   */
  contextFile?: string;
}

/**
 * Dynamic context via Mind RAG
 */
export interface AgentDynamicContext {
  /** Enable dynamic context enrichment via Mind RAG */
  enabled: boolean;
  /** Scope for RAG queries (e.g., "architecture", "tests") */
  scope?: string;
  /** Maximum chunks to retrieve per query */
  maxChunks?: number;
}

/**
 * Agent context configuration
 */
export interface AgentContextConfig {
  /** Static context (always included) */
  static?: AgentStaticContext;
  /** Dynamic context (loaded via Mind RAG when needed) */
  dynamic?: AgentDynamicContext;
}

/**
 * Input schema for agent
 *
 * Defines what the agent expects to receive from orchestrator
 */
export interface AgentInputSchema {
  /**
   * Schema definition (JSON Schema format)
   * Can be any valid JSON Schema structure
   */
  schema?: unknown;
}

/**
 * Output schema for agent
 *
 * Defines what the agent will return to orchestrator
 */
export interface AgentOutputSchema {
  /**
   * Schema definition (JSON Schema format)
   * Can be any valid JSON Schema structure
   */
  schema?: unknown;
}

/**
 * Agent capabilities (for orchestrator)
 */
export type AgentCapability =
  | 'code-search'
  | 'code-reading'
  | 'code-writing'
  | 'code-editing'
  | 'architecture-analysis'
  | 'dependency-analysis'
  | 'command-execution'
  | 'testing'
  | 'documentation';

/**
 * Complete agent configuration (stored in agent.yml)
 */
export interface AgentConfigV1 {
  /** Schema version */
  schema: AgentSchema;

  /** Unique agent ID (matches directory name) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Brief description for orchestrator (1-2 sentences) */
  description: string;

  /**
   * Metadata for orchestrator
   * Lightweight information for routing decisions
   */
  metadata?: {
    /** Detailed description (shown to orchestrator) */
    description?: string;
    /** Tags for categorization */
    tags?: string[];
    /** Example tasks this agent handles */
    examples?: string[];
  };

  /** LLM configuration (tier, temperature, maxTokens) */
  llm: AgentLLMConfig;

  /** Execution limits */
  limits: AgentLimits;

  /** Capabilities (for orchestrator matching) */
  capabilities?: AgentCapability[];

  /** Context configuration (static + dynamic) */
  context?: AgentContextConfig;

  /** Tool strategy configuration */
  tools: ToolStrategyConfig;

  /** Constraints (what agent CANNOT do) */
  constraints?: string[];

  /** Structured I/O */
  input?: AgentInputSchema;
  output?: AgentOutputSchema;

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
  /** Brief description */
  description: string;
  /** Capabilities */
  capabilities: AgentCapability[];
  /** LLM tier */
  tier: LLMTier;
  /** Path to agent directory */
  path: string;
  /** Path to agent.yml config file */
  configPath: string;
  /** Whether agent is valid */
  valid: boolean;
  /** Validation error if not valid */
  error?: string;
}
