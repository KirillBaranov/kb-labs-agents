/**
 * Unit tests for VerificationMetrics
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VerificationMetrics } from '../verification-metrics.js';
import type { PluginContextV3 } from '@kb-labs/sdk';

// Mock PluginContextV3
const createMockContext = (): PluginContextV3 => ({
  platform: {
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
} as unknown as PluginContextV3);

describe('VerificationMetrics', () => {
  let metrics: VerificationMetrics;
  let ctx: PluginContextV3;

  beforeEach(() => {
    ctx = createMockContext();
    metrics = new VerificationMetrics(ctx);
  });

  describe('record()', () => {
    it('should record successful Level 1 validation', () => {
      metrics.record({
        agentId: 'implementer',
        subtaskId: 'subtask-1',
        level: 1,
        status: 'passed',
        durationMs: 10,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.totalChecks).toBe(1);
      expect(aggregates.byLevel[1].total).toBe(1);
      expect(aggregates.byLevel[1].passed).toBe(1);
      expect(aggregates.byLevel[1].failed).toBe(0);
      expect(aggregates.passRate).toBe(1.0);
    });

    it('should record failed Level 1 validation', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'failed',
        errorCategory: 'missing_field',
        errorDetails: 'traceRef: Required',
        durationMs: 5,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.totalChecks).toBe(1);
      expect(aggregates.byLevel[1].failed).toBe(1);
      expect(aggregates.errorsByCategory.missing_field).toBe(1);
      expect(aggregates.passRate).toBe(0);
    });

    it('should record Level 3 validation', () => {
      metrics.record({
        agentId: 'implementer',
        level: 3,
        status: 'passed',
        durationMs: 45,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.byLevel[3].total).toBe(1);
      expect(aggregates.byLevel[3].passed).toBe(1);
      expect(aggregates.byLevel[3].avgDurationMs).toBe(45);
    });

    it('should track multiple events', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'passed',
        durationMs: 10,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'tester',
        level: 1,
        status: 'passed',
        durationMs: 12,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'implementer',
        level: 3,
        status: 'failed',
        errorCategory: 'hash_mismatch',
        durationMs: 30,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.totalChecks).toBe(3);
      expect(aggregates.byLevel[1].total).toBe(2);
      expect(aggregates.byLevel[3].total).toBe(1);
      expect(aggregates.passRate).toBe(2 / 3);
    });

    it('should track metrics by agent', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'passed',
        durationMs: 10,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'implementer',
        level: 3,
        status: 'failed',
        errorCategory: 'hash_mismatch',
        durationMs: 30,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'tester',
        level: 1,
        status: 'passed',
        durationMs: 8,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.bySpecialist.implementer).toEqual({
        total: 2,
        passed: 1,
        failed: 1,
      });

      expect(aggregates.bySpecialist.tester).toEqual({
        total: 1,
        passed: 1,
        failed: 0,
      });
    });

    it('should calculate average duration per level', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'passed',
        durationMs: 10,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'passed',
        durationMs: 20,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.byLevel[1].avgDurationMs).toBe(15); // (10 + 20) / 2
    });

    it('should respect max buffer size (1000 events)', () => {
      // Add 1100 events
      for (let i = 0; i < 1100; i++) {
        metrics.record({
          agentId: 'test',
          level: 1,
          status: 'passed',
          durationMs: 10,
          timestamp: Date.now(),
        });
      }

      const recent = metrics.getRecentEvents(2000);

      // Should only keep last 1000
      expect(recent.length).toBe(1000);
    });
  });

  describe('getAggregates()', () => {
    it('should return empty aggregates when no events', () => {
      const aggregates = metrics.getAggregates();

      expect(aggregates.totalChecks).toBe(0);
      expect(aggregates.passRate).toBe(0);
      expect(aggregates.byLevel[1].total).toBe(0);
      expect(Object.keys(aggregates.bySpecialist)).toHaveLength(0);
    });

    it('should aggregate error categories correctly', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'failed',
        errorCategory: 'missing_field',
        durationMs: 5,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'implementer',
        level: 3,
        status: 'failed',
        errorCategory: 'hash_mismatch',
        durationMs: 30,
        timestamp: Date.now(),
      });

      metrics.record({
        agentId: 'tester',
        level: 3,
        status: 'failed',
        errorCategory: 'hash_mismatch',
        durationMs: 25,
        timestamp: Date.now(),
      });

      const aggregates = metrics.getAggregates();

      expect(aggregates.errorsByCategory.missing_field).toBe(1);
      expect(aggregates.errorsByCategory.hash_mismatch).toBe(2);
      expect(aggregates.errorsByCategory.invalid_type).toBe(0);
    });
  });

  describe('clear()', () => {
    it('should clear all events', () => {
      metrics.record({
        agentId: 'implementer',
        level: 1,
        status: 'passed',
        durationMs: 10,
        timestamp: Date.now(),
      });

      expect(metrics.getAggregates().totalChecks).toBe(1);

      metrics.clear();

      expect(metrics.getAggregates().totalChecks).toBe(0);
    });
  });

  describe('getRecentEvents()', () => {
    it('should return recent events with limit', () => {
      for (let i = 0; i < 10; i++) {
        metrics.record({
          agentId: 'test',
          level: 1,
          status: 'passed',
          durationMs: i,
          timestamp: Date.now(),
        });
      }

      const recent = metrics.getRecentEvents(5);

      expect(recent).toHaveLength(5);
      // Should be last 5 events
      expect(recent[4].durationMs).toBe(9);
      expect(recent[0].durationMs).toBe(5);
    });
  });

  describe('categorizeError()', () => {
    it('should categorize missing field errors', () => {
      const category = VerificationMetrics.categorizeError(['traceRef: Required']);
      expect(category).toBe('missing_field');
    });

    it('should categorize type errors', () => {
      const category = VerificationMetrics.categorizeError(['Expected string, received number']);
      expect(category).toBe('invalid_type');
    });

    it('should categorize hash mismatch errors', () => {
      const category = VerificationMetrics.categorizeError(['Content hash mismatch']);
      expect(category).toBe('hash_mismatch');
    });

    it('should categorize anchor mismatch errors', () => {
      const category = VerificationMetrics.categorizeError(['Anchor not found in file']);
      expect(category).toBe('anchor_mismatch');
    });

    it('should categorize file not found errors', () => {
      const category = VerificationMetrics.categorizeError(['File does not exist']);
      expect(category).toBe('file_not_found');
    });

    it('should return unknown for unrecognized errors', () => {
      const category = VerificationMetrics.categorizeError(['Some weird error']);
      expect(category).toBe('unknown');
    });

    it('should handle empty error array', () => {
      const category = VerificationMetrics.categorizeError([]);
      expect(category).toBe('unknown');
    });
  });
});
