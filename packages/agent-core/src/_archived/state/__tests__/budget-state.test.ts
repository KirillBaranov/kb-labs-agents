import { describe, it, expect } from 'vitest';
import { BudgetState } from '../budget-state.js';

describe('BudgetState', () => {
  function makeBudget(overrides: Partial<Parameters<typeof BudgetState['prototype']['snapshot']> extends never[] ? { maxIterations: number; initialTier: 'small' | 'medium' | 'large'; hardTokenLimit?: number } : never> = {}) {
    return new BudgetState({
      maxIterations: 20,
      initialTier: 'medium',
      hardTokenLimit: 0,
      ...overrides,
    });
  }

  describe('iteration management', () => {
    it('starts at iteration 0', () => {
      const b = makeBudget();
      expect(b.iteration).toBe(0);
    });

    it('advances iteration', () => {
      const b = makeBudget();
      b.advanceIteration();
      b.advanceIteration();
      expect(b.iteration).toBe(2);
    });

    it('detects last iteration', () => {
      const b = makeBudget({ maxIterations: 3 });
      b.setIterationBudget(3);
      expect(b.isLastIteration).toBe(false);
      b.advanceIteration(); // 1
      expect(b.isLastIteration).toBe(false);
      b.advanceIteration(); // 2 (== budget-1)
      expect(b.isLastIteration).toBe(true);
    });

    it('extends iteration budget', () => {
      const b = makeBudget({ maxIterations: 10 });
      b.setIterationBudget(10);
      b.extendIterationBudget(5);
      expect(b.iterationBudget).toBe(15);
      expect(b.iterationBudgetExtensions).toBe(1);
    });
  });

  describe('token management', () => {
    it('adds tokens', () => {
      const b = makeBudget();
      b.addTokens(1000);
      b.addTokens(500);
      expect(b.totalTokensConsumed).toBe(1500);
    });

    it('detects hard budget exceeded', () => {
      const b = makeBudget({ hardTokenLimit: 10000 });
      expect(b.hardBudgetExceeded).toBe(false);
      b.addTokens(10000);
      expect(b.hardBudgetExceeded).toBe(true);
    });

    it('does not trigger hard budget when limit is 0', () => {
      const b = makeBudget({ hardTokenLimit: 0 });
      b.addTokens(999999);
      expect(b.hardBudgetExceeded).toBe(false);
    });

    it('tracks token utilization', () => {
      const b = makeBudget({ hardTokenLimit: 10000 });
      b.addTokens(5000);
      expect(b.tokenUtilization).toBeCloseTo(0.5);
    });

    it('returns 0 utilization when no hard limit', () => {
      const b = makeBudget({ hardTokenLimit: 0 });
      b.addTokens(5000);
      expect(b.tokenUtilization).toBe(0);
    });
  });

  describe('tier management', () => {
    it('starts with initial tier', () => {
      const b = makeBudget({ initialTier: 'small' });
      expect(b.startTier).toBe('small');
      expect(b.currentTier).toBe('small');
    });

    it('updates current tier without changing start tier', () => {
      const b = makeBudget({ initialTier: 'small' });
      b.setCurrentTier('medium');
      expect(b.startTier).toBe('small');
      expect(b.currentTier).toBe('medium');
    });
  });

  describe('convergence', () => {
    it('tracks convergence nudge', () => {
      const b = makeBudget();
      expect(b.convergenceNudgeSent).toBe(false);
      b.markConvergenceNudgeSent();
      expect(b.convergenceNudgeSent).toBe(true);
    });
  });

  describe('task budget', () => {
    it('defaults to null', () => {
      const b = makeBudget();
      expect(b.taskBudget).toBeNull();
    });

    it('can be set and read', () => {
      const b = makeBudget();
      b.setTaskBudget(8);
      expect(b.taskBudget).toBe(8);
    });
  });

  describe('snapshot', () => {
    it('returns complete state', () => {
      const b = makeBudget({ maxIterations: 10, initialTier: 'small', hardTokenLimit: 50000 });
      b.advanceIteration();
      b.addTokens(10000);
      b.setTaskBudget(5);
      b.markConvergenceNudgeSent();

      const snap = b.snapshot();
      expect(snap.iteration).toBe(1);
      expect(snap.maxIterations).toBe(10);
      expect(snap.totalTokensConsumed).toBe(10000);
      expect(snap.hardTokenLimit).toBe(50000);
      expect(snap.taskBudget).toBe(5);
      expect(snap.startTier).toBe('small');
      expect(snap.currentTier).toBe('small');
      expect(snap.convergenceNudgeSent).toBe(true);
      expect(snap.tokenUtilization).toBeCloseTo(0.2);
    });

    it('computes iteration utilization', () => {
      const b = makeBudget({ maxIterations: 10 });
      b.setIterationBudget(10);
      b.advanceIteration(); // 1
      b.advanceIteration(); // 2
      b.advanceIteration(); // 3
      const snap = b.snapshot();
      expect(snap.iterationUtilization).toBeCloseTo(0.3);
    });
  });
});
