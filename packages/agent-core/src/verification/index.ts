/**
 * Verification System - Anti-Hallucination Verification
 *
 * 3-level validation system for agent outputs:
 * - Level 1: AgentOutput structure validation (Zod)
 * - Level 2: Plugin tool output schema validation
 * - Level 3: Filesystem state validation for built-in tools
 *
 * Part of ADR-0002: Agent Output Verification System
 */

// Level 1: Structure validation
export {
  validateAgentOutput,
  type AgentOutputValidationResult,
  AgentOutputSchema,
  ClaimSchema,
  CompactArtifactSchema,
  EvidenceRefSchema,
  FileWriteClaimSchema,
  FileEditClaimSchema,
  FileDeleteClaimSchema,
  CommandExecutedClaimSchema,
  CodeInsertedClaimSchema,
  type AgentOutputValidated,
} from './agent-output-schema.js';

// Level 2: Plugin schema validation
export {
  PluginSchemaLoader,
  getSchemaLoader,
  type SchemaRef,
} from './plugin-schema-loader.js';

// Level 3: Filesystem validation
export {
  BuiltInToolVerifier,
  type ClaimVerificationResult,
} from './built-in-verifier.js';

// Main verifier (orchestrates all 3 levels)
export {
  TaskVerifier,
  type VerificationResult,
} from './task-verifier.js';

// Metrics (for A/B testing and analysis)
export {
  VerificationMetrics,
  type VerificationMetricsEvent,
  type VerificationMetricsAggregates,
  type VerificationLevel,
  type VerificationStatus,
  type VerificationErrorCategory,
} from './verification-metrics.js';
