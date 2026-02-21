import { describe, it, expect } from 'vitest';
import { IterationBudget, percentile } from '../iteration-budget';
import type { BudgetContext } from '../iteration-budget';

function makeCtx(overrides: Partial<BudgetContext> = {}): BudgetContext {
  return {
    maxIterations: 25,
    taskBudget: null,
    lastSignalIteration: 0,
    progress: {
      lastProgressIteration: 0,
      iterationsSinceProgress: 0,
      stuckThreshold: 3,
    },
    ...overrides,
  };
}

describe('IterationBudget', () => {
  const budget = new IterationBudget();

  describe('computeIterationBudget', () => {
    it('returns min(taskBudget, configured) when taskBudget is set', () => {
      expect(budget.computeIterationBudget(makeCtx({ taskBudget: 10 }))).toBe(10);
      expect(budget.computeIterationBudget(makeCtx({ taskBudget: 30 }))).toBe(25);
    });

    it('defaults to min(configured, 12) when no taskBudget', () => {
      expect(budget.computeIterationBudget(makeCtx())).toBe(12);
      expect(budget.computeIterationBudget(makeCtx({ maxIterations: 8 }))).toBe(8);
    });

    it('handles zero maxIterations gracefully', () => {
      // 0 || 25 = 25, min(25, 12) = 12
      expect(budget.computeIterationBudget(makeCtx({ maxIterations: 0 }))).toBe(12);
    });
  });

  describe('maybeExtend', () => {
    it('does not extend when many iterations remain', () => {
      const ctx = makeCtx();
      expect(budget.maybeExtend(5, 20, ctx)).toBe(20);
    });

    it('extends by 5 when approaching limit with progress', () => {
      const ctx = makeCtx({
        progress: {
          lastProgressIteration: 9,
          iterationsSinceProgress: 1,
          stuckThreshold: 3,
        },
      });
      expect(budget.maybeExtend(9, 10, ctx)).toBe(15);
    });

    it('does not extend when stuck', () => {
      const ctx = makeCtx({
        progress: {
          lastProgressIteration: 0,
          iterationsSinceProgress: 5,
          stuckThreshold: 3,
        },
      });
      expect(budget.maybeExtend(9, 10, ctx)).toBe(10);
    });

    it('extends when recent signal detected', () => {
      const ctx = makeCtx({
        lastSignalIteration: 8,
        progress: {
          lastProgressIteration: 0,
          iterationsSinceProgress: 5,
          stuckThreshold: 3,
        },
      });
      expect(budget.maybeExtend(9, 10, ctx)).toBe(15);
    });
  });
});

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('returns correct percentile for sorted values', () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.9)).toBe(50);
  });

  it('handles single value', () => {
    expect(percentile([42], 0.75)).toBe(42);
  });

  it('does not mutate input array', () => {
    const values = [50, 10, 30, 20, 40];
    percentile(values, 0.5);
    expect(values).toEqual([50, 10, 30, 20, 40]);
  });
});
