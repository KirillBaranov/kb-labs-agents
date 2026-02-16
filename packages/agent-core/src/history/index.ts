/**
 * File change history system
 */

export { FileChangeTracker } from './file-change-tracker.js';
export { SnapshotStorage } from './snapshot-storage.js';
export { ConflictDetector } from './conflict-detector.js';
export { ConflictResolver } from './conflict-resolver.js';
export type {
  FileChange,
  RollbackResult,
  ConflictInfo,
  StorageConfig,
} from './types.js';
export type { DetectedConflict, ConflictType } from './conflict-detector.js';
export type { ResolutionResult } from './conflict-resolver.js';
