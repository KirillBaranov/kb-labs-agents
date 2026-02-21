/**
 * @module todo-sync
 *
 * Todo-list lifecycle management for execution-phase tracking.
 */
export {
  TodoSyncCoordinator,
  shouldNudgeTodoDiscipline,
  buildInitialTodoItems,
} from './todo-sync-coordinator.js';

export type {
  TodoPhase,
  TodoStatus,
  ExecutionPhase as TodoExecutionPhase,
  TodoToolResult,
  TodoToolExecutor,
  TodoHasToolCheck,
  TodoSyncState,
} from './todo-sync-coordinator.js';
