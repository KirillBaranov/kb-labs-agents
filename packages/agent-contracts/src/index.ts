// ============================================
// KB Labs Agents - Type Contracts
// ============================================

// Agent Configuration Types
export type {
  AgentSchema,
  AgentConfigV1,
  AgentMetadata,
  AgentLimits,
  AgentStaticContext,
  AgentDynamicContext,
  AgentContextConfig,
  AgentInputSchema,
  AgentOutputSchema,
  AgentCapability,
} from './agent-config.js';

// Agent Orchestrator Metadata Types
export type {
  AgentOrchestratorMetadata,
  AgentInfo,
  AgentSelectionReasoning,
} from './agent-orchestrator-metadata.js';

// Tool Types
export type {
  ToolInputSchema,
  ToolDefinition,
  ToolCall,
  ToolError,
  ToolResult,
  ToolCategory,
  ToolMetadata,
} from './tool-types.js';

// Tool Trace Types
export type {
  EvidenceRef,
  ToolInvocation,
  ToolTrace,
  AgentOutput,
  Claim,
  FileWriteClaim,
  FileEditClaim,
  FileDeleteClaim,
  CommandExecutedClaim,
  CodeInsertedClaim,
  CompactArtifact,
} from './trace-types.js';

// Tool Strategy Types
export type {
  ToolStrategyMode,
  BuiltInToolCategory,
  ToolHint,
  ToolGroup,
  FsPermissions,
  ShellPermissions,
  KBLabsPermissions,
  ToolPermissions,
  ToolStrategyConfig,
  ToolExecutionState,
  ToolAvailability,
} from './tool-strategy.js';

// Agent Execution Types
export type {
  AgentContext,
  AgentExecutionStep,
  AgentResult,
  AgentRuntimeState,
  AgentTemplate,
  AgentTemplateMetadata,
  LoopDetectionState,
  LoopDetectionResult,
  AgentProgressCallback,
} from './agent-execution.js';

// Execution Context (V2)
export type { ExecutionContext } from './context.js';

// Agent Outcome (V2 - Phase 3)
export type { LLMTier, RunMeta, FailureReport, AgentOutcome } from './outcome.js';

// Orchestrator Callbacks (V2 - Phase 5)
export type {
  OrchestratorCallbacks,
  SubTask,
  ExecutionPlan,
  ExecutionStats,
  Progress,
  DelegatedResult,
} from './callbacks.js';

// Zod Schemas and Validators
export {
  AgentSchemaSchema,
  AgentLLMConfigSchema,
  AgentPolicyConfigSchema,
  AgentLimitsSchema,
  AgentStaticContextSchema,
  AgentDynamicContextSchema,
  AgentContextConfigSchema,
  AgentInputSchemaSchema,
  AgentOutputSchemaSchema,
  AgentCapabilitySchema,
  AgentMetadataInlineSchema,
  AgentConfigV1Schema,
  parseAgentConfig,
  validateAgentConfig,
} from './agent-schemas.js';

// Tool Strategy Zod Schemas
export {
  ToolStrategyModeSchema,
  ToolGroupSchema,
  FsPermissionsSchema,
  ShellPermissionsSchema,
  KBLabsPermissionsSchema,
  ToolPermissionsSchema,
  BuiltInToolsConfigSchema,
  ToolStrategyConfigSchema,
  validateToolStrategyConfig,
} from './tool-strategy-schemas.js';


// REST API Schemas and Types
export type {
  RunAgentRequest,
  RunAgentResponse,
  RunAgentErrorResponse,
  AgentResponse,
  ToolCallInfo,
  ExecutionStep,
  AgentStats,
  ListAgentsRequest,
  ListAgentsResponse,
  AgentMetadata as AgentMetadataREST,
} from './rest-schemas.js';

export {
  RunAgentRequestSchema,
  RunAgentResponseSchema,
  RunAgentErrorResponseSchema,
  AgentResponseSchema,
  ToolCallInfoSchema,
  ExecutionStepSchema,
  AgentStatsSchema,
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
  AgentMetadataSchema,
} from './rest-schemas.js';

// REST API Routes
export { AGENTS_BASE_PATH, AGENTS_ROUTES } from './routes.js';

// ============================================
// Legacy Plugin Template Exports (kept for compatibility)
// ============================================
export {
  pluginContractsManifest,
  type PluginArtifactIds,
  type PluginCommandIds,
  type PluginWorkflowIds,
  type PluginRouteIds,
} from './contract.js';
export {
  getArtifactPath,
  getArtifact,
  hasArtifact,
  getCommand,
  hasCommand,
  getCommandId,
  getArtifactId,
  getRoute,
  hasRoute,
  getRouteId,
} from './helpers.js';
export { parsePluginContracts, pluginContractsSchema } from './schema/contract.schema.js';
export { contractsSchemaId, contractsVersion } from './version.js';
export * from './types.js';
export * from './schema.js';
