import { describe, it, expect } from 'vitest';
import { TierSelector, isAuditOrAnalysisTask, isLikelyActionTask } from '../tier-selector';
import type { TierSelectorContext } from '../tier-selector';

function makeCtx(overrides: Partial<TierSelectorContext> = {}): TierSelectorContext {
  return {
    currentIterationBudget: 20,
    maxIterations: 25,
    progressIterationsSinceProgress: 0,
    ...overrides,
  };
}

describe('TierSelector', () => {
  const selector = new TierSelector();

  describe('resolveConfig', () => {
    it('fills defaults when no config provided', () => {
      const config = selector.resolveConfig();
      expect(config.enabled).toBe(true);
      expect(config.nodes.intentInference).toBe(false);
      expect(config.nodes.searchAssessment).toBe(true);
      expect(config.nodes.taskValidation).toBe(true);
      expect(config.auditTasksPreferMedium).toBe(true);
    });

    it('respects partial overrides', () => {
      const config = selector.resolveConfig({
        enabled: false,
        nodes: { intentInference: true },
      });
      expect(config.enabled).toBe(false);
      expect(config.nodes.intentInference).toBe(true);
      expect(config.nodes.searchAssessment).toBe(true); // default
    });
  });

  describe('chooseSmartTier', () => {
    it('returns small when tiering is disabled', () => {
      const ctx = makeCtx({ smartTiering: { enabled: false } });
      expect(selector.chooseSmartTier('searchAssessment', ctx)).toBe('small');
    });

    it('returns medium for audit tasks when enabled', () => {
      const ctx = makeCtx({ currentTask: 'analyze architecture reliability' });
      expect(selector.chooseSmartTier('searchAssessment', ctx)).toBe('medium');
    });

    it('returns small for intentInference by default (node disabled)', () => {
      const ctx = makeCtx();
      expect(selector.chooseSmartTier('intentInference', ctx)).toBe('small');
    });

    it('returns medium for searchAssessment with stalled progress', () => {
      const ctx = makeCtx({ progressIterationsSinceProgress: 3 });
      expect(selector.chooseSmartTier('searchAssessment', ctx)).toBe('medium');
    });

    it('returns medium for taskValidation with high iteration usage', () => {
      const ctx = makeCtx({ currentIterationBudget: 10, maxIterations: 10 });
      expect(selector.chooseSmartTier('taskValidation', ctx, {
        iterationsUsed: 8,
      })).toBe('medium');
    });

    it('returns small for taskValidation early in run', () => {
      const ctx = makeCtx();
      expect(selector.chooseSmartTier('taskValidation', ctx, {
        iterationsUsed: 2,
      })).toBe('small');
    });
  });

  describe('evaluateEscalationNeed', () => {
    it('returns false when escalation is disabled', () => {
      const result = selector.evaluateEscalationNeed({
        tier: 'small',
        iteration: 10,
        maxIterations: 20,
        enableEscalation: false,
        hasOnAskParent: false,
        progressIterationsSinceProgress: 5,
        progressStuckThreshold: 3,
        lastSignalIteration: 0,
        lastProgressIteration: 0,
        lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
        filesRead: new Set(),
        filesModified: new Set(),
        filesCreated: new Set(),
      });
      expect(result.shouldEscalate).toBe(false);
    });

    it('returns false when tier is already large', () => {
      const result = selector.evaluateEscalationNeed({
        tier: 'large',
        iteration: 10,
        maxIterations: 20,
        enableEscalation: true,
        hasOnAskParent: false,
        progressIterationsSinceProgress: 5,
        progressStuckThreshold: 3,
        lastSignalIteration: 0,
        lastProgressIteration: 0,
        lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
        filesRead: new Set(),
        filesModified: new Set(),
        filesCreated: new Set(),
      });
      expect(result.shouldEscalate).toBe(false);
    });

    it('escalates on repeated tool calls with no progress', () => {
      const result = selector.evaluateEscalationNeed({
        tier: 'small',
        iteration: 8,
        maxIterations: 20,
        enableEscalation: true,
        hasOnAskParent: false,
        progressIterationsSinceProgress: 5,
        progressStuckThreshold: 3,
        lastSignalIteration: 0,
        lastProgressIteration: 0,
        lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
        filesRead: new Set(),
        filesModified: new Set(),
        filesCreated: new Set(),
      });
      expect(result.shouldEscalate).toBe(true);
      expect(result.reason).toContain('repeating');
    });

    it('does not escalate too early', () => {
      const result = selector.evaluateEscalationNeed({
        tier: 'small',
        iteration: 2,
        maxIterations: 20,
        enableEscalation: true,
        hasOnAskParent: false,
        progressIterationsSinceProgress: 5,
        progressStuckThreshold: 3,
        lastSignalIteration: 0,
        lastProgressIteration: 0,
        lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
        filesRead: new Set(),
        filesModified: new Set(),
        filesCreated: new Set(),
      });
      expect(result.shouldEscalate).toBe(false);
    });
  });
});

describe('isAuditOrAnalysisTask', () => {
  it('matches audit keywords', () => {
    expect(isAuditOrAnalysisTask('run architecture audit')).toBe(true);
    expect(isAuditOrAnalysisTask('check reliability')).toBe(true);
    expect(isAuditOrAnalysisTask('analyze timeout handling')).toBe(true);
  });

  it('does not match unrelated tasks', () => {
    expect(isAuditOrAnalysisTask('add a button')).toBe(false);
  });
});

describe('isLikelyActionTask', () => {
  it('respects explicit taskIntent', () => {
    expect(isLikelyActionTask('anything', 'action')).toBe(true);
    expect(isLikelyActionTask('create something', 'discovery')).toBe(false);
  });

  it('falls back to regex when no intent', () => {
    expect(isLikelyActionTask('implement new feature', null)).toBe(true);
    expect(isLikelyActionTask('what is X?', null)).toBe(false);
  });
});
