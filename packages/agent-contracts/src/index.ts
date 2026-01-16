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
