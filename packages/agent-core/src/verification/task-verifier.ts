/**
 * Task Verifier - 3-Level Agent Output Validation
 *
 * Main verification component that orchestrates all 3 validation levels:
 * - Level 1: AgentOutput structure validation (Zod)
 * - Level 2: Plugin tool output schema validation
 * - Level 3: Filesystem state validation for built-in tools
 *
 * Part of the anti-hallucination verification system (ADR-0002).
 */

import type { PluginContextV3 } from "@kb-labs/sdk";
import type { AgentOutput, ToolTrace, Claim } from "@kb-labs/agent-contracts";
import {
  validateAgentOutput,
  type AgentOutputValidationResult,
} from "./agent-output-schema.js";
import {
  BuiltInToolVerifier,
  type ClaimVerificationResult,
} from "./built-in-verifier.js";
import { VerificationMetrics } from "./verification-metrics.js";

/**
 * Verification result
 */
export interface VerificationResult {
  /** Whether verification passed */
  valid: boolean;

  /** Verification level reached (1-3) */
  level: 1 | 2 | 3;

  /** Level 1 validation result */
  structureValidation?: AgentOutputValidationResult;

  /** Level 2 validation results (plugin tool outputs) */
  pluginValidation?: {
    valid: boolean;
    errors?: Array<{
      toolName: string;
      message: string;
    }>;
  };

  /** Level 3 validation results (filesystem state) */
  filesystemValidation?: {
    valid: boolean;
    claimResults: ClaimVerificationResult[];
    failedClaims: ClaimVerificationResult[];
  };

  /** Overall validation errors */
  errors?: string[];
}

/**
 * Task Verifier
 *
 * Performs 3-level validation of agent outputs:
 * 1. Structure: Validates AgentOutput shape using Zod
 * 2. Plugin schemas: Validates plugin tool outputs (opt-in)
 * 3. Filesystem: Validates claims against actual filesystem state
 */
export class TaskVerifier {
  private builtInVerifier: BuiltInToolVerifier;
  private metrics: VerificationMetrics;

  constructor(private ctx: PluginContextV3) {
    this.builtInVerifier = new BuiltInToolVerifier(ctx);
    this.metrics = new VerificationMetrics(ctx);
  }

