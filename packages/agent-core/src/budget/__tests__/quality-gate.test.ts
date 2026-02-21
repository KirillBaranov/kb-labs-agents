import { describe, it, expect } from 'vitest';
import { QualityGate } from '../quality-gate';
import type { QualityGateInput } from '../quality-gate';

function makeInput(overrides: Partial<QualityGateInput> = {}): QualityGateInput {
  return {
    toolsUsedCount: new Map(),
    filesRead: new Set(),
    filesModified: new Set(),
    filesCreated: new Set(),
    toolErrorCount: 0,
    touchedDomains: new Set(),
    searchSignalHits: 0,
    taskLedger: { getSummary: () => ({ failedSteps: 0, pendingSteps: 0 }) },
    currentTask: undefined,
    iterationsUsed: 5,
    ...overrides,
  };
}

describe('QualityGate', () => {
  const gate = new QualityGate();

  describe('evaluate', () => {
    it('passes with perfect run', () => {
      const result = gate.evaluate(makeInput({
        filesRead: new Set(['a.ts', 'b.ts']),
        filesModified: new Set(['c.ts']),
      }));
      expect(result.status).toBe('pass');
      expect(result.score).toBe(1);
      expect(result.reasons).toEqual([]);
    });

    it('penalizes high tool error rate', () => {
      const tools = new Map([['grep_search', 10]]);
      const result = gate.evaluate(makeInput({
        toolsUsedCount: tools,
        toolErrorCount: 5, // 50%
      }));
      expect(result.score).toBeLessThan(1);
      expect(result.reasons.some((r) => r.includes('tool error rate'))).toBe(true);
    });

    it('penalizes scope drift', () => {
      const tools = new Map([['grep_search', 3]]);
      const result = gate.evaluate(makeInput({
        toolsUsedCount: tools,
        touchedDomains: new Set(['a', 'b', 'c']),
      }));
      expect(result.reasons.some((r) => r.includes('drift'))).toBe(true);
    });

    it('penalizes low evidence density', () => {
      const tools = new Map([['grep_search', 5], ['fs_read', 2]]);
      const result = gate.evaluate(makeInput({
        toolsUsedCount: tools,
        iterationsUsed: 10,
      }));
      expect(result.reasons.some((r) => r.includes('evidence'))).toBe(true);
    });

    it('penalizes failed ledger steps', () => {
      const result = gate.evaluate(makeInput({
        taskLedger: { getSummary: () => ({ failedSteps: 2, pendingSteps: 0 }) },
      }));
      expect(result.reasons.some((r) => r.includes('failed execution'))).toBe(true);
    });

    it('returns partial status and nextChecks below threshold', () => {
      const tools = new Map([['grep_search', 10]]);
      const result = gate.evaluate(makeInput({
        toolsUsedCount: tools,
        toolErrorCount: 8, // 80% error rate
        touchedDomains: new Set(['a', 'b', 'c', 'd']),
      }));
      expect(result.status).toBe('partial');
      expect(result.nextChecks).toBeDefined();
      expect(result.nextChecks!.length).toBeGreaterThan(0);
    });

    it('clamps score at 0', () => {
      const tools = new Map([['grep_search', 10]]);
      const result = gate.evaluate(makeInput({
        toolsUsedCount: tools,
        toolErrorCount: 10,
        touchedDomains: new Set(['a', 'b', 'c', 'd', 'e']),
        taskLedger: { getSummary: () => ({ failedSteps: 3, pendingSteps: 5 }) },
      }));
      expect(result.score).toBe(0);
    });
  });

  describe('shouldNudgeConvergence', () => {
    it('returns false for small budgets', () => {
      expect(gate.shouldNudgeConvergence({
        iteration: 5,
        maxIterations: 6,
        task: 'analyze code',
        filesModified: new Set(),
        filesCreated: new Set(),
        toolsUsedCount: new Map([['grep_search', 5]]),
      })).toBe(false);
    });

    it('returns false for early iterations', () => {
      expect(gate.shouldNudgeConvergence({
        iteration: 2,
        maxIterations: 20,
        task: 'analyze code',
        filesModified: new Set(),
        filesCreated: new Set(),
        toolsUsedCount: new Map([['grep_search', 5]]),
      })).toBe(false);
    });

    it('returns true when enough tool calls made', () => {
      expect(gate.shouldNudgeConvergence({
        iteration: 5,
        maxIterations: 20,
        task: 'analyze code',
        filesModified: new Set(),
        filesCreated: new Set(),
        toolsUsedCount: new Map([['grep_search', 5]]),
      })).toBe(true);
    });

    it('returns false for action task with no file changes yet', () => {
      expect(gate.shouldNudgeConvergence({
        iteration: 5,
        maxIterations: 20,
        task: 'create a new module',
        filesModified: new Set(),
        filesCreated: new Set(),
        toolsUsedCount: new Map([['grep_search', 5]]),
      })).toBe(false);
    });
  });

  describe('detectStuck', () => {
    it('detects same tool 3 times in a row', () => {
      expect(gate.detectStuck({
        lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
        iterationsSinceProgress: 0,
        stuckThreshold: 3,
      })).toBe(true);
    });

    it('does not flag varied tool calls', () => {
      expect(gate.detectStuck({
        lastToolCalls: ['grep_search', 'fs_read', 'grep_search'],
        iterationsSinceProgress: 0,
        stuckThreshold: 3,
      })).toBe(false);
    });

    it('detects no progress for threshold iterations', () => {
      expect(gate.detectStuck({
        lastToolCalls: [],
        iterationsSinceProgress: 4,
        stuckThreshold: 3,
      })).toBe(true);
    });
  });

  describe('hasStrongEvidenceSignal', () => {
    it('returns true with sufficient evidence', () => {
      expect(gate.hasStrongEvidenceSignal({
        toolsUsedCount: new Map([['grep_search', 5]]),
        filesRead: new Set(['a', 'b', 'c']),
        filesModified: new Set(),
        filesCreated: new Set(),
        touchedDomains: new Set(['search']),
        toolErrorCount: 0,
        iterationsUsed: 4,
      })).toBe(true);
    });

    it('returns false with insufficient evidence count', () => {
      expect(gate.hasStrongEvidenceSignal({
        toolsUsedCount: new Map([['grep_search', 5]]),
        filesRead: new Set(['a']),
        filesModified: new Set(),
        filesCreated: new Set(),
        touchedDomains: new Set(['search']),
        toolErrorCount: 0,
        iterationsUsed: 4,
      })).toBe(false);
    });
  });

  describe('buildNeedsClarificationSummary', () => {
    it('appends clarification block', () => {
      const result = gate.buildNeedsClarificationSummary('base summary', {
        reasons: ['scope drift detected'],
        nextChecks: ['Restrict scope'],
      });
      expect(result).toContain('base summary');
      expect(result).toContain('[Needs Clarification]');
      expect(result).toContain('scope drift detected');
      expect(result).toContain('Restrict scope');
    });

    it('uses default reasons when empty', () => {
      const result = gate.buildNeedsClarificationSummary('summary', {
        reasons: [],
      });
      expect(result).toContain('insufficient confidence');
    });
  });
});
