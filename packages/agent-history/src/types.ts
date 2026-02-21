/**
 * File change history types
 */

/**
 * Single file change snapshot
 */
export interface FileChange {
  /** Unique change ID */
  id: string;

  /** Session ID for grouping changes */
  sessionId: string;

  /** Agent ID that made the change */
  agentId: string;

  /** Run ID that produced this change — enables per-turn/per-run filtering */
  runId?: string;

  /** File path relative to working directory */
  filePath: string;

  /** Operation type */
  operation: 'write' | 'patch' | 'delete';

  /** Timestamp when change was made */
  timestamp: string;

  /** Snapshot before change (null for new files) */
  before?: {
    content: string;
    hash: string;
    size: number;
  };

  /** Snapshot after change */
  after: {
    content: string;
    hash: string;
    size: number;
  };

  /** Operation-specific metadata */
  metadata?: {
    // fs_patch specific
    startLine?: number;
    endLine?: number;
    linesAdded?: number;
    linesRemoved?: number;

    // fs_write specific
    isOverwrite?: boolean;

    // fs_delete specific
    wasDeleted?: boolean;
  };

  /** User explicitly approved this change */
  approved?: boolean;

  /** ISO timestamp when change was approved */
  approvedAt?: string;
}

/**
 * Lightweight summary of a file change — no before/after content.
 * Used in Turn.metadata.fileChanges to avoid bloating session turn history.
 */
export interface FileChangeSummary {
  /** ID of the full FileChange record */
  changeId: string;

  /** File path relative to working directory */
  filePath: string;

  /** Operation type */
  operation: 'write' | 'patch' | 'delete';

  /** Timestamp when change was made */
  timestamp: string;

  /** Lines added (from metadata) */
  linesAdded?: number;

  /** Lines removed (from metadata) */
  linesRemoved?: number;

  /** True when before was null (new file created by agent) */
  isNew: boolean;

  /** Size of file after change in bytes */
  sizeAfter: number;

  /** Whether user approved this change */
  approved?: boolean;
}

/**
 * Rollback result
 */
export interface RollbackResult {
  /** Number of files rolled back */
  rolledBack: number;

  /** Number of files skipped (due to conflicts) */
  skipped: number;

  /** Conflicts encountered */
  conflicts?: ConflictInfo[];
}

/**
 * Conflict information
 */
export interface ConflictInfo {
  filePath: string;
  change: FileChange;
  laterModifiedBy: string[];
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  basePath: string;
  maxSessions?: number;
  maxAgeDays?: number;
  maxTotalSizeMb?: number;
  compressOldSnapshots?: boolean;
}
