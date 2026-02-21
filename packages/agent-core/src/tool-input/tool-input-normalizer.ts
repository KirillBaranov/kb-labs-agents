/**
 * Tool Input Normalizer
 *
 * Normalizes and validates tool inputs before execution:
 * - Resolves file paths (backup → source, JS → TS)
 * - Expands glob patterns
 * - Applies adaptive read limits
 * - Validates required params
 * - Blocks secondary artifacts
 */

import * as path from 'node:path';
import type { LLMTier } from '@kb-labs/agent-contracts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FileSystemReader {
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
}

export interface NormalizerContext {
  workingDir: string;
  currentTier: LLMTier;
  fileTotalLinesByPath: ReadonlyMap<string, number>;
  fileReadAttemptsByPath: Map<string, number>;
  smallReadWindowByPath: Map<string, number>;
  behaviorPolicy: {
    retrieval: {
      minReadWindowLines: number;
      maxConsecutiveSmallWindowReadsPerFile: number;
      smallFileReadAllThresholdLines: number;
    };
  };
  currentTask?: string;
  toolDefinitions: ReadonlyArray<{
    function: { name: string; parameters?: { required?: unknown } };
  }>;
}

// ---------------------------------------------------------------------------
// ToolInputNormalizer
// ---------------------------------------------------------------------------

export class ToolInputNormalizer {
  constructor(private readonly fs: FileSystemReader) {}

  // ── Main entry ──────────────────────────────────────────────────────────

  normalizeToolInput(
    toolName: string,
    input: Record<string, unknown>,
    ctx: NormalizerContext,
  ): Record<string, unknown> {
    const normalized = { ...input };

    if (
      toolName === 'glob_search'
      || toolName === 'grep_search'
      || toolName === 'find_definition'
      || toolName === 'code_stats'
    ) {
      this.normalizeDirectoryField(normalized, ctx.workingDir);
    }

    if (toolName === 'glob_search') {
      const pattern =
        typeof normalized.pattern === 'string'
          ? normalized.pattern
          : typeof normalized.query === 'string'
            ? normalized.query
            : '';
      if (pattern && typeof normalized.pattern !== 'string') {
        normalized.pattern = pattern;
      }

      if (typeof normalized.pattern === 'string') {
        const trimmed = normalized.pattern.trim();
        const hasGlobMeta = /[*?[\]{}]/.test(trimmed);
        if (trimmed && !hasGlobMeta) {
          normalized.pattern = `**/*${trimmed}*`;
        }
      }
    }

    if (toolName === 'fs_read' && typeof normalized.path === 'string') {
      const trimmedPath = normalized.path.trim();
      const fallbackPath = this.tryResolvePrimarySourcePath(trimmedPath, ctx.workingDir);
      if (fallbackPath) {
        normalized.path = fallbackPath;
      } else {
        const tsPath = this.tryResolveTsSourcePath(trimmedPath, ctx.workingDir);
        if (tsPath) {
          normalized.path = tsPath;
        }
      }

      const resolvedPath = String(normalized.path);
      const currentOffset = Number(normalized.offset);
      const safeOffset =
        Number.isFinite(currentOffset) && currentOffset > 0 ? Math.floor(currentOffset) : 1;
      normalized.offset = safeOffset;

      const requestedLimit = Number(normalized.limit);
      const adaptiveLimit = this.computeAdaptiveReadLimit(
        resolvedPath,
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.floor(requestedLimit)
          : undefined,
        safeOffset,
        ctx,
      );
      if (adaptiveLimit > 0) {
        normalized.limit = adaptiveLimit;
      }
    }

    if (toolName === 'shell_exec') {
      const rawCwd = typeof normalized.cwd === 'string' ? normalized.cwd.trim() : '';
      if (!rawCwd) {
        normalized.cwd = '.';
      }
    }

    return normalized;
  }

  // ── Validation ──────────────────────────────────────────────────────────

