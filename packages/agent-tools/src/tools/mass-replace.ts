/**
 * Mass replace tool for batch text replacement across multiple files
 *
 * Features:
 * - Supports literal string or regex patterns
 * - Glob-based file selection
 * - File history tracking for rollback
 * - Dry-run mode for preview
 * - Safe: validates paths, checks file sizes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { Tool, ToolContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum file size to process (1MB) */
const MAX_FILE_SIZE = 1_000_000;

/** Maximum number of files to process in one operation */
const MAX_FILES = 100;

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Validate path is within working directory
// ═══════════════════════════════════════════════════════════════════════════

function validatePath(workingDir: string, filePath: string): { valid: boolean; resolved: string; error?: string } {
  let resolved = path.resolve(workingDir, filePath);

  // Resolve symlinks to prevent symlink-based bypasses
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch (error) {
    // If realpath fails, continue with resolved path (might be a non-existent file)
  }

  // Use path.relative() to check if resolved path escapes working directory
  // More secure than startsWith() which can be bypassed with symlinks
  const relative = path.relative(workingDir, resolved);

  // Path traversal attempt if relative path starts with '..'
  // Note: path.isAbsolute(relative) is always false since relative() returns a relative path
  if (relative.startsWith('..')) {
    return {
      valid: false,
      resolved,
      error: `PATH_TRAVERSAL_ERROR: Cannot access "${filePath}" - path is outside working directory.`,
    };
  }

  return { valid: true, resolved };
}

// ═══════════════════════════════════════════════════════════════════════════
// mass_replace - Batch text replacement with history tracking
// ═══════════════════════════════════════════════════════════════════════════

