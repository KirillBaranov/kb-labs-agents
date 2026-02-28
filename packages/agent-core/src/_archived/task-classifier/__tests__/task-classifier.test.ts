import { describe, it, expect, vi } from 'vitest';
import {
  TaskClassifier,
  buildClassifyPrompt,
  buildClassifyTaskTool,
  buildSelectScopeTool,
  parseClassificationResult,
  parseScopeResult,
} from '../task-classifier';
import type { ClassifierLLMProvider } from '../task-classifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLLMProvider(toolCalls: Array<{ id?: string; name: string; input: unknown }> = []): ClassifierLLMProvider {
  return () => ({
    id: 'test-llm',
    complete: vi.fn().mockResolvedValue({ content: '' }),
    chatWithTools: vi.fn().mockResolvedValue({ content: '', toolCalls }),
    stream: vi.fn(),
  });
}

function nullLLMProvider(): ClassifierLLMProvider {
  return () => null;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// buildClassifyPrompt (pure)
// ---------------------------------------------------------------------------

describe('buildClassifyPrompt', () => {
  it('includes task text and cap in prompt', () => {
    const prompt = buildClassifyPrompt('fix the login bug', 20);
    expect(prompt).toContain('fix the login bug');
    expect(prompt).toContain('18–20');
  });

  it('includes all intent options', () => {
    const prompt = buildClassifyPrompt('task', 15);
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"discovery"');
    expect(prompt).toContain('"analysis"');
  });
});

// ---------------------------------------------------------------------------
// buildClassifyTaskTool (pure)
// ---------------------------------------------------------------------------

describe('buildClassifyTaskTool', () => {
  it('returns tool with correct name', () => {
    const tool = buildClassifyTaskTool(20);
    expect(tool.name).toBe('classify_task');
  });

  it('has intent enum with 3 options', () => {
    const tool = buildClassifyTaskTool(20);
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.intent?.enum).toEqual(['action', 'discovery', 'analysis']);
  });

  it('requires intent and budget', () => {
    const tool = buildClassifyTaskTool(20);
    expect(tool.inputSchema.required).toEqual(['intent', 'budget']);
  });
});

// ---------------------------------------------------------------------------
// buildSelectScopeTool (pure)
// ---------------------------------------------------------------------------

describe('buildSelectScopeTool', () => {
  it('includes dirs and "none" in enum', () => {
    const tool = buildSelectScopeTool(['src', 'lib']);
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.scope?.enum).toEqual(['src', 'lib', 'none']);
  });

  it('has required scope field', () => {
    const tool = buildSelectScopeTool(['pkg']);
    expect(tool.inputSchema.required).toEqual(['scope']);
  });
});

// ---------------------------------------------------------------------------
// parseClassificationResult (pure)
// ---------------------------------------------------------------------------