  assertToolCallIsAllowed(
    toolName: string,
    input: Record<string, unknown>,
    ctx: NormalizerContext,
    taskExplicitlyRequestsSecondaryArtifacts: boolean,
  ): void {
    const missingRequired = this.findMissingRequiredToolParams(toolName, input, ctx.toolDefinitions);
    if (missingRequired.length > 0) {
      throw new Error(
        `${toolName} is missing required input field(s): ${missingRequired.join(', ')}.`,
      );
    }

    if (toolName === 'glob_search') {
      const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
      if (!pattern) {
        throw new Error(
          'glob_search requires a non-empty glob pattern (e.g. "*.ts", "src/**/*.ts").',
        );
      }
    }

    if (toolName === 'fs_read') {
      const filePath = typeof input.path === 'string' ? input.path.trim() : '';
      if (!filePath) {
        throw new Error('fs_read requires a non-empty file path.');
      }

      const span = getRequestedReadSpan(input);
      if (span !== null && span < ctx.behaviorPolicy.retrieval.minReadWindowLines) {
        const smallReadCount = this.registerSmallReadWindow(filePath, ctx.smallReadWindowByPath);
        if (
          smallReadCount > ctx.behaviorPolicy.retrieval.maxConsecutiveSmallWindowReadsPerFile
        ) {
          throw new Error(
            `fs_read window too narrow repeatedly for "${filePath}" (${span} lines). Broaden read window or read full file before further micro-slices.`,
          );
        }
      } else if (
        span === null
        || span >= ctx.behaviorPolicy.retrieval.minReadWindowLines
      ) {
        ctx.smallReadWindowByPath.set(filePath, 0);
      }

      if (isSecondaryArtifactPath(filePath) && !taskExplicitlyRequestsSecondaryArtifacts) {
        throw new Error(
          `Blocked low-signal file "${filePath}". Read primary source files first (avoid backup/dist/build artifacts unless user explicitly asked).`,
        );
      }
    }
  }

  // ── Path resolution ─────────────────────────────────────────────────────

  tryResolvePrimarySourcePath(filePath: string, workingDir: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const removableSuffixes = ['.backup', '.bak', '.orig', '.tmp'];
    const matched = removableSuffixes.find((suffix) => lower.endsWith(suffix));
    if (!matched) {
      return null;
    }

    const candidate = normalized.slice(0, normalized.length - matched.length);
    const absCandidate = path.isAbsolute(candidate)
      ? candidate
      : path.join(workingDir, candidate);

    if (!this.fs.existsSync(absCandidate)) {
      return null;
    }

    return path.isAbsolute(filePath) ? absCandidate : candidate;
  }

  tryResolveTsSourcePath(filePath: string, workingDir: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.endsWith('.js')) {
      return null;
    }

