import { describe, it, expect } from 'vitest';
import {
  ProgressTracker,
  shouldTrackDomainForTool,
  extractTopLevelDomain,
  countFailedToolResults,
} from '../progress-tracker';
import type { UpdateProgressInput, EvidenceScoreInput } from '../progress-tracker';

function makeUpdateInput(overrides: Partial<UpdateProgressInput> = {}): UpdateProgressInput {
  return {
    toolName: 'grep_search',
    outputSize: 500,
    iteration: 1,
    evidenceDelta: 0,
    failedToolsThisIteration: 0,
    searchSignalHits: 0,
    ...overrides,
  };
}

function makeEvidenceInput(overrides: Partial<EvidenceScoreInput> = {}): EvidenceScoreInput {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    filesCreated: new Set(),
    searchSignalHits: 0,
    recentSearchEvidenceCount: 0,
    ...overrides,
  };
}

describe('ProgressTracker', () => {
  describe('updateProgress', () => {
    it('tracks last 3 tool calls', () => {
      const tracker = new ProgressTracker();
      tracker.updateProgress(makeUpdateInput({ toolName: 'a' }));
      tracker.updateProgress(makeUpdateInput({ toolName: 'b' }));
      tracker.updateProgress(makeUpdateInput({ toolName: 'c' }));
      tracker.updateProgress(makeUpdateInput({ toolName: 'd' }));
      expect(tracker.state.lastToolCalls).toEqual(['b', 'c', 'd']);
    });

    it('tracks last 3 output sizes', () => {
      const tracker = new ProgressTracker();
      tracker.updateProgress(makeUpdateInput({ outputSize: 100 }));
      tracker.updateProgress(makeUpdateInput({ outputSize: 200 }));
      tracker.updateProgress(makeUpdateInput({ outputSize: 300 }));
      tracker.updateProgress(makeUpdateInput({ outputSize: 400 }));
      expect(tracker.state.lastOutputSizes).toEqual([200, 300, 400]);
    });

    it('resets iterationsSinceProgress on strong progress', () => {
      const tracker = new ProgressTracker();
      tracker.state.iterationsSinceProgress = 5;
      // evidenceDelta > 0 gives +3 (strong progress)
      tracker.updateProgress(makeUpdateInput({ evidenceDelta: 2, iteration: 5 }));
      expect(tracker.state.iterationsSinceProgress).toBe(0);
      expect(tracker.state.lastProgressIteration).toBe(5);
    });

    it('increments iterationsSinceProgress on no progress', () => {
      const tracker = new ProgressTracker();
      tracker.updateProgress(makeUpdateInput({ evidenceDelta: 0, searchSignalHits: 0, outputSize: 0 }));
      // First call: only 1 tool call so no "varied tools" bonus.
      // outputSize=0, previousOutputSize=0 → outputGrowth=0, outputGrowthRatio=0
      // All deltas zero → progressScore = 0
      expect(tracker.state.iterationsSinceProgress).toBe(1);
    });

    it('reduces iterationsSinceProgress on weak progress', () => {
      const tracker = new ProgressTracker();
      tracker.state.iterationsSinceProgress = 3;
      // outputGrowth >= 300 gives +1 (weak but real signal)
      tracker.updateProgress(makeUpdateInput({ outputSize: 500 }));
      // Second update: only 1 output size tracked, so previousOutputSize is 0.
      // outputGrowth = 500 - 0 = 500 ≥ 300 → +1. But only 1 tool call so no varied bonus.
      // progressScore = 1 (weak). iterationsSinceProgress should decrease by 1.
      expect(tracker.state.iterationsSinceProgress).toBe(2);
    });

    it('detects search signal delta', () => {
      const tracker = new ProgressTracker();
      tracker.state.lastSearchSignalHits = 0;
      // searchSignalDelta > 0 gives +2
      tracker.updateProgress(makeUpdateInput({ searchSignalHits: 3 }));
      expect(tracker.state.iterationsSinceProgress).toBe(0);
      expect(tracker.state.lastSearchSignalHits).toBe(3);
    });

    it('tracks lastFailureCount', () => {
      const tracker = new ProgressTracker();
      tracker.updateProgress(makeUpdateInput({ failedToolsThisIteration: 3 }));
      expect(tracker.state.lastFailureCount).toBe(3);
    });

    it('gives bonus for varied tool calls', () => {
      const tracker = new ProgressTracker();
      tracker.updateProgress(makeUpdateInput({ toolName: 'grep_search' }));
      tracker.updateProgress(makeUpdateInput({ toolName: 'fs_read' }));
      // 2 different tools → varied tools bonus +1
      // But still only progressScore=1 unless more signals
      expect(tracker.state.iterationsSinceProgress).toBeLessThanOrEqual(1);
    });
  });

  describe('trackFileOperation', () => {
    it('tracks fs_read', () => {
      const tracker = new ProgressTracker();
      const files = { filesRead: new Set<string>(), filesModified: new Set<string>(), filesCreated: new Set<string>() };
      tracker.trackFileOperation('fs_read', { path: '/project/file.ts' }, files);
      expect(files.filesRead.has('/project/file.ts')).toBe(true);
    });

    it('tracks fs_write as created when not previously modified', () => {
      const tracker = new ProgressTracker();
      const files = { filesRead: new Set<string>(), filesModified: new Set<string>(), filesCreated: new Set<string>() };
      tracker.trackFileOperation('fs_write', { path: '/project/new.ts' }, files);
      expect(files.filesCreated.has('/project/new.ts')).toBe(true);
    });

    it('does not track fs_write as created when already modified', () => {
      const tracker = new ProgressTracker();
      const files = {
        filesRead: new Set<string>(),
        filesModified: new Set(['existing.ts']),
        filesCreated: new Set<string>(),
      };
      tracker.trackFileOperation('fs_write', { path: 'existing.ts' }, files);
      expect(files.filesCreated.has('existing.ts')).toBe(false);
    });

    it('tracks fs_edit as modified', () => {
      const tracker = new ProgressTracker();
      const files = { filesRead: new Set<string>(), filesModified: new Set<string>(), filesCreated: new Set<string>() };
      tracker.trackFileOperation('fs_edit', { path: 'file.ts' }, files);
      expect(files.filesModified.has('file.ts')).toBe(true);
    });

    it('tracks fs_patch as modified', () => {
      const tracker = new ProgressTracker();
      const files = { filesRead: new Set<string>(), filesModified: new Set<string>(), filesCreated: new Set<string>() };
      tracker.trackFileOperation('fs_patch', { path: 'file.ts' }, files);
      expect(files.filesModified.has('file.ts')).toBe(true);
    });

    it('removes from created when edited', () => {
      const tracker = new ProgressTracker();
      const files = {
        filesRead: new Set<string>(),
        filesModified: new Set<string>(),
        filesCreated: new Set(['file.ts']),
      };
      tracker.trackFileOperation('fs_edit', { path: 'file.ts' }, files);
      expect(files.filesCreated.has('file.ts')).toBe(false);
      expect(files.filesModified.has('file.ts')).toBe(true);
    });

    it('does nothing without path', () => {
      const tracker = new ProgressTracker();
      const files = { filesRead: new Set<string>(), filesModified: new Set<string>(), filesCreated: new Set<string>() };
      tracker.trackFileOperation('fs_read', {}, files);
      expect(files.filesRead.size).toBe(0);
    });
  });

  describe('trackDomainTouch', () => {
    it('tracks domain from file path', () => {
      const tracker = new ProgressTracker();
      const domains = new Set<string>();
      tracker.trackDomainTouch('fs_read', { path: 'packages/core/src/index.ts' }, domains, '/project');
      expect(domains.has('packages')).toBe(true);
    });

    it('tracks domain from directory', () => {
      const tracker = new ProgressTracker();
      const domains = new Set<string>();
      tracker.trackDomainTouch('grep_search', { directory: 'src' }, domains, '/project');
      expect(domains.has('src')).toBe(true);
    });

    it('does not track for non-tracked tools', () => {
      const tracker = new ProgressTracker();
      const domains = new Set<string>();
      tracker.trackDomainTouch('memory_get', { path: 'src/file.ts' }, domains, '/project');
      expect(domains.size).toBe(0);
    });
  });

  describe('getEvidenceProgressScore', () => {
    it('returns 0 for empty input', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput())).toBe(0);
    });

    it('counts files read', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        filesRead: new Set(['a', 'b', 'c']),
      }))).toBe(3);
    });

    it('weights modified files at 2x', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        filesModified: new Set(['a', 'b']),
      }))).toBe(4);
    });

    it('weights created files at 2x', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        filesCreated: new Set(['a']),
      }))).toBe(2);
    });

    it('includes search signal hits', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        searchSignalHits: 5,
      }))).toBe(5);
    });

    it('includes recent search evidence count', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        recentSearchEvidenceCount: 3,
      }))).toBe(3);
    });

    it('combines all sources', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getEvidenceProgressScore(makeEvidenceInput({
        filesRead: new Set(['a', 'b']),
        filesModified: new Set(['c']),
        filesCreated: new Set(['d']),
        searchSignalHits: 2,
        recentSearchEvidenceCount: 1,
      }))).toBe(2 + 2 + 2 + 2 + 1); // 9
    });
  });

  describe('reset', () => {
    it('resets all state to defaults', () => {
      const tracker = new ProgressTracker();
      tracker.state.lastToolCalls.push('a', 'b');
      tracker.state.lastOutputSizes.push(100, 200);
      tracker.state.iterationsSinceProgress = 5;
      tracker.state.lastFailureCount = 3;
      tracker.state.lastProgressIteration = 7;
      tracker.state.lastSearchSignalHits = 2;

      tracker.reset();

      expect(tracker.state.lastToolCalls).toEqual([]);
      expect(tracker.state.lastOutputSizes).toEqual([]);
      expect(tracker.state.iterationsSinceProgress).toBe(0);
      expect(tracker.state.lastFailureCount).toBe(0);
      expect(tracker.state.lastProgressIteration).toBe(0);
      expect(tracker.state.lastSearchSignalHits).toBe(0);
    });
  });

  describe('constructor', () => {
    it('creates with default state', () => {
      const tracker = new ProgressTracker();
      expect(tracker.state.stuckThreshold).toBe(3);
      expect(tracker.state.lastToolCalls).toEqual([]);
    });

    it('accepts partial initial state', () => {
      const tracker = new ProgressTracker({ stuckThreshold: 5, iterationsSinceProgress: 2 });
      expect(tracker.state.stuckThreshold).toBe(5);
      expect(tracker.state.iterationsSinceProgress).toBe(2);
      expect(tracker.state.lastToolCalls).toEqual([]);
    });
  });
});

