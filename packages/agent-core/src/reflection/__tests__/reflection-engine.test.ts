import { describe, it, expect, vi } from 'vitest';
import {
  ReflectionEngine,
  buildReflectionToolRows,
  formatReflectionSummary,
} from '../reflection-engine';
import type {
  ReflectionGenerator,
  ReflectionPayload,
  RunReflectionInput,
} from '../reflection-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<ReflectionPayload> = {}): ReflectionPayload {
  return {
    hypothesis: 'The bug is in parser module',
    confidence: 0.75,
    evidenceFor: 'Error trace points to parser',
    evidenceAgainst: 'Tests pass locally',
    nextBestCheck: 'Read parser.ts line 42',
    whyThisCheck: 'Error trace originates there',
    ...overrides,
  };
}

function makeGenerator(result: ReflectionPayload | null = makePayload()): ReflectionGenerator {
  return vi.fn().mockResolvedValue(result);
}

function makeRunInput(overrides: Partial<RunReflectionInput> = {}): RunReflectionInput {
  return {
    trigger: 'post_tools',
    iteration: 3,
    toolCalls: [{ id: '1', name: 'grep_search' }],
    toolResults: [{ toolCallId: '1', content: 'found something' }],
    failedToolsThisIteration: 0,
    force: false,
    lastToolCalls: ['grep_search', 'fs_read', 'grep_search'],
    iterationsSinceProgress: 1,
    stuckThreshold: 3,
    task: 'find the bug',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure: buildReflectionToolRows
// ---------------------------------------------------------------------------

describe('buildReflectionToolRows', () => {
  it('formats tool calls with results', () => {
    const result = buildReflectionToolRows(
      [{ id: '1', name: 'grep_search' }, { id: '2', name: 'fs_read' }],
      [{ toolCallId: '1', content: 'found: src/a.ts' }, { toolCallId: '2', content: 'file contents' }],
    );
    expect(result).toBe('grep_search: found: src/a.ts\nfs_read: file contents');
  });

  it('handles missing results gracefully', () => {
    const result = buildReflectionToolRows(
      [{ id: '1', name: 'grep_search' }],
      [],
    );
    expect(result).toBe('grep_search: ');
  });

  it('limits to last maxCalls (default 6)', () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `tool_${i}` }));
    const results = calls.map((c) => ({ toolCallId: c.id, content: 'x' }));
    const rows = buildReflectionToolRows(calls, results);
    expect(rows.split('\n')).toHaveLength(6);
    // Should contain the last 6 (tool_4 through tool_9)
    expect(rows).toContain('tool_4');
    expect(rows).toContain('tool_9');
    expect(rows).not.toContain('tool_3');
  });

  it('truncates content to maxContentChars', () => {
    const longContent = 'x'.repeat(1000);
    const result = buildReflectionToolRows(
      [{ id: '1', name: 'tool' }],
      [{ toolCallId: '1', content: longContent }],
      6,
      100,
    );
    expect(result).toBe(`tool: ${'x'.repeat(100)}`);
  });

  it('handles non-string content as empty', () => {
    const result = buildReflectionToolRows(
      [{ id: '1', name: 'tool' }],
      [{ toolCallId: '1', content: { nested: true } }],
    );
    expect(result).toBe('tool: ');
  });
});

// ---------------------------------------------------------------------------
// Pure: formatReflectionSummary
// ---------------------------------------------------------------------------

describe('formatReflectionSummary', () => {
  it('formats all fields', () => {
    const summary = formatReflectionSummary(5, 'post_tools', makePayload({ confidence: 0.8 }));
    expect(summary).toContain('[Reflection @iter 5]');
    expect(summary).toContain('trigger=post_tools');
    expect(summary).toContain('confidence=0.80');
    expect(summary).toContain('Hypothesis: The bug is in parser module');
    expect(summary).toContain('Evidence+: Error trace points to parser');
    expect(summary).toContain('Evidence-: Tests pass locally');
    expect(summary).toContain('Next check: Read parser.ts line 42');
    expect(summary).toContain('Why: Error trace originates there');
  });

  it('formats confidence to 2 decimal places', () => {
    const summary = formatReflectionSummary(1, 'before_escalation', makePayload({ confidence: 0.333 }));
    expect(summary).toContain('confidence=0.33');
  });
});

