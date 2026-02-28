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

import type { RunContext, ToolExecCtx, ToolOutput, ControlAction } from '@kb-labs/agent-sdk';

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
    }

    return 'continue';
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
      }
    }

    // Progress: successful tool with output resets the stuck counter
    if (result.success && result.output && result.output.length > 0) {
      this._iterationsSinceProgress = 0;
      this.callbacks.onProgress?.(ctx.iteration);
    }
  }

  reset(): void {
    this._iterationsSinceProgress = 0;
    this._recentToolCalls = [];
  }
}