export function createMassReplaceTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'mass_replace',
        description: `Perform batch text replacement across multiple files with automatic rollback support.

⚠️ IMPORTANT: All changes are tracked in file history for easy rollback!

MODES:
- literal (default): Replace exact string matches
- regex: Use JavaScript regex pattern for complex replacements

SAFETY:
- Validates all paths within working directory
- Skips files >${MAX_FILE_SIZE / 1000}KB
- Limits to ${MAX_FILES} files per operation
- Dry-run mode available for preview
- Auto-creates snapshots for rollback

EXAMPLES:
1. Simple literal replacement:
   mass_replace(pattern="oldName", replacement="newName", scope="src/components", files="**/*.ts")

2. Regex replacement (remove console.log):
   mass_replace(pattern="console\\.log\\(.*?\\);?", replacement="", scope="src", files="**/*.ts", mode="regex")

3. Preview changes (dry-run):
   mass_replace(pattern="foo", replacement="bar", scope=".", files="*.js", dryRun=true)

USE CASES:
- Renaming variables/functions across files
- Removing debug statements
- Fixing common typos in documentation
- Updating import paths after refactoring
- Mass linting fixes`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Text or regex pattern to search for. For regex mode, use JavaScript regex syntax (without / delimiters).',
            },
            replacement: {
              type: 'string',
              description: 'Replacement text. In regex mode, can use $1, $2 for capture groups.',
            },
            scope: {
              type: 'string',
              description: 'REQUIRED: Directory to limit search scope (e.g., "src", "packages/agent-core", "."). Prevents accidental project-wide changes. Use "." for current directory only.',
            },
            files: {
              type: 'string',
              description: 'Glob pattern for files within scope (e.g., "**/*.ts", "*.js"). Combined with scope to form full path.',
            },
            mode: {
              type: 'string',
              enum: ['literal', 'regex'],
              description: 'Replacement mode: "literal" for exact string match (default), "regex" for regex patterns.',
            },
            dryRun: {
              type: 'boolean',
              description: 'Preview changes without applying them. Shows what would be changed.',
            },
            caseInsensitive: {
              type: 'boolean',
              description: 'For regex mode: make pattern case-insensitive (adds "i" flag).',
            },
          },
          required: ['pattern', 'replacement', 'scope', 'files'],
        },
      },
    },

    executor: async (input: Record<string, unknown>) => {
      const pattern = String(input.pattern || '');
      const replacement = String(input.replacement || '');
      const scope = String(input.scope || '');
      const filesPattern = String(input.files || '');
      const mode = String(input.mode || 'literal');
      const dryRun = Boolean(input.dryRun);
      const caseInsensitive = Boolean(input.caseInsensitive);

      // Validation
      if (!pattern) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "pattern" is required.',
        };
      }

      if (!scope) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "scope" is required. Specify directory to limit search (e.g., "src", "packages/agent-core", or "." for current dir).',
        };
      }

      if (!filesPattern) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "files" glob pattern is required.',
        };
      }

      if (mode !== 'literal' && mode !== 'regex') {
        return {
          success: false,
          error: `VALIDATION_ERROR: Invalid mode "${mode}". Must be "literal" or "regex".`,
        };
      }

      try {
        // Validate and resolve scope directory
        const scopeValidation = validatePath(context.workingDir, scope);
        if (!scopeValidation.valid) {
          return {
            success: false,
            error: scopeValidation.error,
          };
        }

        const scopePath = scopeValidation.resolved;
        if (!fs.existsSync(scopePath)) {
          return {
            success: false,
            error: `SCOPE_ERROR: Directory "${scope}" does not exist.`,
          };
        }

        if (!fs.statSync(scopePath).isDirectory()) {
          return {
            success: false,
            error: `SCOPE_ERROR: "${scope}" is not a directory.`,
          };
        }

        // Find matching files within scope
        const matches = await glob(filesPattern, {
          cwd: scopePath,
          nodir: true,
          absolute: false,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        });

        if (matches.length === 0) {
          return {
            success: true,
            output: `No files matched pattern: "${filesPattern}" in scope: "${scope}"`,
            metadata: {
              filesMatched: 0,
              filesChanged: 0,
              totalReplacements: 0,
              scope,
            },
          };
        }

        if (matches.length > MAX_FILES) {
          return {
            success: false,
            error: `TOO_MANY_FILES: Pattern matched ${matches.length} files, but limit is ${MAX_FILES}. Use more specific glob pattern.`,
          };
        }

        // Prepare regex or literal pattern
        let searchPattern: RegExp;
        if (mode === 'regex') {
          const flags = caseInsensitive ? 'gi' : 'g';
          try {
            searchPattern = new RegExp(pattern, flags);
          } catch (err) {
            return {
              success: false,
              error: `REGEX_ERROR: Invalid regex pattern "${pattern}": ${(err as Error).message}`,
            };
          }
        } else {
          // Literal mode: escape special chars and make global
          const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const flags = caseInsensitive ? 'gi' : 'g';
          searchPattern = new RegExp(escapedPattern, flags);
        }

        // Process files
        const results: Array<{
          file: string;
          replacements: number;
          preview?: string;
        }> = [];

        let totalReplacements = 0;
        let filesChanged = 0;

        for (const relPath of matches) {
          // Combine scope and relative path
          const scopedPath = path.join(scope, relPath);

          // Validate path
          const validation = validatePath(context.workingDir, scopedPath);
          if (!validation.valid) {
            return {
              success: false,
              error: validation.error,
            };
          }

          const fullPath = validation.resolved;

          // Check file exists and size
          if (!fs.existsSync(fullPath)) {
            continue; // Skip missing files
          }

          const stats = fs.statSync(fullPath);
          if (stats.size > MAX_FILE_SIZE) {
            results.push({
              file: scopedPath,
              replacements: 0,
              preview: `[SKIPPED: File too large (${(stats.size / 1024).toFixed(1)} KB > ${MAX_FILE_SIZE / 1024} KB)]`,
            });
            continue;
          }

          // Read file
          const beforeContent = fs.readFileSync(fullPath, 'utf-8');

          // Apply replacement
          const afterContent = beforeContent.replace(searchPattern, replacement);

          // Check if anything changed
          if (beforeContent === afterContent) {
            continue; // No changes, skip
          }

          const matchCount = (beforeContent.match(searchPattern) || []).length;
          totalReplacements += matchCount;
          filesChanged++;

          // Dry-run: collect preview
          if (dryRun) {
            // Show first 3 changes as preview
            const lines = beforeContent.split('\n');
            const changedLines: string[] = [];
            let previewCount = 0;

            for (let i = 0; i < lines.length && previewCount < 3; i++) {
              const line = lines[i]!;
              if (searchPattern.test(line)) {
                const newLine = line.replace(searchPattern, replacement);
                changedLines.push(`  Line ${i + 1}:`);
                changedLines.push(`    - ${line.slice(0, 80)}`);
                changedLines.push(`    + ${newLine.slice(0, 80)}`);
                previewCount++;
              }
            }

            results.push({
              file: scopedPath,
              replacements: matchCount,
              preview: changedLines.join('\n'),
            });
          } else {
            // Apply changes
            // Track file change for rollback (if tracker available)
            if (context.fileChangeTracker) {
              await context.fileChangeTracker.captureChange(
                scopedPath,
                'write',
                beforeContent,
                afterContent,
                { isMassReplace: true, pattern, replacement, mode, scope }
              );
            }

            // Write file
            fs.writeFileSync(fullPath, afterContent, 'utf-8');

            results.push({
              file: scopedPath,
              replacements: matchCount,
            });
          }
        }

        // Format output
        const summary = dryRun
          ? `[DRY RUN] Would replace in ${filesChanged} file(s):`
          : `✅ Replaced in ${filesChanged} file(s):`;

        const details = results
          .map((r) => {
            if (r.preview) {
              return `${r.file}: ${r.replacements} replacement(s)\n${r.preview}`;
            }
            return `${r.file}: ${r.replacements} replacement(s)`;
          })
          .join('\n\n');

        const output = `${summary}\n\n${details}\n\n` +
          `Scope: ${scope}\n` +
          `Total replacements: ${totalReplacements}\n` +
          `Files matched: ${matches.length}\n` +
          `Files changed: ${filesChanged}` +
          (dryRun ? '\n\n⚠️ DRY RUN: No files were modified. Remove dryRun=true to apply changes.' : '') +
          (!dryRun && context.fileChangeTracker
            ? '\n\n✅ All changes tracked in file history. Use agent:history and agent:rollback to undo if needed.'
            : '');

        return {
          success: true,
          output,
          metadata: {
            scope,
            filesMatched: matches.length,
            filesChanged,
            totalReplacements,
            dryRun,
            pattern,
            replacement,
            mode,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `EXECUTION_ERROR: ${(error as Error).message}`,
        };
      }
    },
  };
}