    const base = normalized.slice(0, -3);
    const candidates = [`${base}.ts`, `${base}.tsx`];
    for (const candidate of candidates) {
      const absCandidate = path.isAbsolute(candidate)
        ? candidate
        : path.join(workingDir, candidate);
      if (this.fs.existsSync(absCandidate)) {
        return path.isAbsolute(filePath) ? absCandidate : candidate;
      }
    }
    return null;
  }

  resolveShellCwd(input: Record<string, unknown>, workingDir: string): string {
    const requested = typeof input.cwd === 'string' ? input.cwd.trim() : '.';
    if (!requested || requested === '.') {
      return workingDir;
    }
    return path.resolve(workingDir, requested);
  }

  // ── Adaptive read limits ────────────────────────────────────────────────

  computeAdaptiveReadLimit(
    filePath: string,
    requestedLimit: number | undefined,
    offset: number,
    ctx: NormalizerContext,
  ): number {
    const knownLines = ctx.fileTotalLinesByPath.get(filePath);
    const currentAttempts = ctx.fileReadAttemptsByPath.get(filePath) ?? 0;
    const nextAttempts = currentAttempts + 1;
    ctx.fileReadAttemptsByPath.set(filePath, nextAttempts);

    if (requestedLimit && requestedLimit >= 120) {
      return Math.min(1000, requestedLimit);
    }

    let baseline =
      ctx.currentTier === 'small' ? 180 : ctx.currentTier === 'medium' ? 300 : 500;

    if (
      knownLines
      && knownLines <= ctx.behaviorPolicy.retrieval.smallFileReadAllThresholdLines
    ) {
      baseline = Math.min(1000, knownLines);
    } else if (knownLines && knownLines >= 3000) {
      baseline =
        ctx.currentTier === 'small' ? 280 : ctx.currentTier === 'medium' ? 650 : 1000;
    } else if (knownLines && knownLines >= 1500) {
      baseline =
        ctx.currentTier === 'small' ? 240 : ctx.currentTier === 'medium' ? 500 : 900;
    }

    if (nextAttempts >= 3) {
      baseline = Math.min(1000, Math.round(baseline * 1.4));
    }
    if (nextAttempts >= 5) {
      baseline = Math.min(1000, Math.round(baseline * 1.6));
    }

    if (knownLines && offset > Math.max(1, knownLines - 400)) {
      baseline = Math.min(baseline, 400);
    }

    if (requestedLimit && requestedLimit > 0) {
      return Math.min(1000, Math.max(requestedLimit, baseline));
    }

    return Math.min(1000, baseline);
  }

  // ── Directory normalization ─────────────────────────────────────────────

  normalizeDirectoryField(
    input: Record<string, unknown>,
    workingDir: string,
  ): void {
    if (typeof input.directory !== 'string') {
      return;
    }

    const rawDirectory = input.directory.trim();
    if (!rawDirectory || rawDirectory === '.') {
      return;
    }

    const absolutePath = path.isAbsolute(rawDirectory)
      ? rawDirectory
      : path.resolve(workingDir, rawDirectory);

    const setDirectoryFromAbs = (absDir: string): void => {
      const relativeDir = path.relative(workingDir, absDir);
      if (!relativeDir || relativeDir === '.') {
        input.directory = '.';
        return;
      }
      input.directory = relativeDir.startsWith('..') ? '.' : relativeDir;
    };

    if (this.fs.existsSync(absolutePath)) {
      try {
        const stat = this.fs.statSync(absolutePath);
        if (stat.isFile()) {
          setDirectoryFromAbs(path.dirname(absolutePath));
        }
      } catch {
        // Keep original value on stat error.
      }
      return;
    }

    if (/\.[a-z0-9]+$/i.test(rawDirectory)) {
      const parentDir = path.dirname(absolutePath);
      if (this.fs.existsSync(parentDir)) {
        try {
          if (this.fs.statSync(parentDir).isDirectory()) {
            setDirectoryFromAbs(parentDir);
          }
        } catch {
          // Keep original value on stat error.
        }
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private findMissingRequiredToolParams(
    toolName: string,
    input: Record<string, unknown>,
    toolDefinitions: NormalizerContext['toolDefinitions'],
  ): string[] {
    const definition = toolDefinitions.find((d) => d.function.name === toolName);
    const params = definition?.function.parameters as { required?: unknown } | undefined;
    const required = Array.isArray(params?.required)
      ? params.required.filter((value): value is string => typeof value === 'string')
      : [];

    if (required.length === 0) {
      return [];
    }

    return required.filter((field) => {
      const value = input[field];
      if (value === undefined || value === null) {
        return true;
      }
      if (typeof value === 'string' && value.trim().length === 0) {
        return true;
      }
      return false;
    });
  }

  private registerSmallReadWindow(
    filePath: string,
    smallReadWindowByPath: Map<string, number>,
  ): number {
    const current = smallReadWindowByPath.get(filePath) ?? 0;
    const updated = current + 1;
    smallReadWindowByPath.set(filePath, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function getRequestedReadSpan(input: Record<string, unknown>): number | null {
  const limit = Number(input.limit);
  if (Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }

  const startLine = Number(input.startLine);
  const endLine = Number(input.endLine);
  if (Number.isFinite(startLine) && Number.isFinite(endLine) && endLine >= startLine) {
    return endLine - startLine + 1;
  }

  const offset = Number(input.offset);
  if (Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }

  return null;
}

export function isSecondaryArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/dist/')
    || normalized.includes('/build/')
    || normalized.endsWith('.map')
    || normalized.endsWith('.min.js')
    || normalized.includes('.backup')
    || normalized.endsWith('.bak')
    || normalized.endsWith('.orig')
    || normalized.endsWith('.tmp')
  );
}

export function isGuardRejectedToolCallError(errorMessage: string): boolean {
  return (
    errorMessage.startsWith('Blocked low-signal file')
    || errorMessage.includes('missing required input field')
    || errorMessage.includes('requires a non-empty glob pattern')
    || errorMessage.includes('requires a non-empty file path')
  );
}

export function isRiskyShellCommand(command: string): boolean {
  return /\b(pnpm|npm|yarn)\s+(test|lint|build|qa)\b/i.test(command);
}
