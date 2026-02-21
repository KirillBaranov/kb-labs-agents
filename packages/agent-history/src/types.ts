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
