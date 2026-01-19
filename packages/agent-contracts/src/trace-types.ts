/**
 * Tool Trace Types
 *
 * Runtime truth system for verification and anti-hallucination.
 * Records every tool invocation during specialist execution.
 */

/**
 * Evidence reference for verification
 *
 * Provides proof that a tool was executed and what it produced
 */
export interface EvidenceRef {
  /** Evidence type */
  kind: 'file' | 'http' | 'receipt' | 'log' | 'hash';

  /** Reference to evidence (file path, URL, ID) */
  ref: string;

  /** SHA-256 hash for integrity checks */
  sha256?: string;

  /** Additional metadata */
  meta?: unknown;
}

/**
 * Tool invocation record
 *
 * Complete record of a single tool execution during specialist run
 */
export interface ToolInvocation {
  /** Unique invocation ID */
  invocationId: string;

  /** Tool name (e.g., "fs:read", "mind:rag-query") */
  tool: string;

  /** SHA-256 hash of args (for deduplication) */
  argsHash: string;

  /** Tool arguments (actual data) */
  args?: unknown;

  /** Invocation timestamp */
  timestamp: Date;

  /**
   * Purpose of invocation
   *
   * - execution: Normal tool call by specialist
   * - verification: Probe/check by verifier (prevents recursion)
   */
  purpose: 'execution' | 'verification';

  /**
   * Execution status
   *
   * - success: Tool executed successfully
   * - failed: Tool execution failed
   * - timeout: Tool execution timed out
   * - error: Unexpected error during execution
   */
  status: 'success' | 'failed' | 'timeout' | 'error';

  /** Evidence references for verification */
  evidenceRefs: EvidenceRef[];

  /**
   * Raw tool output
   *
   * For plugin tools, this is schema-validated before storage
   */
  output?: unknown;

  /**
   * Execution digest for fast verification
   *
   * Summarizes key events and metrics without parsing full output
   */
  digest?: {
    /** Key events that occurred (e.g., ["file_created", "cache_updated"]) */
    keyEvents?: string[];

    /** Counters for quantifiable operations */
    counters?: Record<string, number>;
  };

  /** Error details (if status !== 'success') */
  error?: {
    /** Error code */
    code: string;

    /** Error message */
    message: string;

    /** Stack trace (if available) */
    stack?: string;
  };

  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Complete tool trace for a specialist execution
 *
 * Source of truth for verification - records everything that actually happened
 */
export interface ToolTrace {
  /** Unique trace ID */
  traceId: string;

  /** Session ID (links to orchestrator session) */
  sessionId: string;

  /** Specialist ID that generated this trace */
  specialistId: string;

  /** All tool invocations in order */
  invocations: ToolInvocation[];

  /** Trace creation timestamp */
  createdAt: Date;

  /** Trace completion timestamp (when specialist finished) */
  completedAt?: Date;
}

/**
 * Specialist output (includes trace reference)
 *
 * Extended from base AgentResult to include verification data
 */
export interface SpecialistOutput {
  /** Summary of what was accomplished */
  summary: string;

  /**
   * Trace reference (REQUIRED)
   *
   * Points to ToolTrace for verification.
   * Format: "trace:<traceId>"
   */
  traceRef: string;

  /**
   * Optional claims made by specialist
   *
   * Specialist can explicitly claim what it did (e.g., "I created file X").
   * Verifier checks claims against ToolTrace.
   */
  claims?: Claim[];

  /**
   * Compact artifacts
   *
   * Small, verifiable outputs (code snippets, summaries).
   * Used to minimize trust surface for Tier 3 tools.
   */
  artifacts?: CompactArtifact[];
}

/**
 * Claim made by specialist
 *
 * Explicit statement about what the specialist did.
 * Verifier validates claims against ToolTrace and filesystem state.
 */
export type Claim =
  | FileWriteClaim
  | FileEditClaim
  | FileDeleteClaim
  | CommandExecutedClaim
  | CodeInsertedClaim;

/**
 * Claim: File was written
 */
export interface FileWriteClaim {
  kind: 'file-write';
  filePath: string;
  contentHash: string; // SHA-256 of file content
}

/**
 * Claim: File was edited
 *
 * Uses anchors instead of line numbers for stability
 */
export interface FileEditClaim {
  kind: 'file-edit';
  filePath: string;

  /**
   * Anchors for stable verification
   *
   * Anchors are code snippets before/after the change.
   * More stable than line numbers (which shift when code changes).
   */
  anchor: {
    /** 3-5 lines BEFORE the change */
    beforeSnippet: string;

    /** 3-5 lines AFTER the change */
    afterSnippet: string;

    /** SHA-256 of edited block */
    contentHash: string;
  };

  /**
   * Line numbers (hint only)
   *
   * May shift if file was edited after claim.
   * Use anchors for actual verification.
   */
  editedRegion?: {
    start: number;
    end: number;
  };
}

/**
 * Claim: File was deleted
 */
export interface FileDeleteClaim {
  kind: 'file-delete';
  filePath: string;
}

/**
 * Claim: Shell command was executed
 */
export interface CommandExecutedClaim {
  kind: 'command-executed';
  command: string;
  exitCode: number;
}

/**
 * Claim: Code was inserted at specific location
 */
export interface CodeInsertedClaim {
  kind: 'code-inserted';
  filePath: string;
  anchor: {
    beforeSnippet: string;
    afterSnippet: string;
    contentHash: string;
  };
}

/**
 * Compact artifact
 *
 * Small, self-contained output that can be verified quickly.
 * Used for Tier 3 tools where full verification is impossible.
 */
export interface CompactArtifact {
  /** Artifact type */
  kind: 'code-snippet' | 'summary' | 'data';

  /** Human-readable label */
  label: string;

  /** Artifact content (must be < 1KB) */
  content: string;

  /** SHA-256 hash of content */
  contentHash: string;

  /** Source tool that generated this artifact */
  sourceTool?: string;
}
