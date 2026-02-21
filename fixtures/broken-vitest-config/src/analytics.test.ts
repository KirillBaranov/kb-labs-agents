import { describe, it, expect } from 'vitest';
import { AnalyticsCollector } from './analytics.js';

describe('AnalyticsCollector', () => {
  it('records a run and returns correct summary', () => {
    const collector = new AnalyticsCollector();
    collector.record({ taskId: 'task-1', iterations: 5, totalTokens: 8000, cost: 0.07, durationMs: 60000 });
    collector.record({ taskId: 'task-2', iterations: 3, totalTokens: 4000, cost: 0.04, durationMs: 30000 });

    const summary = collector.summary();
    expect(summary.totalRuns).toBe(2);
    expect(summary.avgTokens).toBe(6000);
    expect(summary.totalCost).toBeCloseTo(0.11);
  });

  it('returns zeros for empty collector', () => {
    const collector = new AnalyticsCollector();
    const summary = collector.summary();
    expect(summary.totalRuns).toBe(0);
    expect(summary.avgTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });
});
