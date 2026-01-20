/**
 * Findings Store - хранит находки специалистов вне контекста оркестратора
 *
 * Phase 2: Adaptive Feedback Loop
 *
 * Архитектура:
 * - Полные findings хранятся в state broker (не в LLM промпте)
 * - Оркестратор видит только compact summary (top 3 + stats)
 * - TTL адаптивный: по умолчанию 24h, настраивается через env
 * - Cleanup при завершении сессии оркестратора
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type {
  AgentFinding,
  FindingsSummary,
  StoredFindings,
  FindingsRegistry,
} from './types.js';

/**
 * Findings Store with adaptive TTL and session-based cleanup
 */
export class FindingsStore {
  constructor(private ctx: PluginContextV3) {}

  /**
   * Save findings with adaptive TTL
   *
   * @param sessionId - Orchestrator session ID
   * @param subtaskId - Subtask ID
   * @param findings - Findings array
   * @param options - TTL options
   * @returns Reference ID (format: "findings:{sessionId}:{subtaskId}")
   */
  async save(
    sessionId: string,
    subtaskId: string,
    findings: AgentFinding[],
    options?: {
      customTTL?: number; // Custom TTL in ms (overrides defaults)
      maxDeadline?: number; // Max deadline (default: 7 days)
    }
  ): Promise<string> {
    const findingsId = `findings:${sessionId}:${subtaskId}`;

    // Calculate adaptive TTL
    const ttl = this.calculateTTL(sessionId, options);

    const data: StoredFindings = {
      sessionId,
      subtaskId,
      findings,
      timestamp: new Date().toISOString(),
      ttl,
    };

    await this.ctx.platform.cache.set(findingsId, data, ttl);

    // Register findings in session registry for cleanup
    await this.registerInSession(sessionId, findingsId);

    this.ctx.platform.logger.debug('Findings saved with adaptive TTL', {
      findingsId,
      count: findings.length,
      ttlMs: ttl,
      ttlHours: (ttl / (1000 * 60 * 60)).toFixed(2),
    });

    return findingsId;
  }

  /**
   * Load full findings by reference
   *
   * @param findingsRef - Reference ID (e.g., "findings:session-123:subtask-2")
   * @returns Findings array (empty if not found or expired)
   */
  async load(findingsRef: string): Promise<AgentFinding[]> {
    const data = await this.ctx.platform.cache.get<StoredFindings>(findingsRef);

    if (!data) {
      this.ctx.platform.logger.warn('Findings not found (possibly expired)', {
        findingsRef,
      });
      return [];
    }

    return data.findings;
  }

  /**
   * Create compact summary for orchestrator context
   *
   * CRITICAL: Keeps orchestrator context small!
   * Only top 3 most important findings + statistics
   *
   * @param findings - Full findings array
   * @returns Compact summary
   */
  createSummary(findings: AgentFinding[]): FindingsSummary {
    const bySeverity = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };

    const actionable = findings.filter((f) => f.actionable).length;

    // Select top 3 most important findings
    // Priority: critical > high > actionable > recent
    const topFindings = findings
      .sort((a, b) => {
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) return severityDiff;

        // If same severity, prioritize actionable
        if (a.actionable && !b.actionable) return -1;
        if (!a.actionable && b.actionable) return 1;

        return 0;
      })
      .slice(0, 3); // Max 3 findings in context

    return {
      total: findings.length,
      bySeverity,
      actionable,
      topFindings,
    };
  }

  /**
   * Calculate adaptive TTL based on context
   *
   * Strategy:
   * - Default: 24 hours (enough for long-running tasks)
   * - Configurable via env: KB_FINDINGS_TTL_HOURS
   * - Custom override via options
   * - Max deadline: prevent infinite storage
   *
   * @param sessionId - Session ID (for logging)
   * @param options - TTL options
   * @returns TTL in milliseconds
   */
  private calculateTTL(
    sessionId: string,
    options?: { customTTL?: number; maxDeadline?: number }
  ): number {
    // Custom TTL takes precedence
    if (options?.customTTL) {
      return Math.min(options.customTTL, options.maxDeadline || this.getDefaultMaxDeadline());
    }

    // Environment variable configuration
    const envTTLHours = process.env.KB_FINDINGS_TTL_HOURS;
    if (envTTLHours) {
      const ttlMs = parseInt(envTTLHours, 10) * 60 * 60 * 1000;
      if (!isNaN(ttlMs) && ttlMs > 0) {
        this.ctx.platform.logger.debug('Using TTL from KB_FINDINGS_TTL_HOURS', {
          hours: envTTLHours,
          ms: ttlMs,
        });
        return ttlMs;
      }
    }

    // Default: 24 hours (good for most tasks, even complex ones)
    return 24 * 60 * 60 * 1000;
  }

  /**
   * Get default max deadline from env or use fallback
   *
   * Default: 7 days (week) - reasonable upper bound
   *
   * @returns Max deadline in milliseconds
   */
  private getDefaultMaxDeadline(): number {
    const envMaxDays = process.env.KB_FINDINGS_MAX_DEADLINE_DAYS;
    if (envMaxDays) {
      const maxMs = parseInt(envMaxDays, 10) * 24 * 60 * 60 * 1000;
      if (!isNaN(maxMs) && maxMs > 0) {
        this.ctx.platform.logger.debug('Using max deadline from KB_FINDINGS_MAX_DEADLINE_DAYS', {
          days: envMaxDays,
          ms: maxMs,
        });
        return maxMs;
      }
    }

    // Default: 7 days
    return 7 * 24 * 60 * 60 * 1000;
  }

  /**
   * Register findings in session registry for cleanup
   *
   * Maintains a list of all findings IDs for this session
   * so we can clean them up when session ends
   *
   * @param sessionId - Session ID
   * @param findingsId - Findings reference ID to register
   */
  private async registerInSession(sessionId: string, findingsId: string): Promise<void> {
    const registryKey = `findings-registry:${sessionId}`;

    // Get existing registry
    const existing = await this.ctx.platform.cache.get<FindingsRegistry>(registryKey);

    const findingsIds = existing?.findingsIds || [];
    if (!findingsIds.includes(findingsId)) {
      findingsIds.push(findingsId);
    }

    const registry: FindingsRegistry = {
      sessionId,
      findingsIds,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };

    // Update registry with same TTL as max deadline
    await this.ctx.platform.cache.set(registryKey, registry, this.getDefaultMaxDeadline());
  }

  /**
   * Cleanup all findings for a session
   *
   * Call this when orchestrator session ends
   *
   * @param sessionId - Session to cleanup
   * @returns Number of findings cleaned up
   */
  async cleanupSession(sessionId: string): Promise<number> {
    const registryKey = `findings-registry:${sessionId}`;

    // Get all findings for this session
    const registry = await this.ctx.platform.cache.get<FindingsRegistry>(registryKey);

    if (!registry || !registry.findingsIds || registry.findingsIds.length === 0) {
      this.ctx.platform.logger.debug('No findings to cleanup', { sessionId });
      return 0;
    }

    // Delete all findings
    let cleaned = 0;
    for (const findingsId of registry.findingsIds) {
      await this.ctx.platform.cache.delete(findingsId);
      cleaned++;
    }

    // Delete registry itself
    await this.ctx.platform.cache.delete(registryKey);

    this.ctx.platform.logger.info('Session findings cleaned up', {
      sessionId,
      findingsCleaned: cleaned,
    });

    return cleaned;
  }
}