describe('shouldTrackDomainForTool', () => {
  it('returns true for fs_ tools', () => {
    expect(shouldTrackDomainForTool('fs_read')).toBe(true);
    expect(shouldTrackDomainForTool('fs_write')).toBe(true);
  });

  it('returns true for search tools', () => {
    expect(shouldTrackDomainForTool('grep_search')).toBe(true);
    expect(shouldTrackDomainForTool('glob_search')).toBe(true);
  });

  it('returns true for shell_exec', () => {
    expect(shouldTrackDomainForTool('shell_exec')).toBe(true);
  });

  it('returns false for memory tools', () => {
    expect(shouldTrackDomainForTool('memory_get')).toBe(false);
  });

  it('returns false for todo tools', () => {
    expect(shouldTrackDomainForTool('todo_create')).toBe(false);
  });
});

describe('extractTopLevelDomain', () => {
  it('extracts top-level directory', () => {
    expect(extractTopLevelDomain('packages/core/src/index.ts', '/project')).toBe('packages');
  });

  it('returns null for paths outside baseDir', () => {
    expect(extractTopLevelDomain('/other/place/file.ts', '/project')).toBeNull();
  });

  it('returns null for "." path', () => {
    expect(extractTopLevelDomain('.', '/project')).toBeNull();
  });

  it('handles absolute paths within baseDir', () => {
    expect(extractTopLevelDomain('/project/src/file.ts', '/project')).toBe('src');
  });
});

describe('countFailedToolResults', () => {
  it('returns 0 for empty array', () => {
    expect(countFailedToolResults([])).toBe(0);
  });

  it('counts Error: prefixed messages', () => {
    expect(countFailedToolResults([
      { content: 'Error: file not found' },
      { content: 'Success: done' },
      { content: 'Error: permission denied' },
    ])).toBe(2);
  });

  it('handles non-string content', () => {
    expect(countFailedToolResults([
      { content: 123 as unknown as string },
      { content: undefined },
    ])).toBe(0);
  });

  it('does not count non-Error prefixed messages', () => {
    expect(countFailedToolResults([
      { content: 'Found 5 results' },
      { content: 'No results found' },
    ])).toBe(0);
  });
});
