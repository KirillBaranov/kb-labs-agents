import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionState } from '../execution-state.js';

describe('ExecutionState', () => {
  let state: ExecutionState;

  beforeEach(() => {
    state = new ExecutionState();
  });

  describe('tool tracking', () => {
    it('records tool usage', () => {
      state.recordToolUse('fs_read');
      state.recordToolUse('fs_read');
      state.recordToolUse('shell_exec');
      expect(state.getToolUseCount('fs_read')).toBe(2);
      expect(state.getToolUseCount('shell_exec')).toBe(1);
      expect(state.getToolUseCount('unknown')).toBe(0);
    });

    it('counts total tool calls', () => {
      state.recordToolUse('fs_read');
      state.recordToolUse('fs_read');
      state.recordToolUse('grep_search');
      expect(state.totalToolCalls).toBe(3);
    });

    it('tracks tool errors', () => {
      expect(state.toolErrorCount).toBe(0);
      state.recordToolError();
      state.recordToolError();
      expect(state.toolErrorCount).toBe(2);
    });

    it('exposes tools used count map', () => {
      state.recordToolUse('a');
      state.recordToolUse('b');
      state.recordToolUse('a');
      const map = state.toolsUsedCount;
      expect(map.get('a')).toBe(2);
      expect(map.get('b')).toBe(1);
    });
  });

  describe('domain tracking', () => {
    it('tracks touched domains', () => {
      state.addDomain('filesystem');
      state.addDomain('network');
      state.addDomain('filesystem'); // duplicate
      expect(state.touchedDomains.size).toBe(2);
      expect(state.touchedDomains.has('filesystem')).toBe(true);
      expect(state.touchedDomains.has('network')).toBe(true);
    });
  });

  describe('phase management', () => {
    it('starts at init phase', () => {
      expect(state.currentPhase).toBe('init');
    });

    it('transitions to a new phase', () => {
      state.transitionTo('executing', 'task started');
      expect(state.currentPhase).toBe('executing');
    });
  });

  describe('snapshot', () => {
    it('returns complete execution state', () => {
      state.recordToolUse('fs_read');
      state.recordToolUse('shell_exec');
      state.recordToolError();
      state.addDomain('filesystem');
      state.transitionTo('executing');

      const snap = state.snapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.toolUsageCounts).toEqual({ fs_read: 1, shell_exec: 1 });
      expect(snap.toolErrorCount).toBe(1);
      expect(snap.touchedDomains).toEqual(['filesystem']);
      expect(snap.ledgerSummary).toBeDefined();
      expect(snap.ledgerSummary.totalSteps).toBe(0);
    });
  });
});
