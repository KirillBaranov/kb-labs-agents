// ============================================
// KB Labs Agents - Type Contracts
// ============================================

// Agent Configuration Types
export type {
  AgentSchema,
  AgentLLMConfig,
  AgentPromptConfig,
  AgentContextFile,
  AgentContextConfig,
  AgentKBLabsToolsConfig,
  AgentFilesystemPermissions,
  AgentFilesystemConfig,
  AgentShellConfig,
  AgentToolsConfig,
  AgentPolicyConfig,
  AgentConfigV1,
  AgentMetadata,
} from './agent-config.js';

// Specialist Configuration Types (V2)
export type {
  SpecialistSchema,
  SpecialistLimits,
  SpecialistStaticContext,
  SpecialistDynamicContext,
  SpecialistContextConfig,
  SpecialistInputSchema,
  SpecialistOutputSchema,
  SpecialistCapability,
  SpecialistConfigV1,
  SpecialistMetadata,
} from './specialist-config.js';

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
  SpecialistOutput,
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

// Specialist Outcome (V2 - Phase 3)
export type { LLMTier, RunMeta, FailureReport, SpecialistOutcome } from './outcome.js';

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
  AgentPromptConfigSchema,
  AgentContextFileSchema,
  AgentContextConfigSchema,
  AgentKBLabsToolsConfigSchema,
  AgentFilesystemPermissionsSchema,
  AgentFilesystemConfigSchema,
  AgentShellConfigSchema,
  AgentToolsConfigSchema,
  AgentPolicyConfigSchema,
  AgentConfigV1Schema,
  ToolInputSchemaSchema,
  ToolDefinitionSchema,
  ToolCallSchema,
  ToolErrorSchema,
  ToolResultSchema,
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

// Specialist Zod Schemas and Validators (V2)
export {
  SpecialistSchemaSchema,
  SpecialistLimitsSchema,
  SpecialistStaticContextSchema,
  SpecialistDynamicContextSchema,
  SpecialistContextConfigSchema,
  SpecialistInputSchemaSchema,
  SpecialistOutputSchemaSchema,
  SpecialistCapabilitySchema,
  SpecialistMetadataInlineSchema,
  SpecialistConfigV1Schema,
  parseSpecialistConfig,
  validateSpecialistConfig,
} from './specialist-schemas.js';

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
