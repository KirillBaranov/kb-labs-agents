import { describe, it, expect, vi } from 'vitest';
import {
  SearchSignalTracker,
  isLikelyDiscoveryTask,
  extractSearchEvidenceSnippets,
  assessSearchSignalHeuristic,
} from '../search-signal-tracker';
import type {
  SearchSignalAssessor,
  SearchSignalContext,
  SearchArtifact,
} from '../search-signal-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssessor(
  signal: 'none' | 'partial' | 'strong' = 'none',
  snippets: string[] = [],
): SearchSignalAssessor {
  return vi.fn().mockResolvedValue({ signal, snippets });
}

function makeContext(overrides: Partial<SearchSignalContext> = {}): SearchSignalContext {
  return {
    task: 'find the export of Foo',
    taskIntent: 'discovery',
    behaviorPolicy: {
      noResult: {
        minIterationsBeforeConclusion: 3,
        maxConsecutiveNoSignalSearchByTier: { small: 2, medium: 3, large: 4 },
      },
    },
    currentTier: 'medium',
    filesRead: new Set(),
    filesModified: new Set(),
    filesCreated: new Set(),
    ...overrides,
  };
}

function searchToolCall(id: string, name = 'grep_search') {
  return { id, name };
}

function searchResult(toolCallId: string, content: string) {
  return { toolCallId, content };
}

// ---------------------------------------------------------------------------
// Pure: isLikelyDiscoveryTask
// ---------------------------------------------------------------------------

