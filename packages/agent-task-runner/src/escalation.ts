/**
 * Phase 3: Universal Task Runner - Escalation Rules
 *
 * Determines when to ask human for help
 */

import type { EscalationRules, StepResult, TaskCheckpoint, VerificationDecision } from './types.js';

export interface EscalationConfig {
  /**
   * Escalation rules
   */
  rules?: Partial<EscalationRules>;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class EscalationManager {
  private rules: EscalationRules;
  private verbose: boolean;

  constructor(config: EscalationConfig = {}) {
    this.rules = {
      maxRetries: config.rules?.maxRetries ?? 3,
      costThreshold: config.rules?.costThreshold ?? 5.0, // $5 default
      durationThreshold: config.rules?.durationThreshold ?? 1800000, // 30 minutes default
      minConfidence: config.rules?.minConfidence ?? 0.7,
      alwaysEscalate: config.rules?.alwaysEscalate ?? [
        'delete database',
        'drop table',
        'rm -rf',
        'force push',
        'production deploy',
      ],
    };

    this.verbose = config.verbose ?? false;
  }

  /**
   * Check if we should escalate based on checkpoint state
   */
  shouldEscalate(checkpoint: TaskCheckpoint, decision: VerificationDecision, retryCount: number): boolean {
    // 1. Verification decision says escalate
    if (decision.verdict === 'escalate') {
      this.log(`⚠️  Escalation: Verifier recommends escalation (${decision.escalationReason})`);
      return true;
    }

    // 2. Max retries exceeded
    if (retryCount >= this.rules.maxRetries) {
      this.log(`⚠️  Escalation: Max retries exceeded (${retryCount}/${this.rules.maxRetries})`);
      return true;
    }

    // 3. Confidence too low
    if (decision.confidence < this.rules.minConfidence) {
      this.log(`⚠️  Escalation: Confidence too low (${decision.confidence} < ${this.rules.minConfidence})`);
      return true;
    }

    // 4. Cost threshold exceeded
    if (checkpoint.costUsd >= this.rules.costThreshold) {
      this.log(`⚠️  Escalation: Cost threshold exceeded ($${checkpoint.costUsd} >= $${this.rules.costThreshold})`);
      return true;
    }

    // 5. Duration threshold exceeded
    if (checkpoint.elapsedMs >= this.rules.durationThreshold) {
      this.log(
        `⚠️  Escalation: Duration threshold exceeded (${checkpoint.elapsedMs}ms >= ${this.rules.durationThreshold}ms)`
      );
      return true;
    }

    // 6. Always-escalate patterns
    const planText = JSON.stringify(checkpoint.plan).toLowerCase();
    for (const pattern of this.rules.alwaysEscalate) {
      if (planText.includes(pattern.toLowerCase())) {
        this.log(`⚠️  Escalation: High-risk pattern detected (${pattern})`);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if step result requires escalation (before verification)
   */
  shouldEscalateBeforeVerification(result: StepResult): boolean {
    // Escalate if step failed with critical errors
    if (result.status === 'failed' && result.errors && result.errors.length > 0) {
      const hasCriticalError = result.errors.some((err) => {
        const errLower = err.toLowerCase();
        return (
          errLower.includes('fatal') ||
          errLower.includes('critical') ||
          errLower.includes('unrecoverable') ||
          errLower.includes('permission denied')
        );
      });

      if (hasCriticalError) {
        this.log(`⚠️  Escalation: Critical error in step result`);
        return true;
      }
    }

    return false;
  }

  /**
   * Build escalation message for human
   */
  buildEscalationMessage(checkpoint: TaskCheckpoint, decision: VerificationDecision, retryCount: number): string {
    const parts: string[] = [];

    parts.push('🚨 **Task requires human decision**\n');

    parts.push(`**Task ID:** ${checkpoint.taskId}`);
    parts.push(`**Current Step:** ${checkpoint.currentStep ?? 'N/A'}`);
    parts.push(`**Steps Completed:** ${checkpoint.completedSteps.length}/${checkpoint.plan.steps.length}`);
    parts.push(`**Elapsed Time:** ${Math.round(checkpoint.elapsedMs / 1000)}s`);
    parts.push(`**Cost So Far:** $${checkpoint.costUsd.toFixed(2)}`);
    parts.push(`**Retry Count:** ${retryCount}`);
    parts.push('');

    if (checkpoint.currentStep !== null) {
      const currentStepInfo = checkpoint.plan.steps.find((s) => s.stepNumber === checkpoint.currentStep);
      if (currentStepInfo) {
        parts.push(`**Current Step:** ${currentStepInfo.description}`);
        parts.push('');
      }
    }

    parts.push(`**Verifier Decision:** ${decision.verdict}`);
    parts.push(`**Confidence:** ${decision.confidence}`);
    parts.push(`**Reasoning:** ${decision.reasoning}`);
    parts.push('');

    if (decision.escalationReason) {
      parts.push(`**Escalation Reason:** ${decision.escalationReason}`);
      parts.push('');
    }

    const lastStep = checkpoint.completedSteps[checkpoint.completedSteps.length - 1];
    if (lastStep) {
      parts.push(`**Last Step Result:**`);
      parts.push(`- Status: ${lastStep.status}`);
      parts.push(`- Output: ${lastStep.output.slice(0, 300)}${lastStep.output.length > 300 ? '...' : ''}`);

      if (lastStep.errors && lastStep.errors.length > 0) {
        parts.push(`- Errors: ${lastStep.errors.join('; ')}`);
      }

      parts.push('');
    }

    parts.push('**What do you want to do?**');
    parts.push('1. Continue (proceed to next step)');
    parts.push('2. Retry (try current step again)');
    parts.push('3. Abort (stop task execution)');
    parts.push('4. Adjust plan (modify remaining steps)');

    return parts.join('\n');
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }
}
