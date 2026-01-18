/**
 * Agent Orchestrator Metadata Types
 *
 * These types define metadata used by the orchestrator for dynamic agent selection.
 * Metadata is stored in the `metadata` section of agent.yml files.
 *
 * IMPORTANT: Metadata is flexible and NOT hardcoded. Each agent defines its own
 * specialty, tags, and capabilities. The orchestrator dynamically loads these
 * descriptions without any predefined constraints.
 */

/**
 * Agent metadata for orchestrator discovery (FLEXIBLE SCHEMA)
 *
 * This is a lightweight summary used by the orchestrator during planning.
 * The orchestrator does NOT see the full agent context (context.md).
 *
 * Agents can define ANY specialty/tags/capabilities - no hardcoded enums!
 */
export interface AgentOrchestratorMetadata {
  /**
   * Brief description for the orchestrator (1-2 sentences)
   *
   * This is what the orchestrator sees when deciding which agent to use.
   * Keep it SHORT and FOCUSED on what the agent does.
   *
   * @example "Expert in KB Labs DevKit monorepo management tools. Can check imports, find duplicates, validate structure."
   * @example "Specializes in Mind RAG semantic code search. Finds implementations and explains architecture."
   */
  description: string;

  /**
   * Optional: Free-form tags for categorization
   *
   * @example ['monorepo', 'dependencies', 'validation']
   * @example ['search', 'rag', 'semantic']
   */
  tags?: string[];

  /**
   * Optional: Brief example tasks this agent handles well
   *
   * @example ['Fix broken imports', 'Find duplicate dependencies']
   * @example ['Search for implementation of X', 'Explain how Y works']
   */
  examples?: string[];

  /**
   * Optional: Keywords for automatic agent selection
   *
   * Used by orchestrator to match subtask descriptions to agents.
   * Phrases that indicate this agent should handle the task.
   *
   * @example ['write code', 'create function', 'implement', 'build component']
   * @example ['write test', 'test coverage', 'unit test']
   */
  keywords?: string[];

  /**
   * Optional: List of agent capabilities
   *
   * Brief capability tags shown to orchestrator.
   *
   * @example ['code-generation', 'file-creation', 'typescript']
   * @example ['testing', 'test-writing', 'vitest']
   */
  capabilities?: string[];
}

/**
 * Full agent information (includes metadata + basic config)
 *
 * Used by OrchestratorAgentRegistry for agent discovery.
 */
export interface AgentInfo {
  /** Agent ID (matches directory name) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Brief description */
  description: string;

  /** Orchestrator metadata */
  metadata: AgentOrchestratorMetadata;

  /** LLM tier (small/medium/large) */
  tier: 'small' | 'medium' | 'large';

  /** Path to agent directory */
  path: string;

  /** Path to agent.yml file */
  configPath: string;
}

/**
 * Agent selection reasoning
 *
 * Captured during orchestrator planning phase.
 */
export interface AgentSelectionReasoning {
  /** Subtask ID */
  subtaskId: number;

  /** Selected agent ID */
  agentId: string;

  /** Why this agent was selected */
  reason: string;

  /** Confidence score (0-1) */
  confidence?: number;
}
