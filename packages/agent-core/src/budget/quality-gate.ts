/**
 * Quality gate evaluation for agent runs.
 *
 * Pure logic — takes a snapshot, returns a verdict. No side effects.
 */

export interface QualityGateInput {
  toolsUsedCount: ReadonlyMap<string, number>;
  filesRead: ReadonlySet<string>;
  filesModified: ReadonlySet<string>;
  filesCreated: ReadonlySet<string>;
  toolErrorCount: number;
  touchedDomains: ReadonlySet<string>;
  searchSignalHits: number;
  taskLedger: { getSummary(): { failedSteps: number; pendingSteps: number } };
  currentTask: string | undefined;
  iterationsUsed: number;
}

export interface QualityGateResult {
  status: 'pass' | 'partial';
  score: number;
  reasons: string[];
  nextChecks?: string[];
}

export class QualityGate {
  evaluate(input: QualityGateInput): QualityGateResult {
    const reasons: string[] = [];
    let score = 1;

    const toolCallsTotal = sumMapValues(input.toolsUsedCount);
    const todoToolCalls =
      (input.toolsUsedCount.get('todo_create') ?? 0) +
      (input.toolsUsedCount.get('todo_update') ?? 0) +
      (input.toolsUsedCount.get('todo_get') ?? 0);
    const driftDomainCount = input.touchedDomains.size;
    const driftRate = toolCallsTotal > 0 ? Math.max(0, driftDomainCount - 1) / toolCallsTotal : 0;
    const evidenceCount =
      input.filesRead.size + input.filesModified.size + input.filesCreated.size;
    const evidenceDensity =
      input.iterationsUsed > 0 ? evidenceCount / input.iterationsUsed : 0;
    const toolErrorRate = toolCallsTotal > 0 ? input.toolErrorCount / toolCallsTotal : 0;
    const ledgerSummary = input.taskLedger.getSummary();

    if (toolErrorRate >= 0.3) {
      reasons.push(`high tool error rate (${(toolErrorRate * 100).toFixed(0)}%)`);
      score -= 0.35;
    }
    if (driftRate >= 0.2 && driftDomainCount >= 2) {
      reasons.push(`scope drift detected (${driftDomainCount} domains)`);
      score -= 0.25;
    }
    if (evidenceDensity < 0.2 && toolCallsTotal >= 5) {
      if (input.searchSignalHits === 0) {
        reasons.push('low evidence density');
        score -= 0.2;
      } else {
        reasons.push(
          'evidence mostly from search matches; direct verification remains limited'
        );
        score -= 0.08;
      }
    }
    if (
      input.currentTask &&
      isLikelyMultiStepTask(input.currentTask) &&
      input.iterationsUsed >= 5 &&
      todoToolCalls === 0
    ) {
      reasons.push('missing progress tracking on multi-step task');
      score -= 0.15;
    }
    if (ledgerSummary.failedSteps > 0) {
      reasons.push(`${ledgerSummary.failedSteps} failed execution step(s)`);
      score -= 0.2;
    }
    if (ledgerSummary.pendingSteps > 0) {
      reasons.push(`${ledgerSummary.pendingSteps} pending step(s) at completion`);
      score -= 0.1;
    }

    score = Math.max(0, score);

    const result: QualityGateResult = {
      status: score >= 0.55 ? 'pass' : 'partial',
      score,
      reasons,
    };
    if (result.status === 'partial') {
      result.nextChecks = suggestNextChecks(reasons);
    }
    return result;
  }

  /**
   * Whether the agent should receive a convergence nudge.
   */
  shouldNudgeConvergence(input: {
    iteration: number;
    maxIterations: number;
    task: string;
    filesModified: ReadonlySet<string>;
    filesCreated: ReadonlySet<string>;
    toolsUsedCount: ReadonlyMap<string, number>;
  }): boolean {
    if (input.maxIterations <= 6 || input.iteration < 4) {
      return false;
    }
    const taskLooksActionHeavy =
      /(create|implement|fix|patch|write|edit|add|удали|создай|исправ|добав)/i.test(input.task);
    if (
      taskLooksActionHeavy &&
      input.filesModified.size === 0 &&
      input.filesCreated.size === 0
    ) {
      return false;
    }
    const totalToolCalls = sumMapValues(input.toolsUsedCount);
    return totalToolCalls >= 4;
  }

