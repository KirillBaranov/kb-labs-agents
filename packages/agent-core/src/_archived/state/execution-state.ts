/**
 * ExecutionState — consolidates execution tracking from agent.ts.
 *
 * Wraps:
 * - ExecutionStateMachine (phase transitions)
 * - TaskLedger (structured step recording)
 * - Tool usage counts
 * - Domain tracking
 * - Tool error counts
 */

import { ExecutionStateMachine, type ExecutionPhase } from '../../execution/state-machine.js';
import { TaskLedger } from '../../execution/task-ledger.js';

export interface ExecutionSnapshot {
  phase: ExecutionPhase;
  phaseDurationsMs: Record<string, number>;
  toolUsageCounts: Record<string, number>;
  toolErrorCount: number;
  touchedDomains: string[];
  ledgerSummary: ReturnType<TaskLedger['getSummary']>;
}

export class ExecutionState {
  readonly stateMachine: ExecutionStateMachine;
  readonly taskLedger: TaskLedger;

  private readonly _toolsUsedCount = new Map<string, number>();
  private readonly _touchedDomains = new Set<string>();
  private _toolErrorCount = 0;

  constructor() {
    this.stateMachine = new ExecutionStateMachine();
    this.taskLedger = new TaskLedger();
  }

  // ── Tool tracking ──────────────────────────────────────────────

  recordToolUse(toolName: string): void {
    this._toolsUsedCount.set(toolName, (this._toolsUsedCount.get(toolName) ?? 0) + 1);
  }

  recordToolError(): void {
    this._toolErrorCount++;
  }

  getToolUseCount(toolName: string): number {
    return this._toolsUsedCount.get(toolName) ?? 0;
  }

  get toolsUsedCount(): ReadonlyMap<string, number> {
    return this._toolsUsedCount;
  }

  get toolErrorCount(): number {
    return this._toolErrorCount;
  }

  get totalToolCalls(): number {
    let sum = 0;
    for (const count of this._toolsUsedCount.values()) {
      sum += count;
    }
    return sum;
  }

  // ── Domain tracking ────────────────────────────────────────────

  addDomain(domain: string): void {
    this._touchedDomains.add(domain);
  }

  get touchedDomains(): ReadonlySet<string> {
    return this._touchedDomains;
  }

  /** Mutable access for ProgressTracker which calls .add() directly. */
  getMutableTouchedDomains(): Set<string> {
    return this._touchedDomains;
  }

  // ── Phase shortcuts ────────────────────────────────────────────

  get currentPhase(): ExecutionPhase {
    return this.stateMachine.getCurrent();
  }

  transitionTo(phase: ExecutionPhase, reason?: string): void {
    this.stateMachine.transition(phase, reason);
  }

  // ── Snapshot ───────────────────────────────────────────────────

  snapshot(): ExecutionSnapshot {
    const toolUsageCounts: Record<string, number> = {};
    for (const [name, count] of this._toolsUsedCount) {
      toolUsageCounts[name] = count;
    }

    return {
      phase: this.currentPhase,
      phaseDurationsMs: this.stateMachine.getPhaseDurationsMs(),
      toolUsageCounts,
      toolErrorCount: this._toolErrorCount,
      touchedDomains: [...this._touchedDomains],
      ledgerSummary: this.taskLedger.getSummary(),
    };
  }
}
