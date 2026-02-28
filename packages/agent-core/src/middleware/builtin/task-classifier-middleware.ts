/**
 * TaskClassifierMiddleware — intent inference and scope extraction.
 *
 * Feature-flagged: enabled when FeatureFlags.taskClassifier is true.
 * Runs first (order=5) — classification informs other middlewares.
 */

import type { FeatureFlags } from '@kb-labs/agent-contracts';
import type { RunContext } from '@kb-labs/agent-sdk';

export type TaskIntent = 'action' | 'discovery' | 'analysis';

export interface TaskClassification {
  intent: TaskIntent;
  scope?: string;
  confidence: number;
}

const ACTION_PATTERNS    = /\b(create|add|fix|update|delete|remove|implement|write|modify|change|refactor|rename)\b/i;
const DISCOVERY_PATTERNS = /\b(find|search|locate|where|what|show|list|explain|describe|how does)\b/i;
const ANALYSIS_PATTERNS  = /\b(analyze|review|audit|check|compare|evaluate|assess|benchmark|profile)\b/i;

export interface TaskClassifierCallbacks {
  onClassified?: (classification: TaskClassification) => void;
}

export class TaskClassifierMiddleware {
  readonly name = 'task-classifier';
  readonly order = 5;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 3000 };

  private readonly callbacks: TaskClassifierCallbacks;
  private _classification: TaskClassification | null = null;
  private _featureFlags?: FeatureFlags;

  constructor(callbacks: TaskClassifierCallbacks = {}) {
    this.callbacks = callbacks;
  }

  enabled(): boolean {
    return this._featureFlags?.taskClassifier ?? false;
  }

  withFeatureFlags(flags: FeatureFlags): this {
    this._featureFlags = flags;
    return this;
  }

  get classification(): TaskClassification | null {
    return this._classification;
  }

  onStart(ctx: RunContext): void {
    const classification = this.classifyHeuristic(ctx.task);
    this._classification = classification;
    ctx.meta.set('classifier', 'intent', classification.intent);
    ctx.meta.set('classifier', 'confidence', classification.confidence);
    this.callbacks.onClassified?.(classification);
  }

  private classifyHeuristic(task: string): TaskClassification {
    const hasAction    = ACTION_PATTERNS.test(task);
    const hasDiscovery = DISCOVERY_PATTERNS.test(task);
    const hasAnalysis  = ANALYSIS_PATTERNS.test(task);

    let intent: TaskIntent;
    let confidence: number;

    if (hasAction && !hasDiscovery && !hasAnalysis) {
      intent = 'action'; confidence = 0.8;
    } else if (hasAnalysis && !hasAction) {
      intent = 'analysis'; confidence = 0.8;
    } else if (hasDiscovery && !hasAction && !hasAnalysis) {
      intent = 'discovery'; confidence = 0.8;
    } else if (hasAction && (hasDiscovery || hasAnalysis)) {
      intent = 'action'; confidence = 0.5;
    } else {
      intent = 'action'; confidence = 0.3;
    }

    return { intent, confidence };
  }

  reset(): void {
    this._classification = null;
  }
}
