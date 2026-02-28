import { describe, it, expect } from 'vitest';
import { StateManager } from '../state-manager.js';

describe('StateManager', () => {
  it('creates all sub-managers', () => {
    const mgr = new StateManager({ maxIterations: 10, initialTier: 'medium' });
    expect(mgr.files).toBeDefined();
    expect(mgr.budget).toBeDefined();
    expect(mgr.execution).toBeDefined();
  });

  it('passes budget config through', () => {
    const mgr = new StateManager({
      maxIterations: 15,
      initialTier: 'small',
      hardTokenLimit: 100000,
    });
    expect(mgr.budget.maxIterations).toBe(15);
    expect(mgr.budget.startTier).toBe('small');
    expect(mgr.budget.hardTokenLimit).toBe(100000);
  });

  it('produces a complete snapshot', () => {
    const mgr = new StateManager({ maxIterations: 10, initialTier: 'medium' });

    // Use each sub-manager
    mgr.files.markRead('/a.ts', 'h', 10, 10);
    mgr.budget.advanceIteration();
    mgr.budget.addTokens(5000);
    mgr.execution.recordToolUse('fs_read');
    mgr.execution.addDomain('filesystem');

    const snap = mgr.snapshot();

    // Files
    expect(snap.files.filesRead.has('/a.ts')).toBe(true);
    expect(snap.files.totalFilesTouched).toBe(1);

    // Budget
    expect(snap.budget.iteration).toBe(1);
    expect(snap.budget.totalTokensConsumed).toBe(5000);

    // Execution
    expect(snap.execution.toolUsageCounts).toEqual({ fs_read: 1 });
    expect(snap.execution.touchedDomains).toEqual(['filesystem']);
  });
});
