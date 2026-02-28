import { describe, it, expect, vi } from 'vitest';
import {
  TaskCompletionEvaluator,
  isInformationalTask,
  looksLikeNoResultConclusion,
  responseHasEvidence,
  buildValidationPrompt,
  buildValidationTool,
  parseValidationResult,
  heuristicValidation,
} from '../task-completion-evaluator';
import type {
  CompletionEvaluationContext,
  HistoricalChanges,
} from '../task-completion-evaluator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CompletionEvaluationContext> = {}): CompletionEvaluationContext {
  return {
    task: 'fix the login bug',
    agentResponse: 'Fixed the bug in auth.ts',
    iterationsUsed: 5,
    taskIntent: 'action',
    filesRead: new Set(['src/auth.ts']),
    filesModified: new Set(['src/auth.ts']),
    filesCreated: new Set(),
    toolsUsedCount: new Map([['fs_read', 2], ['fs_write', 1]]),
    searchSignalHits: 0,
    recentSearchEvidence: [],
    behaviorPolicy: {
      evidence: {
        minInformationalResponseChars: 180,
        minFilesReadForInformational: 1,
        minEvidenceDensityForInformational: 0.2,
      },
    },
    ...overrides,
  };
}

const emptyHistory: HistoricalChanges = { filesCreated: [], filesModified: [], matchingRunCount: 0 };

// ---------------------------------------------------------------------------
// isInformationalTask (pure)
// ---------------------------------------------------------------------------

