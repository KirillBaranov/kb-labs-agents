/**
 * Iteration & token budget management.
 *
 * Pure logic — no LLM calls, no side effects. Easy to test.
 */

import { SessionManager } from '../../planning/session-manager.js';

/**
 * Minimal snapshot of agent run state required for budget decisions.
 */
export interface BudgetContext {
  /** Configured max iterations (from AgentConfig) */
  maxIterations: number;
  /** LLM-inferred budget or null if not yet classified */
  taskBudget: number | null;
  /** Session ID (for loading KPI history) */
  sessionId?: string;
  /** Root dir for session storage */
  sessionRootDir?: string;
  /** Last iteration that produced a search signal hit */
  lastSignalIteration: number;
  /** Progress tracker snapshot */
  progress: {
    lastProgressIteration: number;
    iterationsSinceProgress: number;
    stuckThreshold: number;
  };
  /** When true, honor configured maxIterations (token budget controls runtime). */
  tokenBudgetEnabled?: boolean;
}

export class IterationBudget {
  /**
   * Compute initial iteration budget for a task run.
   */
  computeIterationBudget(ctx: BudgetContext): number {
    const configured = ctx.maxIterations || 25;
    if (ctx.taskBudget !== null) {
      return Math.min(ctx.taskBudget, configured);
    }
    if (ctx.tokenBudgetEnabled) {
      return configured;
    }
    return Math.min(configured, 12);
  }

  /**
   * Compute a token budget from KPI history (p75/p90).
   * Returns 0 if not enough history.
   */
  async computeTokenBudget(ctx: BudgetContext): Promise<number> {
    if (!ctx.sessionId || !ctx.sessionRootDir) {
      return 0;
    }

    try {
      const sessionManager = new SessionManager(ctx.sessionRootDir);
      const baseline = await sessionManager.getKpiBaseline(ctx.sessionId);
      if (!baseline || baseline.samples < 5 || baseline.tokenHistory.length < 5) {
        return 0;
      }

      const tokenPool = baseline.tokenHistory.filter(
        (value) => Number.isFinite(value) && value > 0
      );
      if (tokenPool.length < 5) {
        return 0;
      }

      const qualityAwarePool: number[] = [];
      for (let i = 0; i < tokenPool.length; i++) {
        const quality = baseline.qualityScoreHistory[i] ?? 0;
        if (quality >= 0.75) {
          qualityAwarePool.push(tokenPool[i]!);
        }
      }

      const source = qualityAwarePool.length >= 5 ? qualityAwarePool : tokenPool;
      const p75 = percentile(source, 0.75);
      const p90 = percentile(source, 0.9);
      if (p75 <= 0 || p90 <= 0) {
        return 0;
      }

      return Math.max(Math.round(p75), Math.round(p90 * 0.8));
    } catch {
      return 0;
    }
  }

  /**
   * Maybe extend the iteration budget if the agent is making progress.
   * Returns the (possibly increased) budget.
   */
  maybeExtend(currentIteration: number, currentBudget: number, ctx: BudgetContext): number {
    const remainingIterations = Math.max(0, currentBudget - currentIteration);
    if (remainingIterations > 2) {
      return currentBudget;
    }

    const hasRecentSignal =
      ctx.lastSignalIteration > 0 && currentIteration - ctx.lastSignalIteration <= 3;
    const hasRecentProgress =
      ctx.progress.lastProgressIteration > 0 &&
      currentIteration - ctx.progress.lastProgressIteration <= 2;
    const hasProgress =
      ctx.progress.iterationsSinceProgress < ctx.progress.stuckThreshold ||
      hasRecentSignal ||
      hasRecentProgress;

    if (!hasProgress) {
      return currentBudget;
    }

    return currentBudget + 5;
  }
}

/**
 * Compute percentile value from a numeric array.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[index] || 0;
}
