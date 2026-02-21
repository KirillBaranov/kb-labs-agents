/**
 * Reflection Engine
 *
 * Decides when to trigger operational reflections, generates structured
 * reflections via an injected LLM callback, and tracks hypothesis switches.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflectionState {
  lastReflectionIteration: number;
  reflectionCount: number;
  hypothesisSwitches: number;
  lastReflectionHypothesis: string;
}

export interface ReflectionPayload {
  hypothesis: string;
  confidence: number;
  evidenceFor: string;
  evidenceAgainst: string;
  nextBestCheck: string;
  whyThisCheck: string;
}

export interface ReflectionResult extends ReflectionPayload {
  hypothesisSwitched: boolean;
  summaryMessage: string;
}

export interface ShouldTriggerInput {
  trigger: 'post_tools' | 'before_escalation' | 'before_no_result';
  iteration: number;
  failedToolsThisIteration: number;
  force: boolean;
  lastToolCalls: ReadonlyArray<string>;
  iterationsSinceProgress: number;
  stuckThreshold: number;
}

export interface RunReflectionInput {
  trigger: 'post_tools' | 'before_escalation' | 'before_no_result';
  iteration: number;
  toolCalls: ReadonlyArray<{ id: string; name: string }>;
  toolResults: ReadonlyArray<{ toolCallId?: string; content?: string | unknown }>;
  failedToolsThisIteration: number;
  force: boolean;
  escalationReason?: string;
  lastToolCalls: ReadonlyArray<string>;
  iterationsSinceProgress: number;
  stuckThreshold: number;
  task: string;
}

/**
 * Injected at construction — generates a reflection payload via LLM.
 * Returns null if LLM is unavailable or call fails.
 */
export type ReflectionGenerator = (input: {
  trigger: string;
  iteration: number;
  task: string;
  toolRows: string;
  failedToolsThisIteration: number;
  escalationReason?: string;
}) => Promise<ReflectionPayload | null>;

// ---------------------------------------------------------------------------
// ReflectionEngine
// ---------------------------------------------------------------------------

export class ReflectionEngine {
  readonly state: ReflectionState;
  private readonly generator: ReflectionGenerator;

  constructor(generator: ReflectionGenerator, initial?: Partial<ReflectionState>) {
    this.generator = generator;
    this.state = {
      lastReflectionIteration: initial?.lastReflectionIteration ?? 0,
      reflectionCount: initial?.reflectionCount ?? 0,
      hypothesisSwitches: initial?.hypothesisSwitches ?? 0,
      lastReflectionHypothesis: initial?.lastReflectionHypothesis ?? '',
    };
  }

  // ── Decision gate ──────────────────────────────────────────────────────

  shouldTriggerReflection(input: ShouldTriggerInput): boolean {
    if (input.force || input.trigger !== 'post_tools') {
      return true;
    }

    if (input.iteration <= 1) {
      return input.failedToolsThisIteration > 0;
    }

    if (input.iteration - this.state.lastReflectionIteration < 2) {
      return false;
    }

    const repeatedSingleTool =
      input.lastToolCalls.length >= 3
      && new Set(input.lastToolCalls.slice(-3)).size === 1;

    return (
      input.failedToolsThisIteration > 0
      || repeatedSingleTool
      || input.iterationsSinceProgress >= input.stuckThreshold - 1
    );
  }

  // ── Full reflection run ────────────────────────────────────────────────

  async maybeRunReflection(
    input: RunReflectionInput,
  ): Promise<ReflectionResult | null> {
    if (!this.shouldTriggerReflection(input)) {
      return null;
    }

    const toolRows = buildReflectionToolRows(input.toolCalls, input.toolResults);

    const payload = await this.generator({
      trigger: input.trigger,
      iteration: input.iteration,
      task: input.task,
      toolRows,
      failedToolsThisIteration: input.failedToolsThisIteration,
      escalationReason: input.escalationReason,
    });

    if (!payload) {
      return null;
    }

    const normalizedHypothesis = payload.hypothesis.trim().toLowerCase();
    let hypothesisSwitched = false;

    if (
      normalizedHypothesis
      && this.state.lastReflectionHypothesis
      && normalizedHypothesis !== this.state.lastReflectionHypothesis
    ) {
      this.state.hypothesisSwitches += 1;
      hypothesisSwitched = true;
    }

    if (normalizedHypothesis) {
      this.state.lastReflectionHypothesis = normalizedHypothesis;
    }
    this.state.lastReflectionIteration = input.iteration;
    this.state.reflectionCount += 1;

    const summaryMessage = formatReflectionSummary(
      input.iteration,
      input.trigger,
      payload,
    );

    return {
      ...payload,
      hypothesisSwitched,
      summaryMessage,
    };
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  reset(): void {
    this.state.lastReflectionIteration = 0;
    this.state.reflectionCount = 0;
    this.state.hypothesisSwitches = 0;
    this.state.lastReflectionHypothesis = '';
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function buildReflectionToolRows(
  toolCalls: ReadonlyArray<{ id: string; name: string }>,
  toolResults: ReadonlyArray<{ toolCallId?: string; content?: string | unknown }>,
  maxCalls = 6,
  maxContentChars = 360,
): string {
  return toolCalls
    .slice(-maxCalls)
    .map((toolCall) => {
      const result = toolResults.find((item) => item.toolCallId === toolCall.id);
      const content =
        typeof result?.content === 'string'
          ? result.content.slice(0, maxContentChars)
          : '';
      return `${toolCall.name}: ${content}`;
    })
    .join('\n');
}

export function formatReflectionSummary(
  iteration: number,
  trigger: string,
  payload: ReflectionPayload,
): string {
  return [
    `[Reflection @iter ${iteration}] trigger=${trigger}; confidence=${payload.confidence.toFixed(2)}`,
    `Hypothesis: ${payload.hypothesis}`,
    `Evidence+: ${payload.evidenceFor}`,
    `Evidence-: ${payload.evidenceAgainst}`,
    `Next check: ${payload.nextBestCheck}`,
    `Why: ${payload.whyThisCheck}`,
  ].join('\n');
}