describe('parseClassificationResult', () => {
  it('extracts valid classification', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'action', budget: 12 } }] },
      20,
      25,
    );
    expect(result).toEqual({ intent: 'action', budget: 12 });
  });

  it('clamps budget to cap', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'discovery', budget: 30 } }] },
      15,
      25,
    );
    expect(result?.budget).toBe(15);
  });

  it('clamps budget to minimum 4', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'analysis', budget: 2 } }] },
      20,
      25,
    );
    expect(result?.budget).toBe(4);
  });

  it('returns null for invalid intent', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'unknown', budget: 10 } }] },
      20,
      25,
    );
    expect(result).toBeNull();
  });

  it('returns null for missing budget', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'action' } }] },
      20,
      25,
    );
    expect(result).toBeNull();
  });

  it('returns null for zero budget', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'classify_task', input: { intent: 'action', budget: 0 } }] },
      20,
      25,
    );
    expect(result).toBeNull();
  });

  it('returns null when no tool calls', () => {
    const result = parseClassificationResult({ toolCalls: [] }, 20, 25);
    expect(result).toBeNull();
  });

  it('returns null when toolCalls is undefined', () => {
    const result = parseClassificationResult({ toolCalls: undefined }, 20, 25);
    expect(result).toBeNull();
  });

  it('ignores non-classify_task tool calls', () => {
    const result = parseClassificationResult(
      { toolCalls: [{ id: '1', name: 'other_tool', input: { intent: 'action', budget: 10 } }] },
      20,
      25,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseScopeResult (pure)
// ---------------------------------------------------------------------------

describe('parseScopeResult', () => {
  it('extracts valid scope', () => {
    const result = parseScopeResult(
      { toolCalls: [{ id: '1', name: 'select_scope', input: { scope: 'src' } }] },
      ['src', 'lib'],
    );
    expect(result).toBe('src');
  });

  it('returns null for "none"', () => {
    const result = parseScopeResult(
      { toolCalls: [{ id: '1', name: 'select_scope', input: { scope: 'none' } }] },
      ['src', 'lib'],
    );
    expect(result).toBeNull();
  });

  it('returns null for scope not in available dirs', () => {
    const result = parseScopeResult(
      { toolCalls: [{ id: '1', name: 'select_scope', input: { scope: 'unknown' } }] },
      ['src', 'lib'],
    );
    expect(result).toBeNull();
  });

  it('returns null when no tool calls', () => {
    const result = parseScopeResult({ toolCalls: [] }, ['src']);
    expect(result).toBeNull();
  });

  it('returns null for wrong tool name', () => {
    const result = parseScopeResult(
      { toolCalls: [{ id: '1', name: 'other', input: { scope: 'src' } }] },
      ['src'],
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TaskClassifier class
// ---------------------------------------------------------------------------

describe('TaskClassifier', () => {
  describe('classifyTask', () => {
    it('returns LLM classification result', async () => {
      const provider = makeLLMProvider([
        { id: '1', name: 'classify_task', input: { intent: 'discovery', budget: 8 } },
      ]);
      const classifier = new TaskClassifier(provider, noop);

      const result = await classifier.classifyTask('where is the config?', {
        maxIterations: 25,
        workingDir: '/tmp',
      });

      expect(result.intent).toBe('discovery');
      expect(result.budget).toBe(8);
    });

    it('falls back to defaults when LLM unavailable', async () => {
      const classifier = new TaskClassifier(nullLLMProvider(), noop);

      const result = await classifier.classifyTask('fix bug', {
        maxIterations: 25,
        workingDir: '/tmp',
      });

      expect(result.intent).toBe('action');
      expect(result.budget).toBe(12);
    });

    it('falls back to defaults when LLM returns invalid result', async () => {
      const provider = makeLLMProvider([
        { id: '1', name: 'classify_task', input: { intent: 'invalid' } },
      ]);
      const classifier = new TaskClassifier(provider, noop);

      const result = await classifier.classifyTask('task', {
        maxIterations: 25,
        workingDir: '/tmp',
      });

      expect(result.intent).toBe('action');
      expect(result.budget).toBe(12);
    });

    it('caps budget at min(configured, 20)', async () => {
      const provider = makeLLMProvider([
        { id: '1', name: 'classify_task', input: { intent: 'action', budget: 50 } },
      ]);
      const classifier = new TaskClassifier(provider, noop);

      const result = await classifier.classifyTask('big task', {
        maxIterations: 30,
        workingDir: '/tmp',
      });

      expect(result.budget).toBe(20); // cap = min(30, 20) = 20
    });
  });

  describe('extractScope', () => {
    it('returns null for sub-agents', async () => {
      const classifier = new TaskClassifier(makeLLMProvider(), noop);

      const result = await classifier.extractScope('fix something in src', {
        maxIterations: 25,
        parentAgentId: 'parent-1',
        workingDir: '/tmp',
      });

      expect(result).toBeNull();
    });

    it('returns null when LLM unavailable', async () => {
      const classifier = new TaskClassifier(nullLLMProvider(), noop);

      const result = await classifier.extractScope('fix src', {
        maxIterations: 25,
        workingDir: '/tmp',
      });

      expect(result).toBeNull();
    });
  });
});
