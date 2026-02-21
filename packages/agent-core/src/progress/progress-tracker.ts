/**
 * Progress Tracker
 *
 * Tracks tool execution progress, detects stuck patterns,
 * manages evidence scoring, and records file/domain operations.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProgressState {
  lastToolCalls: string[];
  lastOutputSizes: number[];
  iterationsSinceProgress: number;
  stuckThreshold: number;
  lastFailureCount: number;
  lastProgressIteration: number;
  lastSearchSignalHits: number;
}

export interface EvidenceScoreInput {
  filesRead: ReadonlySet<string>;
  filesModified: ReadonlySet<string>;
  filesCreated: ReadonlySet<string>;
  searchSignalHits: number;
  recentSearchEvidenceCount: number;
}

export interface UpdateProgressInput {
  toolName: string;
  outputSize: number;
  iteration: number;
  evidenceDelta: number;
  failedToolsThisIteration: number;
  searchSignalHits: number;
}

// ---------------------------------------------------------------------------
// ProgressTracker
// ---------------------------------------------------------------------------

export class ProgressTracker {
  readonly state: ProgressState;

  constructor(initial?: Partial<ProgressState>) {
    this.state = {
      lastToolCalls: initial?.lastToolCalls ?? [],
      lastOutputSizes: initial?.lastOutputSizes ?? [],
      iterationsSinceProgress: initial?.iterationsSinceProgress ?? 0,
      stuckThreshold: initial?.stuckThreshold ?? 3,
      lastFailureCount: initial?.lastFailureCount ?? 0,
      lastProgressIteration: initial?.lastProgressIteration ?? 0,
      lastSearchSignalHits: initial?.lastSearchSignalHits ?? 0,
    };
  }

  // ── Progress update ─────────────────────────────────────────────────────

  updateProgress(input: UpdateProgressInput): void {
    // Track last 3 tool calls
    this.state.lastToolCalls.push(input.toolName);
    if (this.state.lastToolCalls.length > 3) {
      this.state.lastToolCalls.shift();
    }

    // Track output sizes
    this.state.lastOutputSizes.push(input.outputSize);
    if (this.state.lastOutputSizes.length > 3) {
      this.state.lastOutputSizes.shift();
    }

    const previousOutputSize =
      this.state.lastOutputSizes.length >= 2
        ? this.state.lastOutputSizes[this.state.lastOutputSizes.length - 2] ?? 0
        : 0;
    const outputGrowth = input.outputSize - previousOutputSize;
    const outputGrowthRatio =
      previousOutputSize > 0
        ? input.outputSize / previousOutputSize
        : input.outputSize > 0
          ? 1
          : 0;
    const searchSignalDelta = Math.max(
      0,
      input.searchSignalHits - this.state.lastSearchSignalHits,
    );
    const failedToolDelta = this.state.lastFailureCount - input.failedToolsThisIteration;
    const repeatedSingleTool =
      this.state.lastToolCalls.length >= 3
      && new Set(this.state.lastToolCalls.slice(-3)).size === 1;

    let progressScore = 0;
    if (input.evidenceDelta > 0) {
      progressScore += 3;
    }
    if (searchSignalDelta > 0) {
      progressScore += 2;
    }
    if (failedToolDelta > 0) {
      progressScore += 2;
    }
    if (outputGrowth >= 300 || outputGrowthRatio >= 1.35) {
      progressScore += 1;
    }
    if (!repeatedSingleTool && this.state.lastToolCalls.length >= 2) {
      progressScore += 1;
    }

    if (progressScore >= 2) {
      this.state.iterationsSinceProgress = 0;
      this.state.lastProgressIteration = input.iteration;
    } else if (progressScore === 1) {
      // Weak but real signal: avoid false "hard stall" and keep momentum.
      this.state.iterationsSinceProgress = Math.max(
        0,
        this.state.iterationsSinceProgress - 1,
      );
      this.state.lastProgressIteration = input.iteration;
    } else {
      this.state.iterationsSinceProgress += 1;
    }

    this.state.lastFailureCount = input.failedToolsThisIteration;
    this.state.lastSearchSignalHits = input.searchSignalHits;
  }

  // ── File operations ─────────────────────────────────────────────────────

  trackFileOperation(
    toolName: string,
    input: Record<string, unknown>,
    files: {
      filesRead: Set<string>;
      filesModified: Set<string>;
      filesCreated: Set<string>;
    },
  ): void {
    const filePath = input.path as string | undefined;
    if (!filePath) {
      return;
    }

    if (toolName === 'fs_write') {
      if (!files.filesModified.has(filePath)) {
        files.filesCreated.add(filePath);
      }
    } else if (toolName === 'fs_patch' || toolName === 'fs_edit') {
      files.filesModified.add(filePath);
      files.filesCreated.delete(filePath);
    } else if (toolName === 'fs_read') {
      files.filesRead.add(filePath);
    }
  }

  // ── Domain tracking ─────────────────────────────────────────────────────

  trackDomainTouch(
    toolName: string,
    input: Record<string, unknown>,
    touchedDomains: Set<string>,
    baseDir: string,
  ): void {
    if (!shouldTrackDomainForTool(toolName)) {
      return;
    }

    const candidates = [input.path, input.directory, input.cwd].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    for (const value of candidates) {
      const domain = extractTopLevelDomain(value, baseDir);
      if (domain) {
        touchedDomains.add(domain);
      }
    }
  }

  // ── Evidence scoring ────────────────────────────────────────────────────

  getEvidenceProgressScore(input: EvidenceScoreInput): number {
    return (
      input.filesRead.size
      + input.filesModified.size * 2
      + input.filesCreated.size * 2
      + input.searchSignalHits
      + input.recentSearchEvidenceCount
    );
  }

  // ── Reset ───────────────────────────────────────────────────────────────

  reset(): void {
    this.state.lastToolCalls.length = 0;
    this.state.lastOutputSizes.length = 0;
    this.state.iterationsSinceProgress = 0;
    this.state.lastFailureCount = 0;
    this.state.lastProgressIteration = 0;
    this.state.lastSearchSignalHits = 0;
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function shouldTrackDomainForTool(toolName: string): boolean {
  return (
    toolName.startsWith('fs_') || toolName.includes('search') || toolName === 'shell_exec'
  );
}

export function extractTopLevelDomain(pathLike: string, baseDir: string): string | null {
  const absolutePath = path.isAbsolute(pathLike)
    ? path.normalize(pathLike)
    : path.normalize(path.resolve(baseDir, pathLike));
  const relative = path.relative(baseDir, absolutePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  const [topLevel] = relative.split(path.sep);
  if (!topLevel || topLevel === '.') {
    return null;
  }

  return topLevel;
}

export function countFailedToolResults(
  toolResults: ReadonlyArray<{ content?: string | unknown }>,
): number {
  return toolResults.reduce((count, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return content.startsWith('Error:') ? count + 1 : count;
  }, 0);
}
