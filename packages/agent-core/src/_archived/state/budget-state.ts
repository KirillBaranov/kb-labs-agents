/**
 * BudgetState — single source of truth for all budget-related state.
 *
 * Consolidates:
 * - Iteration budget (current, max, extensions)
 * - Token budget (current, total consumed, hard limit)
 * - Tier tracking (start, current, final)
 * - Task budget (LLM-inferred)
 * - Convergence nudge tracking
 *
 * Previously these were 10+ private fields scattered across agent.ts.
 */

import type { LLMTier } from '@kb-labs/agent-contracts';

export interface BudgetSnapshot {
  iteration: number;
  maxIterations: number;
  iterationBudget: number;
  iterationBudgetExtensions: number;
  totalTokensConsumed: number;
  tokenBudget: number;
  hardTokenLimit: number;
  taskBudget: number | null;
  startTier: LLMTier;
  currentTier: LLMTier;
  convergenceNudgeSent: boolean;
  /** Ratio of tokens consumed to hard limit (0 if no limit) */
  tokenUtilization: number;
  /** Ratio of iterations used to budget */
  iterationUtilization: number;
  isLastIteration: boolean;
}

export interface BudgetStateConfig {
  maxIterations: number;
  initialTier: LLMTier;
  hardTokenLimit?: number;
}

export class BudgetState {
  // ── Iteration ──────────────────────────────────────────────────
  private _iteration = 0;
  private _maxIterations: number;
  private _iterationBudget: number;
  private _iterationBudgetExtensions = 0;

  // ── Tokens ─────────────────────────────────────────────────────
  private _totalTokensConsumed = 0;
  private _tokenBudget = 0;
  private _hardTokenLimit: number;
  private _taskBudget: number | null = null;

  // ── Tier ───────────────────────────────────────────────────────
  private _startTier: LLMTier;
  private _currentTier: LLMTier;

  // ── Convergence ────────────────────────────────────────────────
  private _convergenceNudgeSent = false;

  constructor(config: BudgetStateConfig) {
    this._maxIterations = config.maxIterations;
    this._iterationBudget = config.maxIterations;
    this._startTier = config.initialTier;
    this._currentTier = config.initialTier;
    this._hardTokenLimit = config.hardTokenLimit ?? 0;
  }

  // ── Iteration accessors ────────────────────────────────────────

  get iteration(): number {
    return this._iteration;
  }

  get maxIterations(): number {
    return this._maxIterations;
  }

  get iterationBudget(): number {
    return this._iterationBudget;
  }

  get iterationBudgetExtensions(): number {
    return this._iterationBudgetExtensions;
  }

  get isLastIteration(): boolean {
    return this._iteration >= this._iterationBudget - 1;
  }

  advanceIteration(): void {
    this._iteration++;
  }

  setIterationBudget(budget: number): void {
    this._iterationBudget = budget;
  }

  extendIterationBudget(extra: number): void {
    this._iterationBudget += extra;
    this._iterationBudgetExtensions++;
  }

  // ── Token accessors ────────────────────────────────────────────

  get totalTokensConsumed(): number {
    return this._totalTokensConsumed;
  }

  get tokenBudget(): number {
    return this._tokenBudget;
  }

  get hardTokenLimit(): number {
    return this._hardTokenLimit;
  }

  get taskBudget(): number | null {
    return this._taskBudget;
  }

  get hardBudgetExceeded(): boolean {
    return this._hardTokenLimit > 0 && this._totalTokensConsumed >= this._hardTokenLimit;
  }

  addTokens(count: number): void {
    this._totalTokensConsumed += count;
  }

  setTokenBudget(budget: number): void {
    this._tokenBudget = budget;
  }

  setHardTokenLimit(limit: number): void {
    this._hardTokenLimit = limit;
  }

  setTaskBudget(budget: number | null): void {
    this._taskBudget = budget;
  }

  // ── Tier accessors ─────────────────────────────────────────────

  get startTier(): LLMTier {
    return this._startTier;
  }

  get currentTier(): LLMTier {
    return this._currentTier;
  }

  setCurrentTier(tier: LLMTier): void {
    this._currentTier = tier;
  }

  // ── Convergence ────────────────────────────────────────────────

  get convergenceNudgeSent(): boolean {
    return this._convergenceNudgeSent;
  }

  markConvergenceNudgeSent(): void {
    this._convergenceNudgeSent = true;
  }

  // ── Utilization ────────────────────────────────────────────────

  get tokenUtilization(): number {
    if (this._hardTokenLimit <= 0) {return 0;}
    return this._totalTokensConsumed / this._hardTokenLimit;
  }

  get iterationUtilization(): number {
    if (this._iterationBudget <= 0) {return 0;}
    return this._iteration / this._iterationBudget;
  }

  // ── Snapshot ───────────────────────────────────────────────────

  snapshot(): BudgetSnapshot {
    return {
      iteration: this._iteration,
      maxIterations: this._maxIterations,
      iterationBudget: this._iterationBudget,
      iterationBudgetExtensions: this._iterationBudgetExtensions,
      totalTokensConsumed: this._totalTokensConsumed,
      tokenBudget: this._tokenBudget,
      hardTokenLimit: this._hardTokenLimit,
      taskBudget: this._taskBudget,
      startTier: this._startTier,
      currentTier: this._currentTier,
      convergenceNudgeSent: this._convergenceNudgeSent,
      tokenUtilization: this.tokenUtilization,
      iterationUtilization: this.iterationUtilization,
      isLastIteration: this.isLastIteration,
    };
  }
}
