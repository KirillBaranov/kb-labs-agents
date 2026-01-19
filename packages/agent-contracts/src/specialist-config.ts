/**
 * Specialist Configuration Types (V2 Architecture)
 *
 * Specialists are enhanced agents with:
 * - Deep domain context (static + dynamic via Mind RAG)
 * - Configurable forced reasoning intervals
 * - Structured I/O schemas
 * - Session-aware execution
 *
 * Based on kb.agent/1 but extends it for V2 orchestration.
 */

import type { AgentLLMConfig, AgentPolicyConfig } from './agent-config.js';
import type { ToolStrategyConfig } from './tool-strategy.js';

/**
 * Specialist configuration schema version
 */
export type SpecialistSchema = 'kb.specialist/1';

/**
 * Execution limits for specialist
 */
export interface SpecialistLimits {
  /** Maximum execution steps before timeout */
  maxSteps: number;
  /** Maximum tool calls per specialist run */
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
export interface SpecialistStaticContext {
  /**
   * Inline system prompt (specialist expertise, guidelines, best practices)
   */
  system?: string;

  /**
   * Path to context file relative to specialist directory
   * @example "./context.md"
   */
  contextFile?: string;
}

/**
 * Dynamic context via Mind RAG
 */
export interface SpecialistDynamicContext {
  /** Enable dynamic context enrichment via Mind RAG */
  enabled: boolean;
  /** Scope for RAG queries (e.g., "architecture", "tests") */
  scope?: string;
  /** Maximum chunks to retrieve per query */
  maxChunks?: number;
}

/**
 * Specialist context configuration
 */
export interface SpecialistContextConfig {
  /** Static context (always included) */
  static?: SpecialistStaticContext;
  /** Dynamic context (loaded via Mind RAG when needed) */
  dynamic?: SpecialistDynamicContext;
}

/**
 * Input schema for specialist
 *
 * Defines what the specialist expects to receive from orchestrator
 */
export interface SpecialistInputSchema {
  /**
   * Schema definition (JSON Schema format)
   * Can be any valid JSON Schema structure
   */
  schema?: unknown;
}

/**
 * Output schema for specialist
 *
 * Defines what the specialist will return to orchestrator
 */
export interface SpecialistOutputSchema {
  /**
   * Schema definition (JSON Schema format)
   * Can be any valid JSON Schema structure
   */
  schema?: unknown;
}

/**
 * Specialist capabilities (for orchestrator)
 */
export type SpecialistCapability =
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
 * Complete specialist configuration (stored in specialist.yml)
 */
export interface SpecialistConfigV1 {
  /** Schema version */
  schema: SpecialistSchema;

  /** Unique specialist ID (matches directory name) */
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
    /** Example tasks this specialist handles */
    examples?: string[];
  };

  /** LLM configuration (tier, temperature, maxTokens) */
  llm: AgentLLMConfig;

  /** Execution limits */
  limits: SpecialistLimits;

  /** Capabilities (for orchestrator matching) */
  capabilities?: SpecialistCapability[];

  /** Context configuration (static + dynamic) */
  context?: SpecialistContextConfig;

  /** Tool strategy configuration */
  tools: ToolStrategyConfig;

  /** Constraints (what specialist CANNOT do) */
  constraints?: string[];

  /** Structured I/O */
  input?: SpecialistInputSchema;
  output?: SpecialistOutputSchema;

  /** Policy configuration */
  policies?: AgentPolicyConfig;
}

/**
 * Specialist metadata (returned by discovery)
 */
export interface SpecialistMetadata {
  /** Specialist ID */
  id: string;
  /** Specialist name */
  name: string;
  /** Brief description */
  description: string;
  /** Capabilities */
  capabilities: SpecialistCapability[];
  /** LLM tier */
  tier: 'small' | 'medium' | 'large';
  /** Path to specialist directory */
  path: string;
  /** Path to specialist.yml config file */
  configPath: string;
  /** Whether specialist is valid */
  valid: boolean;
  /** Validation error if not valid */
  error?: string;
}
