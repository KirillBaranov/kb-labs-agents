/**
 * ProgressMiddleware — stuck detection and loop detection.
 *
 * Hook points:
 * - beforeIteration: detect stuck state (too many iterations without progress)
 * - afterToolExec: reset counter on successful tool, detect repeated call loops
 *
 * All state lives here. Callbacks are optional observers (for logging/telemetry).
 * fail-open: progress tracking errors never break execution.
 */

import type { RunContext, LLMCtx, LLMCallPatch, ToolExecCtx, ToolOutput, ControlAction } from '@kb-labs/agent-sdk';

export interface ProgressCallbacks {
  onProgress?: (iteration: number) => void;
  onStuck?: (iteration: number, iterationsSinceProgress: number) => void;
  onLoop?: (iteration: number, repeatedCalls: string[]) => void;
}

export class ProgressMiddleware {
  readonly name = 'progress';
  readonly order = 50;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 2000 };

  private readonly stuckThreshold: number;
  private readonly callbacks: ProgressCallbacks;
  private _iterationsSinceProgress = 0;
  private _recentToolCalls: string[] = [];
  private _lastIterNudgeSent = false;
  /** Tracks which stuck nudge level was last sent (0 = none) */
  private _stuckNudgeLevel = 0;

  constructor(stuckThreshold = 4, callbacks: ProgressCallbacks = {}) {
    this.stuckThreshold = stuckThreshold;
    this.callbacks = callbacks;
  }

  get iterationsSinceProgress(): number {
    return this._iterationsSinceProgress;
  }

  get isStuck(): boolean {
    return this._iterationsSinceProgress >= this.stuckThreshold;
  }

  beforeIteration(ctx: RunContext): ControlAction {
    this._iterationsSinceProgress++;

    if (this.isStuck) {
      ctx.meta.set('progress', 'isStuck', true);
      ctx.meta.set('progress', 'iterationsSinceProgress', this._iterationsSinceProgress);
      this.callbacks.onStuck?.(ctx.iteration, this._iterationsSinceProgress);
      ctx.eventBus.emit('middleware:event', {
        name: 'progress',
        event: 'stuck',
        data: { iteration: ctx.iteration, iterationsSinceProgress: this._iterationsSinceProgress },
      });
    }

    return 'continue';
  }

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    if (this._lastIterNudgeSent) {return undefined;}

    const { iteration, maxIterations } = ctx.run;
    // Fire on the last iteration (agent has no more turns after this)
    if (iteration >= maxIterations) {
      this._lastIterNudgeSent = true;
      ctx.run.eventBus.emit('middleware:event', {
        name: 'progress',
        event: 'last_iteration_nudge',
        data: { iteration, maxIterations },
      });
      return {
        messages: [
          ...ctx.messages,
          {
            role: 'system' as const,
            content:
              `⚠️ FINAL ITERATION (${iteration}/${maxIterations}): You MUST call the \`report\` tool now with your complete final answer. No other tool calls are allowed.`,
          },
        ],
        toolChoice: { type: 'function' as const, function: { name: 'report' } },
      };
    }

    // ── Graduated stuck recovery nudges ──────────────────────────────
    // Level 1: gentle suggestion at stuckThreshold (default 4)
    // Level 2: stronger guidance at stuckThreshold + 2
    // Level 3: forced convergence at stuckThreshold + 4
    const sinceProgress = this._iterationsSinceProgress;

    if (sinceProgress >= this.stuckThreshold && this._stuckNudgeLevel < 3) {
      const level3Threshold = this.stuckThreshold + 4;
      const level2Threshold = this.stuckThreshold + 2;

      if (sinceProgress >= level3Threshold && this._stuckNudgeLevel < 3) {
        this._stuckNudgeLevel = 3;
        ctx.run.eventBus.emit('middleware:event', {
          name: 'progress',
          event: 'stuck_nudge',
          data: { level: 3, iteration, sinceProgress },
        });
        return {
          messages: [
            ...ctx.messages,
            {
              role: 'user' as const,
              content:
                `⚠️ STUCK (${sinceProgress} iterations without progress): You MUST either call \`report\` with whatever findings you have, or call \`ask_user\` for help. Do not continue your current approach — it is not working.`,
            },
          ],
          toolChoice: { type: 'function' as const, function: { name: 'report' } },
        };
      }

      if (sinceProgress >= level2Threshold && this._stuckNudgeLevel < 2) {
        this._stuckNudgeLevel = 2;
        ctx.run.eventBus.emit('middleware:event', {
          name: 'progress',
          event: 'stuck_nudge',
          data: { level: 2, iteration, sinceProgress },
        });
        return {
          messages: [
            ...ctx.messages,
            {
              role: 'user' as const,
              content:
                `⚠️ Still stuck (${sinceProgress} iterations without new evidence). Consider: (1) call \`report\` with partial results, (2) call \`ask_user\` for clarification, (3) narrow your scope and try a simpler approach.`,
            },
          ],
        };
      }

      if (this._stuckNudgeLevel < 1) {
        this._stuckNudgeLevel = 1;
        ctx.run.eventBus.emit('middleware:event', {
          name: 'progress',
          event: 'stuck_nudge',
          data: { level: 1, iteration, sinceProgress },
        });
        return {
          messages: [
            ...ctx.messages,
            {
              role: 'user' as const,
              content:
                `⚠️ No progress in ${sinceProgress} iterations. Try a different approach: use different search terms, explore different files, or simplify your goal.`,
            },
          ],
        };
      }
    }

    // ── Loop detection nudge ─────────────────────────────────────────
    const loopDetected = ctx.run.meta.get<boolean>('progress', 'loopDetected');
    if (loopDetected) {
      // Clear the flag so we don't re-nudge every iteration
      ctx.run.meta.set('progress', 'loopDetected', false);
      return {
        messages: [
          ...ctx.messages,
          {
            role: 'user' as const,
            content:
              '⚠️ Loop detected: you are repeating the same tool calls. Stop and try a completely different strategy, or call `report` with your current findings.',
          },
        ],
      };
    }

    return undefined;
  }

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    const sig = `${ctx.toolName}:${JSON.stringify(ctx.input)}`;
    this._recentToolCalls.push(sig);
    if (this._recentToolCalls.length > 6) {
      this._recentToolCalls.shift();
    }

    // Loop detection: same 3 calls repeated twice
    if (this._recentToolCalls.length >= 6) {
      const last3 = this._recentToolCalls.slice(-3).join('|');
      const prev3 = this._recentToolCalls.slice(-6, -3).join('|');
      if (last3 === prev3) {
        const repeatedCalls = this._recentToolCalls.slice(-3).map((s) => s.split(':')[0] ?? s);
        ctx.run.meta.set('progress', 'loopDetected', true);
        ctx.run.meta.set('progress', 'repeatedCalls', repeatedCalls);
        this.callbacks.onLoop?.(ctx.iteration, repeatedCalls);
        ctx.run.eventBus.emit('middleware:event', {
          name: 'progress',
          event: 'loop_detected',
          data: { iteration: ctx.iteration, repeatedCalls },
        });
      }
    }

    // Progress: successful tool with output resets the stuck counter
    if (result.success && result.output && result.output.length > 0) {
      this._iterationsSinceProgress = 0;
      this._stuckNudgeLevel = 0;
      this.callbacks.onProgress?.(ctx.iteration);
    }
  }

  reset(): void {
    this._iterationsSinceProgress = 0;
    this._recentToolCalls = [];
    this._lastIterNudgeSent = false;
    this._stuckNudgeLevel = 0;
  }
}