  /**
   * Verify agent output
   *
   * Performs all 3 levels of validation.
   *
   * @param output - Agent output to verify
   * @param trace - Tool trace (optional, for Level 2 validation)
   * @param basePath - Base path for filesystem verification
   * @param agentId - Agent ID (for metrics)
   * @param subtaskId - Subtask ID (for metrics)
   * @returns Verification result
   */
  async verify(
    output: unknown,
    trace?: ToolTrace,
    basePath: string = process.cwd(),
    agentId?: string,
    subtaskId?: string,
  ): Promise<VerificationResult> {
    const errors: string[] = [];

    // ========================================
    // Level 1: Structure Validation (Zod)
    // ========================================
    this.ctx.platform.logger.debug("Starting Level 1 validation (structure)", {
      hasTrace: !!trace,
    });

    const level1Start = Date.now();
    const structureValidation = validateAgentOutput(output);
    const level1Duration = Date.now() - level1Start;

    if (!structureValidation.valid) {
      this.ctx.platform.logger.warn("Level 1 validation failed", {
        errors: structureValidation.errors,
      });

      // Record metrics
      if (agentId) {
        this.metrics.record({
          agentId,
          subtaskId,
          level: 1,
          status: "failed",
          errorCategory: VerificationMetrics.categorizeError(
            structureValidation.errors?.map((e) => e.message) || [],
          ),
          errorDetails: structureValidation.errors
            ?.map((e) => `${e.path}: ${e.message}`)
            .join("; "),
          durationMs: level1Duration,
          timestamp: Date.now(),
        });
      }

      return {
        valid: false,
        level: 1,
        structureValidation,
        errors: [
          "Level 1 (structure) validation failed",
          ...(structureValidation.errors?.map(
            (e) => `${e.path}: ${e.message}`,
          ) || []),
        ],
      };
    }

    // Record success metrics
    if (agentId) {
      this.metrics.record({
        agentId,
        subtaskId,
        level: 1,
        status: "passed",
        durationMs: level1Duration,
        timestamp: Date.now(),
      });
    }

    this.ctx.platform.logger.debug("Level 1 validation passed");

    const validatedOutput = structureValidation.output!;

    // ========================================
    // Level 2: Plugin Tool Output Validation
    // ========================================
    // NOTE: This requires ToolTrace with plugin tool outputs
    // For now, we skip this level if trace is not provided
    // In production, this would validate plugin outputs against their schemas
    if (trace) {
      this.ctx.platform.logger.debug(
        "Starting Level 2 validation (plugin schemas)",
        {
          invocations: trace.invocations.length,
        },
      );

      // TODO: Implement plugin output validation using ZodSchemaValidator
      // For now, we assume plugin outputs are valid (opt-in validation)
      this.ctx.platform.logger.debug(
        "Level 2 validation skipped (not implemented yet)",
      );
    }

    // ========================================
    // Level 3: Filesystem State Validation
    // ========================================
    this.ctx.platform.logger.debug("Starting Level 3 validation (filesystem)", {
      hasClaims: !!validatedOutput.claims,
      claimsCount: validatedOutput.claims?.length || 0,
    });

    if (!validatedOutput.claims || validatedOutput.claims.length === 0) {
      // No claims to verify - valid by default
      this.ctx.platform.logger.debug("No claims to verify, Level 3 skipped");

      return {
        valid: true,
        level: 3,
        structureValidation,
      };
    }

    // Verify claims against filesystem
    const level3Start = Date.now();
    const claimResults = await this.builtInVerifier.verifyClaims(
      validatedOutput.claims,
      basePath,
    );
    const level3Duration = Date.now() - level3Start;

    const failedClaims = claimResults.filter((r) => !r.valid);

    if (failedClaims.length > 0) {
      this.ctx.platform.logger.warn("Level 3 validation failed", {
        total: claimResults.length,
        failed: failedClaims.length,
        failures: failedClaims.map((f) => ({
          kind: f.claim.kind,
          reason: f.reason,
        })),
      });

      // Record metrics
      if (agentId) {
        this.metrics.record({
          agentId,
          subtaskId,
          level: 3,
          status: "failed",
          errorCategory: VerificationMetrics.categorizeError(
            failedClaims.map((f) => f.reason || "unknown"),
          ),
          errorDetails: failedClaims
            .map((f) => `${f.claim.kind}: ${f.reason}`)
            .join("; "),
          durationMs: level3Duration,
          timestamp: Date.now(),
        });
      }

      return {
        valid: false,
        level: 3,
        structureValidation,
        filesystemValidation: {
          valid: false,
          claimResults,
          failedClaims,
        },
        errors: [
          "Level 3 (filesystem) validation failed",
          ...failedClaims.map((f) => `${f.claim.kind}: ${f.reason}`),
        ],
      };
    }

    // Record success metrics
    if (agentId) {
      this.metrics.record({
        agentId,
        subtaskId,
        level: 3,
        status: "passed",
        durationMs: level3Duration,
        timestamp: Date.now(),
      });
    }

    this.ctx.platform.logger.debug("Level 3 validation passed", {
      verifiedClaims: claimResults.length,
    });

    // ========================================
    // All levels passed
    // ========================================
    return {
      valid: true,
      level: 3,
      structureValidation,
      filesystemValidation: {
        valid: true,
        claimResults,
        failedClaims: [],
      },
    };
  }

  /**
   * Verify specific claims (Level 3 only)
   *
   * Useful for verifying claims without full AgentOutput structure.
   *
   * @param claims - Claims to verify
   * @param basePath - Base path for filesystem verification
   * @returns Claim verification results
   */
  async verifyClaims(
    claims: Claim[],
    basePath: string = process.cwd(),
  ): Promise<ClaimVerificationResult[]> {
    return this.builtInVerifier.verifyClaims(claims, basePath);
  }

  /**
   * Get verification metrics
   *
   * Returns aggregated verification statistics for A/B testing and analysis.
   *
   * @returns Verification metrics aggregates
   */
  getMetrics() {
    return this.metrics.getAggregates();
  }

  /**
   * Clear verification metrics
   *
   * Useful for starting fresh metrics collection.
   */
  clearMetrics(): void {
    this.metrics.clear();
  }
}