describe('isLikelyDiscoveryTask', () => {
  it('returns true when taskIntent is discovery', () => {
    expect(isLikelyDiscoveryTask('do something', 'discovery')).toBe(true);
  });

  it('returns false when taskIntent is action', () => {
    expect(isLikelyDiscoveryTask('find the bug', 'action')).toBe(false);
  });

  it('returns false when taskIntent is analysis', () => {
    expect(isLikelyDiscoveryTask('find the bug', 'analysis')).toBe(false);
  });

  it('falls back to regex when taskIntent is null — positive', () => {
    expect(isLikelyDiscoveryTask('find the export of Foo', null)).toBe(true);
    expect(isLikelyDiscoveryTask('where is FooService used?', null)).toBe(true);
    expect(isLikelyDiscoveryTask('search for bar', null)).toBe(true);
    expect(isLikelyDiscoveryTask('locate the definition', null)).toBe(true);
  });

  it('falls back to regex when taskIntent is null — negative', () => {
    expect(isLikelyDiscoveryTask('refactor the module', null)).toBe(false);
    expect(isLikelyDiscoveryTask('add a new feature', null)).toBe(false);
  });

  it('matches Russian keywords', () => {
    expect(isLikelyDiscoveryTask('найди файл с экспортом', null)).toBe(true);
    expect(isLikelyDiscoveryTask('где определение класса?', null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure: extractSearchEvidenceSnippets
// ---------------------------------------------------------------------------

describe('extractSearchEvidenceSnippets', () => {
  it('returns empty for blank content', () => {
    expect(extractSearchEvidenceSnippets('')).toEqual([]);
    expect(extractSearchEvidenceSnippets('   ')).toEqual([]);
  });

  it('extracts lines with file paths', () => {
    const content = 'src/agent.ts:42\nsome random text\nutils/helper.js';
    const result = extractSearchEvidenceSnippets(content);
    expect(result).toEqual(['src/agent.ts:42', 'utils/helper.js']);
  });

  it('caps at 6 snippets', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:${i}`).join('\n');
    expect(extractSearchEvidenceSnippets(lines)).toHaveLength(6);
  });

  it('truncates long lines to 180 chars', () => {
    const longLine = `${'a'.repeat(200)}.ts:1`;
    const result = extractSearchEvidenceSnippets(longLine);
    expect(result[0]).toHaveLength(180);
    expect(result[0]!.endsWith('...')).toBe(true);
  });

  it('matches various file extensions', () => {
    const content = 'foo.tsx:10\nbar.py\nbaz.go\nqux.rs\ndata.json\nreadme.md';
    expect(extractSearchEvidenceSnippets(content)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Pure: assessSearchSignalHeuristic
// ---------------------------------------------------------------------------

describe('assessSearchSignalHeuristic', () => {
  it('returns partial with snippets when file paths found', () => {
    const artifacts: SearchArtifact[] = [
      { tool: 'grep_search', content: 'src/agent.ts:42: export class Agent' },
    ];
    const result = assessSearchSignalHeuristic(artifacts);
    expect(result.signal).toBe('partial');
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it('returns none when all results are negative', () => {
    const artifacts: SearchArtifact[] = [
      { tool: 'grep_search', content: 'no results found' },
      { tool: 'glob_search', content: 'no matches' },
    ];
    const result = assessSearchSignalHeuristic(artifacts);
    expect(result.signal).toBe('none');
    expect(result.snippets).toEqual([]);
  });

  it('returns partial when results are empty but not explicitly negative', () => {
    const artifacts: SearchArtifact[] = [
      { tool: 'grep_search', content: 'some text without file paths' },
    ];
    const result = assessSearchSignalHeuristic(artifacts);
    expect(result.signal).toBe('partial');
    expect(result.snippets).toEqual([]);
  });

  it('caps snippets at 6 total across artifacts', () => {
    const artifacts: SearchArtifact[] = Array.from({ length: 5 }, (_, i) => ({
      tool: 'grep_search',
      content: Array.from({ length: 3 }, (__, j) => `file${i}_${j}.ts:1`).join('\n'),
    }));
    const result = assessSearchSignalHeuristic(artifacts);
    expect(result.snippets.length).toBeLessThanOrEqual(6);
  });

  it('recognizes Russian negative keywords', () => {
    const artifacts: SearchArtifact[] = [
      { tool: 'grep_search', content: 'не найдено совпадений' },
    ];
    const result = assessSearchSignalHeuristic(artifacts);
    expect(result.signal).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Class: SearchSignalTracker
// ---------------------------------------------------------------------------

describe('SearchSignalTracker', () => {
  describe('constructor', () => {
    it('initializes with default state', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      expect(tracker.state).toEqual({
        consecutiveNoSignalSearchIterations: 0,
        searchSignalHits: 0,
        recentSearchEvidence: [],
        lastSignalIteration: 0,
      });
    });

    it('accepts initial state overrides', () => {
      const tracker = new SearchSignalTracker(makeAssessor(), {
        searchSignalHits: 5,
        lastSignalIteration: 3,
      });
      expect(tracker.state.searchSignalHits).toBe(5);
      expect(tracker.state.lastSignalIteration).toBe(3);
      expect(tracker.state.consecutiveNoSignalSearchIterations).toBe(0);
    });
  });

  describe('updateNoResultTracker', () => {
    it('resets consecutiveNoSignal when no tool calls', async () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      await tracker.updateNoResultTracker([], [], 1);
      expect(tracker.state.consecutiveNoSignalSearchIterations).toBe(0);
    });

    it('resets consecutiveNoSignal when no search calls', async () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      await tracker.updateNoResultTracker(
        [{ id: '1', name: 'fs_read' }],
        [{ toolCallId: '1', content: 'file content' }],
        1,
      );
      expect(tracker.state.consecutiveNoSignalSearchIterations).toBe(0);
    });

    it('increments consecutiveNoSignal on none signal', async () => {
      const tracker = new SearchSignalTracker(makeAssessor('none'));
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', 'no results')],
        1,
      );
      expect(tracker.state.consecutiveNoSignalSearchIterations).toBe(1);
    });

    it('resets consecutiveNoSignal on positive signal', async () => {
      const tracker = new SearchSignalTracker(makeAssessor('partial'));
      tracker.state.consecutiveNoSignalSearchIterations = 3;
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', 'found src/agent.ts')],
        2,
      );
      expect(tracker.state.consecutiveNoSignalSearchIterations).toBe(0);
    });

    it('increments searchSignalHits on positive signal', async () => {
      const tracker = new SearchSignalTracker(makeAssessor('strong'));
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', 'src/agent.ts:42')],
        3,
      );
      expect(tracker.state.searchSignalHits).toBe(1);
      expect(tracker.state.lastSignalIteration).toBe(3);
    });

    it('accumulates evidence snippets without duplicates', async () => {
      const assessor = makeAssessor('partial', ['src/a.ts', 'src/b.ts']);
      const tracker = new SearchSignalTracker(assessor);
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', 'content')],
        1,
      );
      expect(tracker.state.recentSearchEvidence).toEqual(['src/a.ts', 'src/b.ts']);

      // Same snippets again — no duplicates
      await tracker.updateNoResultTracker(
        [searchToolCall('2')],
        [searchResult('2', 'content')],
        2,
      );
      expect(tracker.state.recentSearchEvidence).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('caps evidence at 8 items', async () => {
      const snippets = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
      const assessor = makeAssessor('partial', snippets);
      const tracker = new SearchSignalTracker(assessor);
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', 'content')],
        1,
      );
      expect(tracker.state.recentSearchEvidence.length).toBeLessThanOrEqual(8);
    });

    it('calls assessor with search artifacts only', async () => {
      const assessor = makeAssessor('none');
      const tracker = new SearchSignalTracker(assessor);
      await tracker.updateNoResultTracker(
        [
          searchToolCall('1', 'grep_search'),
          { id: '2', name: 'fs_read' },
          searchToolCall('3', 'glob_search'),
        ],
        [
          searchResult('1', 'grep output'),
          searchResult('2', 'file content'),
          searchResult('3', 'glob output'),
        ],
        1,
      );
      expect(assessor).toHaveBeenCalledWith([
        { tool: 'grep_search', content: 'grep output' },
        { tool: 'glob_search', content: 'glob output' },
      ]);
    });

    it('truncates artifact content to 2000 chars', async () => {
      const assessor = makeAssessor('none');
      const tracker = new SearchSignalTracker(assessor);
      const longContent = 'x'.repeat(5000);
      await tracker.updateNoResultTracker(
        [searchToolCall('1')],
        [searchResult('1', longContent)],
        1,
      );
      const call = (assessor as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SearchArtifact[];
      expect(call[0]!.content.length).toBe(2000);
    });
  });

  describe('shouldConcludeNoResultEarly', () => {
    it('returns false for action tasks', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 10;
      expect(tracker.shouldConcludeNoResultEarly(5, makeContext(), true)).toBe(false);
    });

    it('returns false for non-discovery tasks', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 10;
      expect(
        tracker.shouldConcludeNoResultEarly(
          5,
          makeContext({ task: 'refactor module', taskIntent: null }),
          false,
        ),
      ).toBe(false);
    });

    it('returns false before minIterationsBeforeConclusion', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 10;
      expect(tracker.shouldConcludeNoResultEarly(2, makeContext(), false)).toBe(false);
    });

    it('returns false when consecutiveNoSignal below threshold', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 1;
      expect(tracker.shouldConcludeNoResultEarly(5, makeContext(), false)).toBe(false);
    });

    it('returns false when searchSignalHits > 0', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      tracker.state.searchSignalHits = 1;
      expect(tracker.shouldConcludeNoResultEarly(5, makeContext(), false)).toBe(false);
    });

    it('returns false when evidence count > 1', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      expect(
        tracker.shouldConcludeNoResultEarly(
          5,
          makeContext({ filesRead: new Set(['a.ts', 'b.ts']) }),
          false,
        ),
      ).toBe(false);
    });

    it('returns true when all conditions met', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      expect(tracker.shouldConcludeNoResultEarly(5, makeContext(), false)).toBe(true);
    });

    it('uses tier-specific maxNoSignal threshold', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 2;
      // small tier has threshold 2
      expect(
        tracker.shouldConcludeNoResultEarly(
          5,
          makeContext({ currentTier: 'small' }),
          false,
        ),
      ).toBe(true);
      // large tier has threshold 4, so 2 is not enough
      expect(
        tracker.shouldConcludeNoResultEarly(
          5,
          makeContext({ currentTier: 'large' }),
          false,
        ),
      ).toBe(false);
    });
  });

  describe('buildNoResultConclusionSummary', () => {
    it('builds summary with tool counts', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      const toolsUsed = new Map([['grep_search', 3], ['glob_search', 2]]);
      const summary = tracker.buildNoResultConclusionSummary(toolsUsed);
      expect(summary).toContain('grep_search×3');
      expect(summary).toContain('glob_search×2');
      expect(summary).toContain('Insufficient evidence');
    });

    it('includes evidence when available', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.recentSearchEvidence = ['src/agent.ts:42', 'src/utils.ts:10'];
      const summary = tracker.buildNoResultConclusionSummary(new Map([['grep_search', 1]]));
      expect(summary).toContain('Partial signal');
      expect(summary).toContain('src/agent.ts:42');
      expect(summary).toContain('src/utils.ts:10');
    });

    it('uses fallback text when no search tools', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      const summary = tracker.buildNoResultConclusionSummary(new Map());
      expect(summary).toContain('search tools');
    });
  });

  describe('reset', () => {
    it('resets all state to defaults', () => {
      const tracker = new SearchSignalTracker(makeAssessor());
      tracker.state.consecutiveNoSignalSearchIterations = 5;
      tracker.state.searchSignalHits = 3;
      tracker.state.recentSearchEvidence = ['a', 'b'];
      tracker.state.lastSignalIteration = 7;

      tracker.reset();

      expect(tracker.state).toEqual({
        consecutiveNoSignalSearchIterations: 0,
        searchSignalHits: 0,
        recentSearchEvidence: [],
        lastSignalIteration: 0,
      });
    });
  });
});
