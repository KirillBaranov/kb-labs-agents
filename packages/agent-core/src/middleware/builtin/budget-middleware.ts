/**
 * BudgetMiddleware — token budget enforcement and convergence nudging.
 *
 * Hook points:
 * - beforeIteration: check hard limit → return 'stop' if exceeded
 * - beforeLLMCall: inject convergence nudge at soft limit via LLMCallPatch
 *
 * Token counter is injected via a simple getter — the runner owns totalTokens
 * and passes a closure. Everything else (policy, nudge state) lives here.
 */

import type { RunContext, LLMCtx, LLMCallPatch, ControlAction } from '@kb-labs/agent-sdk';

export interface BudgetPolicy {
  active: boolean;
  maxTokens: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  hardStop: boolean;
  forceSynthesisOnHardLimit: boolean;
}

export class BudgetMiddleware {
  readonly name = 'budget';
  readonly order = 10;
  readonly config = { failPolicy: 'fail-closed' as const, timeoutMs: 2000 };

  private readonly policy: BudgetPolicy;
  private readonly getTokensUsed: () => number;
  private _convergenceNudgeSent = false;

  constructor(policy: BudgetPolicy, getTokensUsed: () => number) {
    this.policy = policy;
    this.getTokensUsed = getTokensUsed;
  }

  get convergenceNudgeSent(): boolean {
    return this._convergenceNudgeSent;
  }

  beforeIteration(ctx: RunContext): ControlAction {
    if (!this.policy.active || this.policy.maxTokens <= 0) {return 'continue';}

    const used = this.getTokensUsed();
    const hardLimit = this.policy.maxTokens * this.policy.hardLimitRatio;

    if (used >= hardLimit) {
      ctx.meta.set('budget', 'exhausted', true);
      ctx.meta.set('budget', 'exhaustedReason', `Token hard limit: ${used}/${hardLimit}`);

      if (this.policy.hardStop || this.policy.forceSynthesisOnHardLimit) {
        ctx.meta.set('budget', 'forceSynthesis', this.policy.forceSynthesisOnHardLimit);
        return 'stop';
      }
    }

    return 'continue';
  }

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    if (!this.policy.active || this.policy.maxTokens <= 0) {return undefined;}
    if (this._convergenceNudgeSent) {return undefined;}

    const used = this.getTokensUsed();
    const softLimit = this.policy.maxTokens * this.policy.softLimitRatio;

    if (used >= softLimit) {
      this._convergenceNudgeSent = true;
      ctx.run.meta.set('budget', 'convergenceNudgeSent', true);

      const utilPct = Math.round((used / this.policy.maxTokens) * 100);
      return {
        messages: [
          ...ctx.messages,
          {
            role: 'system' as const,
            content:
              `Token budget checkpoint: ${utilPct}% consumed. ` +
              `Start converging toward your final answer.`,
          },
        ],
      };
    }

    return undefined;
  }

  reset(): void {
    this._convergenceNudgeSent = false;
  }
}
