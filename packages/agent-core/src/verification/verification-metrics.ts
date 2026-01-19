/**
 * Verification Metrics - Track Verification System Performance
 *
 * Provides metrics collection for the 3-level verification system:
 * - Level 1: Structure validation (Zod)
 * - Level 2: Plugin schema validation
 * - Level 3: Filesystem state validation
 *
 * Part of the anti-hallucination verification system (ADR-0002).
 */

import type { PluginContextV3 } from '@kb-labs/sdk';

/**
 * Verification level
 */
export type VerificationLevel = 1 | 2 | 3;

/**
 * Verification result status
 */
export type VerificationStatus = 'passed' | 'failed';

/**
 * Verification error category
 */
export type VerificationErrorCategory =
  | 'missing_field'
  | 'invalid_type'
  | 'schema_mismatch'
  | 'filesystem_mismatch'
  | 'hash_mismatch'
  | 'anchor_mismatch'
  | 'file_not_found'
  | 'unknown';

/**
 * Verification metrics event
 */
export interface VerificationMetricsEvent {
  /** Specialist ID */
  specialistId: string;

  /** Subtask ID (if available) */
  subtaskId?: string;

  /** Verification level that was checked */
  level: VerificationLevel;

  /** Verification status */
  status: VerificationStatus;

  /** Error category (if failed) */
  errorCategory?: VerificationErrorCategory;

  /** Error details (if failed) */
  errorDetails?: string;

  /** Verification duration in milliseconds */
  durationMs: number;

  /** Timestamp */
  timestamp: number;
}

/**
 * Verification metrics aggregates
 */
export interface VerificationMetricsAggregates {
  /** Total verification checks */
  totalChecks: number;

  /** Checks by level */
  byLevel: {
    [level in VerificationLevel]: {
      total: number;
      passed: number;
      failed: number;
      avgDurationMs: number;
    };
  };

  /** Checks by specialist */
  bySpecialist: Record<string, {
    total: number;
    passed: number;
    failed: number;
  }>;

  /** Errors by category */
  errorsByCategory: Record<VerificationErrorCategory, number>;

  /** Overall pass rate */
  passRate: number;
}

/**
 * Verification metrics collector
 *
 * Tracks verification events and provides aggregates for A/B testing and analysis.
 */
export class VerificationMetrics {
  /** In-memory event buffer (last 1000 events) */
  private events: VerificationMetricsEvent[] = [];
  private readonly maxEvents = 1000;

  constructor(private ctx: PluginContextV3) {}

  /**
   * Record verification event
   *
   * @param event - Verification metrics event
   */
  record(event: VerificationMetricsEvent): void {
    // Add to buffer (FIFO with max size)
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Log as analytics event
    this.ctx.platform.logger.info('Verification metrics', {
      specialistId: event.specialistId,
      subtaskId: event.subtaskId,
      level: event.level,
      status: event.status,
      errorCategory: event.errorCategory,
      durationMs: event.durationMs,
      _metric: 'verification',
    });
  }

  /**
   * Get aggregated metrics
   *
   * @returns Aggregated verification metrics
   */
  getAggregates(): VerificationMetricsAggregates {
    const total = this.events.length;

    // Initialize aggregates
    const byLevel: VerificationMetricsAggregates['byLevel'] = {
      1: { total: 0, passed: 0, failed: 0, avgDurationMs: 0 },
      2: { total: 0, passed: 0, failed: 0, avgDurationMs: 0 },
      3: { total: 0, passed: 0, failed: 0, avgDurationMs: 0 },
    };

    const bySpecialist: Record<string, { total: number; passed: number; failed: number }> = {};
    const errorsByCategory: Record<VerificationErrorCategory, number> = {
      missing_field: 0,
      invalid_type: 0,
      schema_mismatch: 0,
      filesystem_mismatch: 0,
      hash_mismatch: 0,
      anchor_mismatch: 0,
      file_not_found: 0,
      unknown: 0,
    };

    let totalPassed = 0;

    // Aggregate events
    for (const event of this.events) {
      // By level
      byLevel[event.level].total++;
      if (event.status === 'passed') {
        byLevel[event.level].passed++;
        totalPassed++;
      } else {
        byLevel[event.level].failed++;
      }

      // By specialist
      if (!bySpecialist[event.specialistId]) {
        bySpecialist[event.specialistId] = { total: 0, passed: 0, failed: 0 };
      }
      const specialistStats = bySpecialist[event.specialistId]!;
      specialistStats.total++;
      if (event.status === 'passed') {
        specialistStats.passed++;
      } else {
        specialistStats.failed++;
      }

      // Errors by category
      if (event.errorCategory) {
        errorsByCategory[event.errorCategory]++;
      }
    }

    // Calculate average durations
    for (const level of [1, 2, 3] as const) {
      const levelEvents = this.events.filter(e => e.level === level);
      if (levelEvents.length > 0) {
        const totalDuration = levelEvents.reduce((sum, e) => sum + e.durationMs, 0);
        byLevel[level].avgDurationMs = Math.round(totalDuration / levelEvents.length);
      }
    }

    const passRate = total > 0 ? totalPassed / total : 0;

    return {
      totalChecks: total,
      byLevel,
      bySpecialist,
      errorsByCategory,
      passRate,
    };
  }

  /**
   * Clear metrics buffer
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Get recent events
   *
   * @param limit - Maximum number of events to return
   * @returns Recent verification events
   */
  getRecentEvents(limit: number = 100): VerificationMetricsEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Categorize error from validation errors
   *
   * Helper to map validation error messages to categories.
   *
   * @param errors - Validation error messages
   * @returns Error category
   */
  static categorizeError(errors: string[]): VerificationErrorCategory {
    const firstError = errors[0]?.toLowerCase() || '';

    if (firstError.includes('required') || firstError.includes('missing')) {
      return 'missing_field';
    }
    if (firstError.includes('type') || firstError.includes('expected')) {
      return 'invalid_type';
    }
    if (firstError.includes('schema')) {
      return 'schema_mismatch';
    }
    if (firstError.includes('hash')) {
      return 'hash_mismatch';
    }
    if (firstError.includes('anchor')) {
      return 'anchor_mismatch';
    }
    if (firstError.includes('not found') || firstError.includes('does not exist')) {
      return 'file_not_found';
    }
    if (firstError.includes('filesystem')) {
      return 'filesystem_mismatch';
    }

    return 'unknown';
  }
}
