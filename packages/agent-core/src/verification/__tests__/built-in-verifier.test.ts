/**
 * Unit tests for BuiltInToolVerifier (Level 3)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BuiltInToolVerifier } from "../built-in-verifier.js";
import type { PluginContextV3 } from "@kb-labs/sdk";
import type {
  FileWriteClaim,
  FileEditClaim,
  FileDeleteClaim,
} from "@kb-labs/agent-contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// Mock PluginContextV3
const createMockContext = (): PluginContextV3 =>
  ({
    platform: {
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
  }) as unknown as PluginContextV3;

describe("BuiltInToolVerifier", () => {
  let verifier: BuiltInToolVerifier;
  let ctx: PluginContextV3;
  let testDir: string;

  beforeEach(async () => {
    ctx = createMockContext();
    verifier = new BuiltInToolVerifier(ctx);

    // Create temporary test directory
    testDir = path.join(tmpdir(), `verifier-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("verifyFileWrite()", () => {
    it("should verify valid file-write claim", async () => {
      const filePath = path.join(testDir, "test.txt");
      const content = "Hello, world!";
      const contentHash = createHash("sha256")
        .update(content, "utf-8")
        .digest("hex");

      // Create the file
      await fs.writeFile(filePath, content, "utf-8");

      const claim: FileWriteClaim = {
        kind: "file-write",
        filePath: "test.txt",
        contentHash,
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(true);
      expect(result.claim).toBe(claim);
    });

    it("should fail when file does not exist", async () => {
      const claim: FileWriteClaim = {
        kind: "file-write",
        filePath: "nonexistent.txt",
        contentHash: "abc123",
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("does not exist");
    });

    it("should fail when content hash mismatches", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.writeFile(filePath, "Hello, world!", "utf-8");

      const claim: FileWriteClaim = {
        kind: "file-write",
        filePath: "test.txt",
        contentHash: "wrong-hash",
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("hash mismatch");
    });
  });

  describe("verifyFileEdit()", () => {
    it("should verify valid file-edit claim with both anchors", async () => {
      const filePath = path.join(testDir, "code.ts");
      const content = `function foo() {\n  console.log('hello');\n}\n`;

      await fs.writeFile(filePath, content, "utf-8");

      const claim: FileEditClaim = {
        kind: "file-edit",
        filePath: "code.ts",
        anchor: {
          beforeSnippet: "function foo() {",
          afterSnippet: "console.log('hello');",
          contentHash: createHash("sha256")
            .update(content, "utf-8")
            .digest("hex"),
        },
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(true);
    });

    it("should verify with only before anchor", async () => {
      const filePath = path.join(testDir, "code.ts");
      const content = `function foo() {\n  console.log('hello');\n}\n`;

      await fs.writeFile(filePath, content, "utf-8");

      const claim: FileEditClaim = {
        kind: "file-edit",
        filePath: "code.ts",
        anchor: {
          beforeSnippet: "function foo() {",
          afterSnippet: "some other line that does not exist",
          contentHash: createHash("sha256")
            .update(content, "utf-8")
            .digest("hex"),
        },
      };

      const result = await verifier.verifyClaim(claim, testDir);

      // Should still be valid (at least one anchor found)
      expect(result.valid).toBe(true);
    });

    it("should fail when no anchors found", async () => {
      const filePath = path.join(testDir, "code.ts");
      const content = "completely different content";
      await fs.writeFile(filePath, content, "utf-8");

      const claim: FileEditClaim = {
        kind: "file-edit",
        filePath: "code.ts",
        anchor: {
          beforeSnippet: "function foo() {",
          afterSnippet: "console.log('hello');",
          contentHash: createHash("sha256")
            .update("original content", "utf-8")
            .digest("hex"),
        },
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Neither anchor found");
    });

    it("should fail when file does not exist", async () => {
      const claim: FileEditClaim = {
        kind: "file-edit",
        filePath: "nonexistent.ts",
        anchor: {
          beforeSnippet: "test",
          afterSnippet: "test",
          contentHash: "abc123",
        },
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("does not exist");
    });
  });

  describe("verifyFileDelete()", () => {
    it("should verify file was deleted", async () => {
      const claim: FileDeleteClaim = {
        kind: "file-delete",
        filePath: "deleted.txt",
      };

      const result = await verifier.verifyClaim(claim, testDir);

      // File should not exist
      expect(result.valid).toBe(true);
    });

    it("should fail when file still exists", async () => {
      const filePath = path.join(testDir, "not-deleted.txt");
      await fs.writeFile(filePath, "still here", "utf-8");

      const claim: FileDeleteClaim = {
        kind: "file-delete",
        filePath: "not-deleted.txt",
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("still exists");
    });
  });

  describe("verifyCodeInserted()", () => {
    it("should verify code insertion with anchor", async () => {
      const filePath = path.join(testDir, "code.ts");
      const content = `function foo() {\n  const x = 1;\n  return x;\n}\n`;

      await fs.writeFile(filePath, content, "utf-8");

      const claim = {
        kind: "code-inserted" as const,
        filePath: "code.ts",
        anchor: {
          beforeSnippet: "function foo() {",
          afterSnippet: "const x = 1;",
          contentHash: createHash("sha256")
            .update(content, "utf-8")
            .digest("hex"),
        },
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(true);
    });
  });

  describe("verifyClaims()", () => {
    it("should verify multiple claims", async () => {
      // Setup test files
      const file1Path = path.join(testDir, "file1.txt");
      const file1Content = "Content 1";
      await fs.writeFile(file1Path, file1Content, "utf-8");

      const file2Path = path.join(testDir, "file2.txt");
      const file2Content = "Content 2";
      await fs.writeFile(file2Path, file2Content, "utf-8");

      const claims = [
        {
          kind: "file-write" as const,
          filePath: "file1.txt",
          contentHash: createHash("sha256")
            .update(file1Content, "utf-8")
            .digest("hex"),
        },
        {
          kind: "file-write" as const,
          filePath: "file2.txt",
          contentHash: createHash("sha256")
            .update(file2Content, "utf-8")
            .digest("hex"),
        },
      ];

      const results = await verifier.verifyClaims(claims, testDir);

      expect(results).toHaveLength(2);
      expect(results[0].valid).toBe(true);
      expect(results[1].valid).toBe(true);
    });

    it("should handle mixed success and failure", async () => {
      const filePath = path.join(testDir, "exists.txt");
      await fs.writeFile(filePath, "test", "utf-8");

      const claims = [
        {
          kind: "file-write" as const,
          filePath: "exists.txt",
          contentHash: createHash("sha256")
            .update("test", "utf-8")
            .digest("hex"),
        },
        {
          kind: "file-write" as const,
          filePath: "nonexistent.txt",
          contentHash: "abc123",
        },
      ];

      const results = await verifier.verifyClaims(claims, testDir);

      expect(results).toHaveLength(2);
      expect(results[0].valid).toBe(true);
      expect(results[1].valid).toBe(false);
    });
  });

  describe("command-executed claims", () => {
    it("should trust command-executed claims (no verification)", async () => {
      const claim = {
        kind: "command-executed" as const,
        command: "npm install",
        exitCode: 0,
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(true);
    });
  });

  describe("unknown claim kinds", () => {
    it("should fail for unknown claim kind", async () => {
      const claim = {
        kind: "unknown-kind" as any,
      };

      const result = await verifier.verifyClaim(claim, testDir);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Unknown claim kind");
    });
  });
});