// ---------------------------------------------------------------------------
// Class: ReflectionEngine
// ---------------------------------------------------------------------------

describe('ReflectionEngine', () => {
  describe('constructor', () => {
    it('initializes with default state', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(engine.state).toEqual({
        lastReflectionIteration: 0,
        reflectionCount: 0,
        hypothesisSwitches: 0,
        lastReflectionHypothesis: '',
      });
    });

    it('accepts initial state overrides', () => {
      const engine = new ReflectionEngine(makeGenerator(), {
        reflectionCount: 3,
        lastReflectionIteration: 5,
      });
      expect(engine.state.reflectionCount).toBe(3);
      expect(engine.state.lastReflectionIteration).toBe(5);
    });
  });

  describe('shouldTriggerReflection', () => {
    it('returns true when force is set', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 1,
          failedToolsThisIteration: 0,
          force: true,
          lastToolCalls: [],
          iterationsSinceProgress: 0,
          stuckThreshold: 3,
        }),
      ).toBe(true);
    });

    it('returns true for non-post_tools triggers', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(
        engine.shouldTriggerReflection({
          trigger: 'before_escalation',
          iteration: 1,
          failedToolsThisIteration: 0,
          force: false,
          lastToolCalls: [],
          iterationsSinceProgress: 0,
          stuckThreshold: 3,
        }),
      ).toBe(true);
    });

    it('triggers on iteration 1 only if tools failed', () => {
      const engine = new ReflectionEngine(makeGenerator());
      const base = {
        trigger: 'post_tools' as const,
        force: false,
        lastToolCalls: [] as string[],
        iterationsSinceProgress: 0,
        stuckThreshold: 3,
      };

      expect(engine.shouldTriggerReflection({ ...base, iteration: 1, failedToolsThisIteration: 0 })).toBe(false);
      expect(engine.shouldTriggerReflection({ ...base, iteration: 1, failedToolsThisIteration: 1 })).toBe(true);
    });

    it('skips when fewer than 2 iterations since last reflection', () => {
      const engine = new ReflectionEngine(makeGenerator(), { lastReflectionIteration: 3 });
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 4,
          failedToolsThisIteration: 1,
          force: false,
          lastToolCalls: [],
          iterationsSinceProgress: 0,
          stuckThreshold: 3,
        }),
      ).toBe(false);
    });

    it('triggers on failed tools after cooldown', () => {
      const engine = new ReflectionEngine(makeGenerator(), { lastReflectionIteration: 1 });
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 4,
          failedToolsThisIteration: 2,
          force: false,
          lastToolCalls: [],
          iterationsSinceProgress: 0,
          stuckThreshold: 3,
        }),
      ).toBe(true);
    });

    it('triggers on repeated single tool', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 5,
          failedToolsThisIteration: 0,
          force: false,
          lastToolCalls: ['grep_search', 'grep_search', 'grep_search'],
          iterationsSinceProgress: 0,
          stuckThreshold: 3,
        }),
      ).toBe(true);
    });

    it('triggers when near stuck threshold', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 5,
          failedToolsThisIteration: 0,
          force: false,
          lastToolCalls: ['a', 'b', 'c'],
          iterationsSinceProgress: 2,
          stuckThreshold: 3,
        }),
      ).toBe(true);
    });

    it('does not trigger when none of the conditions met', () => {
      const engine = new ReflectionEngine(makeGenerator());
      expect(
        engine.shouldTriggerReflection({
          trigger: 'post_tools',
          iteration: 5,
          failedToolsThisIteration: 0,
          force: false,
          lastToolCalls: ['a', 'b', 'c'],
          iterationsSinceProgress: 0,
          stuckThreshold: 5,
        }),
      ).toBe(false);
    });
  });

  describe('maybeRunReflection', () => {
    it('returns null when trigger conditions not met', async () => {
      const engine = new ReflectionEngine(makeGenerator());
      const result = await engine.maybeRunReflection(
        makeRunInput({ iteration: 1, failedToolsThisIteration: 0 }),
      );
      expect(result).toBeNull();
    });

    it('returns null when generator returns null', async () => {
      const engine = new ReflectionEngine(makeGenerator(null));
      const result = await engine.maybeRunReflection(makeRunInput({ force: true }));
      expect(result).toBeNull();
    });

    it('returns ReflectionResult on success', async () => {
      const engine = new ReflectionEngine(makeGenerator());
      const result = await engine.maybeRunReflection(makeRunInput({ force: true }));
      expect(result).not.toBeNull();
      expect(result!.hypothesis).toBe('The bug is in parser module');
      expect(result!.confidence).toBe(0.75);
      expect(result!.summaryMessage).toContain('[Reflection @iter 3]');
    });

    it('updates state after successful reflection', async () => {
      const engine = new ReflectionEngine(makeGenerator());
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 5 }));
      expect(engine.state.lastReflectionIteration).toBe(5);
      expect(engine.state.reflectionCount).toBe(1);
      expect(engine.state.lastReflectionHypothesis).toBe('the bug is in parser module');
    });

    it('tracks hypothesis switches', async () => {
      const gen = vi.fn()
        .mockResolvedValueOnce(makePayload({ hypothesis: 'Bug in parser' }))
        .mockResolvedValueOnce(makePayload({ hypothesis: 'Bug in lexer' }));

      const engine = new ReflectionEngine(gen);
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 1 }));
      expect(engine.state.hypothesisSwitches).toBe(0);

      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 3 }));
      expect(engine.state.hypothesisSwitches).toBe(1);
    });

    it('does not count same hypothesis as switch', async () => {
      const engine = new ReflectionEngine(makeGenerator(makePayload({ hypothesis: 'Bug in parser' })));
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 1 }));
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 3 }));
      expect(engine.state.hypothesisSwitches).toBe(0);
    });

    it('normalizes hypothesis for comparison (trim+lowercase)', async () => {
      const gen = vi.fn()
        .mockResolvedValueOnce(makePayload({ hypothesis: '  Bug In Parser  ' }))
        .mockResolvedValueOnce(makePayload({ hypothesis: 'bug in parser' }));

      const engine = new ReflectionEngine(gen);
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 1 }));
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 3 }));
      expect(engine.state.hypothesisSwitches).toBe(0);
    });

    it('passes correct input to generator', async () => {
      const gen = makeGenerator();
      const engine = new ReflectionEngine(gen);
      await engine.maybeRunReflection(makeRunInput({
        force: true,
        trigger: 'before_escalation',
        iteration: 7,
        task: 'debug the issue',
        failedToolsThisIteration: 2,
        escalationReason: 'stuck',
      }));
      expect(gen).toHaveBeenCalledWith(expect.objectContaining({
        trigger: 'before_escalation',
        iteration: 7,
        task: 'debug the issue',
        failedToolsThisIteration: 2,
        escalationReason: 'stuck',
      }));
    });

    it('hypothesisSwitched flag is correct in result', async () => {
      const gen = vi.fn()
        .mockResolvedValueOnce(makePayload({ hypothesis: 'A' }))
        .mockResolvedValueOnce(makePayload({ hypothesis: 'B' }));

      const engine = new ReflectionEngine(gen);
      const r1 = await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 1 }));
      expect(r1!.hypothesisSwitched).toBe(false);

      const r2 = await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 3 }));
      expect(r2!.hypothesisSwitched).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets all state to defaults', async () => {
      const engine = new ReflectionEngine(makeGenerator());
      await engine.maybeRunReflection(makeRunInput({ force: true, iteration: 5 }));
      expect(engine.state.reflectionCount).toBe(1);

      engine.reset();
      expect(engine.state).toEqual({
        lastReflectionIteration: 0,
        reflectionCount: 0,
        hypothesisSwitches: 0,
        lastReflectionHypothesis: '',
      });
    });
  });
});
