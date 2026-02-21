/**
 * Centralized configuration constants for agent tools.
 *
 * All magic numbers and default values live here — tool implementations
 * import from this module instead of defining inline constants.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem tool config
// ═══════════════════════════════════════════════════════════════════════════

export const FILESYSTEM_CONFIG = {
  /** Hard cap on file size to read (500KB) — prevents context overflow */
  maxFileSize: 500_000,
  /** Hard cap on lines returned per read — prevents context overflow */
  maxLinesPerRead: 1_000,
  /** Default lines to return when not specified */
  defaultLines: 100,
  /** Hard cap on content size for write operations (1MB) */
  maxWriteSize: 1_000_000,
  /** Default limit for directory listing */
  defaultListLimit: 100,
  /** Maximum limit for directory listing */
  maxListLimit: 200,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Search tool config
// ═══════════════════════════════════════════════════════════════════════════

export const SEARCH_CONFIG = {
  /** Timeout for search commands (30s) */
  timeoutMs: 30_000,
  /** Max stdout buffer for search commands (16MB) */
  maxBuffer: 16 * 1024 * 1024,
  /** Default result limit */
  defaultResultLimit: 100,
  /** Maximum result limit */
  maxResultLimit: 200,
  /** Directories excluded from search by default */
  defaultExcludes: [
    'node_modules', '.git', 'dist', 'build', '.next',
    '.kb', '.pnpm', 'coverage', '__pycache__', '.venv', '.cache',
  ] as string[],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Shell tool config
// ═══════════════════════════════════════════════════════════════════════════

export const SHELL_CONFIG = {
  /** Max stdout buffer — aligned with SEARCH_CONFIG (16MB) */
  maxBuffer: 16 * 1024 * 1024,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TODO tool config
// ═══════════════════════════════════════════════════════════════════════════

export const TODO_CONFIG = {
  /** Cache key prefix for todo lists */
  cachePrefix: 'agent:todo:',
  /** TTL for cached todo lists (7 days) */
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Delegation tool config
// ═══════════════════════════════════════════════════════════════════════════

export const DELEGATION_CONFIG = {
  /** Default max iterations for spawned sub-agents */
  defaultMaxIterations: 10,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Mass replace tool config
// ═══════════════════════════════════════════════════════════════════════════

export const MASS_REPLACE_CONFIG = {
  /** Hard cap on file size to process (1MB) — same as maxWriteSize */
  maxFileSize: 1_000_000,
  /** Maximum number of files to process in one operation */
  maxFiles: 100,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Source file extensions — single source of truth
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Source file extensions grouped by language.
 * Use ALL_SOURCE_EXTENSIONS or the helper functions for CLI flags.
 */
export const SOURCE_FILE_EXTENSIONS = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx'],
  python: ['py'],
  csharp: ['cs'],
  java: ['java'],
  go: ['go'],
  rust: ['rs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  kotlin: ['kt'],
  scala: ['scala'],
  cpp: ['cpp', 'c', 'h', 'cc', 'cxx'],
} as const;

/** Flat list of all source file extensions */
export const ALL_SOURCE_EXTENSIONS: readonly string[] = Object.values(SOURCE_FILE_EXTENSIONS).flat();

/**
 * Build `--include="*.ext"` flags for ripgrep / grep.
 * @example toRgIncludes(ALL_SOURCE_EXTENSIONS)
 * // → '--include="*.ts" --include="*.tsx" ...'
 */
export function toRgIncludes(exts: readonly string[]): string {
  return exts.map(e => `--include="*.${e}"`).join(' ');
}

/**
 * Build `-name "*.ext"` flags for `find` (joined with ` -o `).
 * @example toFindNames(ALL_SOURCE_EXTENSIONS)
 * // → '-name "*.ts" -o -name "*.tsx" ...'
 */
export function toFindNames(exts: readonly string[]): string {
  return exts.map(e => `-name "*.${e}"`).join(' -o ');
}