  /**
   * Detect if the agent is stuck (repeating tools or no progress).
   */
  detectStuck(progress: {
    lastToolCalls: readonly string[];
    iterationsSinceProgress: number;
    stuckThreshold: number;
  }): boolean {
    if (progress.lastToolCalls.length >= 3) {
      const lastThree = progress.lastToolCalls.slice(-3);
      if (new Set(lastThree).size === 1) {
        return true;
      }
    }
    if (progress.iterationsSinceProgress >= progress.stuckThreshold) {
      return true;
    }
    return false;
  }

  /**
   * Whether broad exploration should be restricted (cost-aware mode).
   */
  hasStrongEvidenceSignal(input: {
    toolsUsedCount: ReadonlyMap<string, number>;
    filesRead: ReadonlySet<string>;
    filesModified: ReadonlySet<string>;
    filesCreated: ReadonlySet<string>;
    touchedDomains: ReadonlySet<string>;
    toolErrorCount: number;
    iterationsUsed: number;
  }): boolean {
    const toolCallsTotal = sumMapValues(input.toolsUsedCount);
    const evidenceCount =
      input.filesRead.size + input.filesModified.size + input.filesCreated.size;
    const evidenceDensity =
      input.iterationsUsed > 0 ? evidenceCount / input.iterationsUsed : 0;
    const driftRate =
      toolCallsTotal > 0
        ? Math.max(0, input.touchedDomains.size - 1) / toolCallsTotal
        : 0;
    const toolErrorRate = toolCallsTotal > 0 ? input.toolErrorCount / toolCallsTotal : 0;

    return (
      evidenceCount >= 3 &&
      evidenceDensity >= 0.55 &&
      driftRate <= 0.08 &&
      toolErrorRate <= 0.1
    );
  }

  /**
   * Build a summary with clarification notes when quality is partial.
   */
  buildNeedsClarificationSummary(
    originalSummary: string,
    gate: { reasons: string[]; nextChecks?: string[] }
  ): string {
    const nextChecks =
      gate.nextChecks && gate.nextChecks.length > 0
        ? gate.nextChecks
        : ['Run one focused verification pass and provide evidence-backed findings.'];
    const reasons = gate.reasons.length > 0 ? gate.reasons : ['insufficient confidence'];
    return `${originalSummary}

[Needs Clarification]
- Confidence: partial
- Reasons: ${reasons.join('; ')}
- Next checks:
${nextChecks.map((item) => `  - ${item}`).join('\n')}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function sumMapValues(map: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const v of map.values()) {
    sum += v;
  }
  return sum;
}

function isLikelyMultiStepTask(task: string): boolean {
  return /(пошаг|step-by-step|steps|checklist|проверь|investigate|analyze|refactor|implement|migration|audit)/i.test(
    task
  );
}

function suggestNextChecks(reasons: string[]): string[] {
  const checks: string[] = [];
  for (const reason of reasons) {
    const normalized = reason.toLowerCase();
    if (normalized.includes('drift')) {
      checks.push('Restrict scope to the primary target and rerun focused discovery.');
    } else if (normalized.includes('evidence')) {
      checks.push(
        'Collect concrete evidence from relevant resources before final response.'
      );
    } else if (normalized.includes('tool error')) {
      checks.push(
        'Retry failed tool steps or use alternate capabilities for the same goal.'
      );
    } else if (normalized.includes('progress tracking')) {
      checks.push(
        'Create/update progress checklist and confirm completion before reporting.'
      );
    } else if (
      normalized.includes('failed execution') ||
      normalized.includes('pending step')
    ) {
      checks.push('Resolve failed or pending execution steps before finalizing.');
    }
  }
  return Array.from(new Set(checks)).slice(0, 4);
}