describe('isInformationalTask', () => {
  it('returns false for action intent', () => {
    expect(isInformationalTask('action', 'fix bug')).toBe(false);
  });

  it('returns true for discovery intent', () => {
    expect(isInformationalTask('discovery', 'fix bug')).toBe(true);
  });

  it('returns true for analysis intent', () => {
    expect(isInformationalTask('analysis', 'fix bug')).toBe(true);
  });

  it('falls back to regex when intent is null — question word', () => {
    expect(isInformationalTask(null, 'What is the architecture?')).toBe(true);
  });

  it('falls back to regex when intent is null — action verb', () => {
    expect(isInformationalTask(null, 'implement auth')).toBe(false);
  });

  it('matches research verbs', () => {
    expect(isInformationalTask(null, 'analyze the performance')).toBe(true);
    expect(isInformationalTask(null, 'review the code')).toBe(true);
    expect(isInformationalTask(null, 'find the config')).toBe(true);
  });

  it('matches Russian keywords', () => {
    expect(isInformationalTask(null, 'найди конфиг')).toBe(true);
    expect(isInformationalTask(null, 'объясни архитектуру')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// looksLikeNoResultConclusion (pure)
// ---------------------------------------------------------------------------

describe('looksLikeNoResultConclusion', () => {
  it('detects "not found"', () => {
    expect(looksLikeNoResultConclusion('The file was not found')).toBe(true);
  });

  it('detects Russian "не найден"', () => {
    expect(looksLikeNoResultConclusion('Файл не найден')).toBe(true);
  });

  it('detects "no matches"', () => {
    expect(looksLikeNoResultConclusion('no matches in codebase')).toBe(true);
  });

  it('returns false for positive text', () => {
    expect(looksLikeNoResultConclusion('Found the file at src/index.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// responseHasEvidence (pure)
// ---------------------------------------------------------------------------

describe('responseHasEvidence', () => {
  it('detects file extensions', () => {
    expect(responseHasEvidence('Found in src/auth.ts')).toBe(true);
    expect(responseHasEvidence('Check config.json')).toBe(true);
  });

  it('detects code blocks', () => {
    expect(responseHasEvidence('```typescript\nconst x = 1;\n```')).toBe(true);
  });

  it('detects line numbers', () => {
    expect(responseHasEvidence('Error at line :42')).toBe(true);
  });

  it('detects path separators', () => {
    expect(responseHasEvidence('Located at /usr/bin')).toBe(true);
  });

  it('returns false for generic text', () => {
    expect(responseHasEvidence('The task was completed successfully')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildValidationTool (pure)
// ---------------------------------------------------------------------------

describe('buildValidationTool', () => {
  it('returns tool with correct name', () => {
    const tool = buildValidationTool();
    expect(tool.name).toBe('set_validation_result');
  });

  it('requires success and summary', () => {
    const tool = buildValidationTool();
    expect(tool.inputSchema.required).toEqual(['success', 'summary']);
  });
});

// ---------------------------------------------------------------------------
// buildValidationPrompt (pure)
// ---------------------------------------------------------------------------

describe('buildValidationPrompt', () => {
  it('includes task in prompt', () => {
    const ctx = makeCtx();
    const prompt = buildValidationPrompt(ctx, new Set(), new Set(), emptyHistory, '');
    expect(prompt).toContain('fix the login bug');
  });

  it('includes file contents when provided', () => {
    const ctx = makeCtx();
    const prompt = buildValidationPrompt(ctx, new Set(), new Set(), emptyHistory, '\n--- src/auth.ts ---\ncode here\n');
    expect(prompt).toContain('code here');
  });

  it('includes agent response', () => {
    const ctx = makeCtx({ agentResponse: 'I fixed the issue' });
    const prompt = buildValidationPrompt(ctx, new Set(), new Set(), emptyHistory, '');
    expect(prompt).toContain('I fixed the issue');
  });

  it('includes historical matching run count', () => {
    const history: HistoricalChanges = { filesCreated: ['a.ts'], filesModified: [], matchingRunCount: 3 };
    const ctx = makeCtx();
    const prompt = buildValidationPrompt(ctx, new Set(), new Set(), history, '');
    expect(prompt).toContain('3');
  });
});

// ---------------------------------------------------------------------------
// parseValidationResult (pure)
// ---------------------------------------------------------------------------

describe('parseValidationResult', () => {
  it('extracts valid result', () => {
    const result = parseValidationResult({
      toolCalls: [{ id: '1', name: 'set_validation_result', input: { success: true, summary: 'Done' } }],
    });
    expect(result).toEqual({ success: true, summary: 'Done' });
  });

  it('returns null for missing success', () => {
    const result = parseValidationResult({
      toolCalls: [{ id: '1', name: 'set_validation_result', input: { summary: 'Done' } }],
    });
    expect(result).toBeNull();
  });

  it('returns null for empty summary', () => {
    const result = parseValidationResult({
      toolCalls: [{ id: '1', name: 'set_validation_result', input: { success: true, summary: '  ' } }],
    });
    expect(result).toBeNull();
  });

  it('returns null when no tool calls', () => {
    const result = parseValidationResult({ toolCalls: [] });
    expect(result).toBeNull();
  });

  it('returns null for wrong tool name', () => {
    const result = parseValidationResult({
      toolCalls: [{ id: '1', name: 'other', input: { success: true, summary: 'Done' } }],
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// heuristicValidation (pure)
// ---------------------------------------------------------------------------

describe('heuristicValidation', () => {
  it('returns success when files changed', () => {
    const ctx = makeCtx();
    const result = heuristicValidation(ctx, new Set(['a.ts']), new Set(), false);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('Modified');
  });

  it('returns success for informational task with evidence', () => {
    const ctx = makeCtx({
      taskIntent: 'discovery',
      agentResponse: 'Found in src/auth.ts',
      filesModified: new Set(),
      filesCreated: new Set(),
    });
    const result = heuristicValidation(ctx, new Set(), new Set(), true);
    expect(result.success).toBe(true);
  });

  it('returns success for informational task with search signal', () => {
    const ctx = makeCtx({
      taskIntent: 'discovery',
      agentResponse: 'generic response',
      searchSignalHits: 3,
      filesModified: new Set(),
      filesCreated: new Set(),
    });
    const result = heuristicValidation(ctx, new Set(), new Set(), true);
    expect(result.success).toBe(true);
  });

  it('returns failure for action task with no file changes', () => {
    const ctx = makeCtx({
      agentResponse: 'generic response',
      filesModified: new Set(),
      filesCreated: new Set(),
    });
    const result = heuristicValidation(ctx, new Set(), new Set(), false);
    expect(result.success).toBe(false);
  });

  it('uses agent response as summary when no file changes', () => {
    const ctx = makeCtx({
      agentResponse: 'Some analysis',
      filesModified: new Set(),
      filesCreated: new Set(),
    });
    const result = heuristicValidation(ctx, new Set(), new Set(), true);
    expect(result.summary).toContain('Some analysis');
  });
});

// ---------------------------------------------------------------------------
// TaskCompletionEvaluator class
// ---------------------------------------------------------------------------

describe('TaskCompletionEvaluator', () => {
  describe('evaluate — informational fast path', () => {
    it('returns success for informational task with evidence', async () => {
      const evaluator = new TaskCompletionEvaluator(
        () => null,
        async () => null,
        async () => emptyHistory,
        () => {},
      );

      const ctx = makeCtx({
        taskIntent: 'discovery',
        agentResponse: 'x'.repeat(200) + ' src/auth.ts has the config at line :42 with ```code```',
        filesRead: new Set(['src/auth.ts']),
        filesModified: new Set(),
        filesCreated: new Set(),
        searchSignalHits: 1,
      });

      const result = await evaluator.evaluate(ctx);
      expect(result.success).toBe(true);
    });

    it('returns success for no-result conclusion with search effort', async () => {
      const evaluator = new TaskCompletionEvaluator(
        () => null,
        async () => null,
        async () => emptyHistory,
        () => {},
      );

      const ctx = makeCtx({
        taskIntent: 'analysis',
        agentResponse: 'The feature was not found in the codebase',
        toolsUsedCount: new Map([['grep_search', 3], ['glob_search', 1]]),
        filesModified: new Set(),
        filesCreated: new Set(),
      });

      const result = await evaluator.evaluate(ctx);
      expect(result.success).toBe(true);
    });
  });

  describe('evaluate — LLM validation', () => {
    it('uses LLM validation result', async () => {
      const mockLLM = {
        id: 'test',
        complete: vi.fn(),
        stream: vi.fn(),
        chatWithTools: vi.fn().mockResolvedValue({
          content: '',
          toolCalls: [{ id: '1', name: 'set_validation_result', input: { success: true, summary: 'Task completed' } }],
        }),
      };

      const evaluator = new TaskCompletionEvaluator(
        () => mockLLM,
        async () => null,
        async () => emptyHistory,
        () => {},
      );

      const ctx = makeCtx({
        taskIntent: 'action',
        agentResponse: 'Done',
        filesModified: new Set(['src/auth.ts']),
      });

      const result = await evaluator.evaluate(ctx);
      expect(result.success).toBe(true);
      expect(result.summary).toBe('Task completed');
    });

    it('overrides LLM failure for retry with historical changes', async () => {
      const mockLLM = {
        id: 'test',
        complete: vi.fn(),
        stream: vi.fn(),
        chatWithTools: vi.fn().mockResolvedValue({
          content: '',
          toolCalls: [{ id: '1', name: 'set_validation_result', input: { success: false, summary: 'No changes' } }],
        }),
      };

      const history: HistoricalChanges = {
        filesCreated: ['src/new.ts'],
        filesModified: [],
        matchingRunCount: 1,
      };

      const evaluator = new TaskCompletionEvaluator(
        () => mockLLM,
        async () => null,
        async () => history,
        () => {},
      );

      const ctx = makeCtx({
        filesModified: new Set(),
        filesCreated: new Set(),
        toolsUsedCount: new Map([['shell_exec', 1]]),
      });

      const result = await evaluator.evaluate(ctx);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Verified retry');
    });
  });

  describe('evaluate — fallback heuristic', () => {
    it('falls back to heuristic when LLM unavailable', async () => {
      const evaluator = new TaskCompletionEvaluator(
        () => null,
        async () => null,
        async () => emptyHistory,
        () => {},
      );

      const ctx = makeCtx({
        taskIntent: 'action',
        filesModified: new Set(['src/auth.ts']),
        filesCreated: new Set(),
      });

      const result = await evaluator.evaluate(ctx);
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Modified');
    });
  });

  describe('evaluate — file reading', () => {
    it('reads modified files for LLM validation', async () => {
      const readFile = vi.fn().mockResolvedValue('file content');
      const mockLLM = {
        id: 'test',
        complete: vi.fn(),
        stream: vi.fn(),
        chatWithTools: vi.fn().mockResolvedValue({
          content: '',
          toolCalls: [{ id: '1', name: 'set_validation_result', input: { success: true, summary: 'Good' } }],
        }),
      };

      const evaluator = new TaskCompletionEvaluator(
        () => mockLLM,
        readFile,
        async () => emptyHistory,
        () => {},
      );

      const ctx = makeCtx({
        filesModified: new Set(['src/a.ts', 'src/b.ts']),
      });

      await evaluator.evaluate(ctx);
      expect(readFile).toHaveBeenCalledWith('src/a.ts');
      expect(readFile).toHaveBeenCalledWith('src/b.ts');
    });
  });
});
