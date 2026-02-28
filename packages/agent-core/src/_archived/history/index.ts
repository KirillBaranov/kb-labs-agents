/**
 * File change history system — re-exported from @kb-labs/agent-history
 *
 * This module is kept for backward compatibility.
 * Import directly from @kb-labs/agent-history in new code.
 */

export {
  FileChangeTracker,
  SnapshotStorage,
  ConflictDetector,
  ConflictResolver,
} from '@kb-labs/agent-history';
export type {
  FileChange,
  RollbackResult,
  ConflictInfo,
  StorageConfig,
  DetectedConflict,
  ConflictType,
  ResolutionResult,
} from '@kb-labs/agent-history';
