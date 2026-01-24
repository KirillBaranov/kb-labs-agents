/**
 * Built-In Tool Verifier - Filesystem State Validation
 *
 * Level 3 validation: Verifies filesystem state for built-in tools (fs:*, shell:*, code:*)
 * by checking actual files against claims made by agents.
 *
 * Part of the anti-hallucination verification system (ADR-0002).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { PluginContextV3 } from "@kb-labs/sdk";
import type {
  Claim,
  FileWriteClaim,
  FileEditClaim,
  FileDeleteClaim,
} from "@kb-labs/agent-contracts";

/**
 * Verification result for a single claim
 */
export interface ClaimVerificationResult {
  /** Whether the claim is valid */
  valid: boolean;

  /** Claim that was verified */
  claim: Claim;

  /** Reason for failure (if !valid) */
  reason?: string;

  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Built-in tool verifier
 *
 * Verifies claims about filesystem operations by checking actual filesystem state.
 */
export class BuiltInToolVerifier {
  constructor(private ctx: PluginContextV3) {}

  /**
   * Verify a single claim
   *
   * @param claim - Claim to verify
   * @param basePath - Base directory for relative paths
   * @returns Verification result
   */
  async verifyClaim(
    claim: Claim,
    basePath: string = process.cwd(),
  ): Promise<ClaimVerificationResult> {
    try {
      switch (claim.kind) {
        case "file-write":
          return await this.verifyFileWrite(claim, basePath);

        case "file-edit":
          return await this.verifyFileEdit(claim, basePath);

        case "file-delete":
          return await this.verifyFileDelete(claim, basePath);

        case "command-executed":
          // Command verification requires checking shell history or logs
          // For now, we trust command-executed claims (no way to verify retroactively)
          this.ctx.platform.logger.debug(
            "Skipping verification for command-executed claim",
            { claim },
          );
          return { valid: true, claim };

        case "code-inserted":
          // Code insertion is verified similarly to file-edit
          return await this.verifyCodeInserted(claim, basePath);

        default:
          this.ctx.platform.logger.warn("Unknown claim kind", {
            kind: (claim as any).kind,
          });
          return {
            valid: false,
            claim,
            reason: "Unknown claim kind",
          };
      }
    } catch (error) {
      this.ctx.platform.logger.warn("Claim verification failed with error", {
        claim,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        claim,
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Verify multiple claims
   *
   * @param claims - Claims to verify
   * @param basePath - Base directory for relative paths
   * @returns Array of verification results
   */
  async verifyClaims(
    claims: Claim[],
    basePath: string = process.cwd(),
  ): Promise<ClaimVerificationResult[]> {
    const results = await Promise.all(
      claims.map((claim) => this.verifyClaim(claim, basePath)),
    );
    return results;
  }

  /**
   * Verify file-write claim
   *
   * Checks that file exists and content hash matches.
   */
  private async verifyFileWrite(
    claim: FileWriteClaim,
    basePath: string,
  ): Promise<ClaimVerificationResult> {
    const filePath = path.resolve(basePath, claim.filePath);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        valid: false,
        claim,
        reason: "File does not exist",
        details: { filePath },
      };
    }

    // Read file content
    const content = await fs.readFile(filePath, "utf-8");

    // Compute hash
    const actualHash = this.computeHash(content);

    // Compare hashes
    if (actualHash !== claim.contentHash) {
      return {
        valid: false,
        claim,
        reason: "Content hash mismatch",
        details: {
          expected: claim.contentHash,
          actual: actualHash,
        },
      };
    }

    return { valid: true, claim };
  }

  /**
   * Verify file-edit claim
   *
   * Checks that file exists and anchors match.
   */
  private async verifyFileEdit(
    claim: FileEditClaim,
    basePath: string,
  ): Promise<ClaimVerificationResult> {
    const filePath = path.resolve(basePath, claim.filePath);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        valid: false,
        claim,
        reason: "File does not exist",
        details: { filePath },
      };
    }

    // Read file content
    const content = await fs.readFile(filePath, "utf-8");

    // Check if anchors are present
    const hasBeforeAnchor = content.includes(claim.anchor.beforeSnippet);
    const hasAfterAnchor = content.includes(claim.anchor.afterSnippet);

    if (!hasBeforeAnchor && !hasAfterAnchor) {
      return {
        valid: false,
        claim,
        reason:
          "Neither anchor found in file (file may have been edited again)",
        details: {
          beforeAnchor: claim.anchor.beforeSnippet.substring(0, 50) + "...",
          afterAnchor: claim.anchor.afterSnippet.substring(0, 50) + "...",
        },
      };
    }

    if (!hasBeforeAnchor) {
      this.ctx.platform.logger.debug(
        "Before anchor not found, but after anchor present",
        {
          filePath: claim.filePath,
        },
      );
    }

    if (!hasAfterAnchor) {
      this.ctx.platform.logger.debug(
        "After anchor not found, but before anchor present",
        {
          filePath: claim.filePath,
        },
      );
    }

    // If at least one anchor is found, consider it valid
    // (File might have been edited multiple times, shifting anchors)
    return { valid: true, claim };
  }

  /**
   * Verify file-delete claim
   *
   * Checks that file does NOT exist.
   */
  private async verifyFileDelete(
    claim: FileDeleteClaim,
    basePath: string,
  ): Promise<ClaimVerificationResult> {
    const filePath = path.resolve(basePath, claim.filePath);

    // Check file does NOT exist
    try {
      await fs.access(filePath);
      // File exists - claim is invalid
      return {
        valid: false,
        claim,
        reason: "File still exists",
        details: { filePath },
      };
    } catch {
      // File does not exist - claim is valid
      return { valid: true, claim };
    }
  }

  /**
   * Verify code-inserted claim
   *
   * Similar to file-edit verification.
   */
  private async verifyCodeInserted(
    claim: Extract<Claim, { kind: "code-inserted" }>,
    basePath: string,
  ): Promise<ClaimVerificationResult> {
    const filePath = path.resolve(basePath, claim.filePath);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        valid: false,
        claim,
        reason: "File does not exist",
        details: { filePath },
      };
    }

    // Read file content
    const content = await fs.readFile(filePath, "utf-8");

    // Check if anchors are present
    const hasBeforeAnchor = content.includes(claim.anchor.beforeSnippet);
    const hasAfterAnchor = content.includes(claim.anchor.afterSnippet);

    if (!hasBeforeAnchor && !hasAfterAnchor) {
      return {
        valid: false,
        claim,
        reason: "Neither anchor found in file",
        details: {
          beforeAnchor: claim.anchor.beforeSnippet.substring(0, 50) + "...",
          afterAnchor: claim.anchor.afterSnippet.substring(0, 50) + "...",
        },
      };
    }

    return { valid: true, claim };
  }

  /**
   * Compute SHA-256 hash of content
   */
  private computeHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }
}
