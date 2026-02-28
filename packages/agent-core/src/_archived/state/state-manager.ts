/**
 * StateManager — single entry point for all agent execution state.
 *
 * Composes:
 * - FileTracker (files read/created/modified, hashes, line counts)
 * - BudgetState (iterations, tokens, tiers)
 * - ExecutionState (phases, task ledger, tool usage, domains)
 */

import { FileTracker, type FileTrackingSnapshot } from './file-tracker.js';
import { BudgetState, type BudgetSnapshot, type BudgetStateConfig } from './budget-state.js';
import { ExecutionState, type ExecutionSnapshot } from './execution-state.js';

export interface StateSnapshot {
  files: FileTrackingSnapshot;
  budget: BudgetSnapshot;
  execution: ExecutionSnapshot;
}

export class StateManager {
  readonly files: FileTracker;
  readonly budget: BudgetState;
  readonly execution: ExecutionState;

  constructor(budgetConfig: BudgetStateConfig) {
    this.files = new FileTracker();
    this.budget = new BudgetState(budgetConfig);
    this.execution = new ExecutionState();
  }

  snapshot(): StateSnapshot {
    return {
      files: this.files.snapshot(),
      budget: this.budget.snapshot(),
      execution: this.execution.snapshot(),
    };
  }
}
