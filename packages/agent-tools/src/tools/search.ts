/**
 * Search tools for finding files and content
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

/** Default directories to exclude from search */
const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.kb', '.pnpm', 'coverage', '__pycache__', '.venv', '.cache'];

/**
 * Build find exclude flags from exclude list
 */
function buildFindExcludes(excludes: string[]): string {
  return excludes.map(d => `! -path "*/${d}/*"`).join(' ');
}

/**
 * Build grep exclude-dir flags from exclude list
 */
function buildGrepExcludes(excludes: string[]): string {
  return excludes.map(d => `--exclude-dir=${d}`).join(' ');
}

function toSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Exec timeout for search commands (30s) */
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Check if directory exists and return error message if not.
 * Lists available top-level directories as a hint.
 */
function validateDirectory(workingDir: string, directory: string): string | null {
  const fullPath = path.resolve(workingDir, directory);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    return null;
  }

  // List available directories as hint
  let hint = '';
  try {
    const entries = fs.readdirSync(workingDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .sort();
    if (dirs.length > 0) {
      hint = `\nAvailable directories: ${dirs.slice(0, 15).join(', ')}${dirs.length > 15 ? ` ... (${dirs.length} total)` : ''}`;
    }
  } catch { /* ignore */ }

  return `Directory "${directory}" not found (resolved to ${fullPath}). Use "." to search from project root.${hint}`;
}

/**
 * Search for files by pattern (glob)
 */
export function createGlobSearchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'glob_search',
        description: 'Find files by name pattern (glob). Pattern matches filename only — use "*.ts" or "user.ts", not bare words. Returns up to 50 results.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern (e.g., "*.ts", "user.ts", "*user*.ts")',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: ".")',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories to exclude (default: node_modules, dist, .git, build, .next, .kb, .pnpm, coverage). Override to search in excluded dirs.',
            },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';
      const excludes = (input.exclude as string[] | undefined) || DEFAULT_EXCLUDES;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        const cmd = `find "${fullPath}" -type f -iname "${pattern}" ${buildFindExcludes(excludes)} | head -50`;

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: SEARCH_TIMEOUT_MS,
        });

        const files = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(f => path.relative(context.workingDir, f));

        if (files.length === 0) {
          return {
            success: true,
            output: `No files found matching pattern: ${pattern} in ${directory === '.' ? 'project root' : directory}. Note: glob_search matches filenames only. To search file contents, use grep_search. To find class/function definitions, use find_definition.`,
          };
        }

        const result = [
          `Found ${files.length} file(s) matching "${pattern}":`,
          '',
          ...files.map(f => `  ${f}`),
        ].join('\n');

        return {
          success: true,
          output: result,
        };
      } catch (error) {
        if (error instanceof Error && 'killed' in error && error.killed) {
          return {
            success: false,
            error: `Glob search timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Try narrowing the directory or pattern.`,
          };
        }
        return {
          success: false,
          error: `Glob search failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Search for text in files (grep)
 */
export function createGrepSearchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'grep_search',
        description: 'Search for exact text/regex in files. Returns file paths, line numbers, and matching lines. Up to 100 matches.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Text pattern to search for (can be regex)',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: ".")',
            },
            filePattern: {
              type: 'string',
              description: 'Filter by file pattern (e.g., "*.ts")',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories to exclude (default: node_modules, dist, .git, build, .next, .kb, .pnpm, coverage). Override to search in excluded dirs.',
            },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';
      const filePattern = input.filePattern as string | undefined;
      const excludes = (input.exclude as string[] | undefined) || DEFAULT_EXCLUDES;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        let cmd = `grep -rn ${toSingleQuoted(pattern)} "${fullPath}" ${buildGrepExcludes(excludes)}`;

        if (filePattern) {
          cmd += ` --include="${filePattern}"`;
        }

        cmd += ' | head -100';

        let output = '';
        let usedLiteralFallback = false;

        try {
          output = execSync(cmd, {
            cwd: context.workingDir,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
            timeout: SEARCH_TIMEOUT_MS,
          });
        } catch (error) {
          const status = (error as { status?: number }).status;
          const stderrRaw = (error as { stderr?: string | Buffer }).stderr;
          const stderr = typeof stderrRaw === 'string'
            ? stderrRaw
            : stderrRaw instanceof Buffer
              ? stderrRaw.toString('utf-8')
              : '';
          const looksLikeInvalidRegex = status === 2
            && /(unbalanced|parentheses|invalid regular expression|regular expression)/i.test(stderr);

          if (!looksLikeInvalidRegex) {
            throw error;
          }

          usedLiteralFallback = true;
          let literalCmd = `grep -rFn ${toSingleQuoted(pattern)} "${fullPath}" ${buildGrepExcludes(excludes)}`;
          if (filePattern) {
            literalCmd += ` --include="${filePattern}"`;
          }
          literalCmd += ' | head -100';
          output = execSync(literalCmd, {
            cwd: context.workingDir,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
            timeout: SEARCH_TIMEOUT_MS,
          });
        }

        const lines = output.trim().split('\n').filter(Boolean);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No matches found for "${pattern}" in ${directory === '.' ? 'project root' : directory}.${filePattern ? '' : ' Try adding filePattern (e.g. "*.ts") to narrow the search.'}`,
          };
        }

        const result = [
          `Found ${lines.length} match(es) for "${pattern}"${usedLiteralFallback ? ' (literal fallback)' : ''}:`,
          '',
          ...lines.map(line => {
            const match = line.match(/^(.+?):(\d+):(.+)$/);
            if (match) {
              const [, filePath, lineNum, content] = match;
              const relPath = path.relative(context.workingDir, filePath!);
              return `  ${relPath}:${lineNum}\n    ${content!.trim()}`;
            }
            return `  ${line}`;
          }),
        ].join('\n');

        return {
          success: true,
          output: result,
        };
      } catch (error) {
        // grep returns exit code 1 when no matches found
        if (error instanceof Error && 'status' in error && (error as any).status === 1) {
          return {
            success: true,
            output: `No matches found for "${pattern}" in ${directory === '.' ? 'project root' : directory}.${filePattern ? '' : ' Try adding filePattern (e.g. "*.ts") to narrow the search.'}`,
          };
        }

        if (error instanceof Error && 'killed' in error && (error as any).killed) {
          return {
            success: false,
            error: `Grep search timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Try narrowing the directory or adding a filePattern.`,
          };
        }

        return {
          success: false,
          error: `Grep search failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * List files in directory
 */
export function createListFilesTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and directories at a path. Good for exploring what exists.',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to list (default: "." for current directory)',
            },
            recursive: {
              type: 'boolean',
              description: 'Include subdirectories (default: false)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const directory = (input.directory as string) || '.';
      const recursive = (input.recursive as boolean) || false;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        // Build ls/find command
        let cmd: string;
        if (recursive) {
          cmd = `find "${fullPath}" -type f \
            ! -path "*/node_modules/*" \
            ! -path "*/.git/*" \
            ! -path "*/dist/*" \
            ! -path "*/.kb/*" \
            | head -100`;
        } else {
          cmd = `ls -la "${fullPath}" 2>/dev/null || echo "Directory not found"`;
        }

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });

        if (recursive) {
          const files = output
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(f => path.relative(context.workingDir, f));

          return {
            success: true,
            output: files.length > 0
              ? `Files in ${directory} (recursive):\n\n${files.map(f => `  ${f}`).join('\n')}`
              : `No files found in ${directory}`,
          };
        }

        return {
          success: true,
          output: `Contents of ${directory}:\n\n${output}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `List files failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Find files containing specific code pattern (semantic search)
 * Language-agnostic - works with any programming language
 */
export function createFindDefinitionTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'find_definition',
        description: 'Find where a symbol (class, function, interface, type, etc.) is defined. Works with any language. Uses project root as default directory, which works well for monorepos with nested packages.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the symbol to find (class, function, interface, type, struct, etc.)',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: ".")',
            },
            filePattern: {
              type: 'string',
              description: 'File pattern to search (e.g., "*.cs" for C#, "*.py" for Python). If not specified, searches all source files.',
            },
          },
          required: ['name'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const name = input.name as string;
      const directory = (input.directory as string) || '.';
      const filePattern = input.filePattern as string | undefined;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        // Language-agnostic definition patterns
        const patterns = [
          // Common across languages
          `class ${name}`,
          `interface ${name}`,
          `struct ${name}`,
          `enum ${name}`,
          // TypeScript/JavaScript
          `function ${name}`,
          `const ${name}`,
          `let ${name}`,
          `var ${name}`,
          `type ${name}`,
          `export.*${name}`,
          // Python
          `def ${name}`,
          // C#/Java
          `public.*${name}`,
          `private.*${name}`,
          `protected.*${name}`,
          `static.*${name}`,
          // Go
          `func ${name}`,
          `func \\(.*\\) ${name}`,
          // Rust
          `fn ${name}`,
          `impl ${name}`,
          `trait ${name}`,
          `mod ${name}`,
        ];

        // Build include flags for grep
        let includeFlags = '';
        if (filePattern) {
          includeFlags = `--include="${filePattern}"`;
        } else {
          // Default: search common source file extensions
          includeFlags = '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" ' +
            '--include="*.py" --include="*.cs" --include="*.java" --include="*.go" ' +
            '--include="*.rs" --include="*.rb" --include="*.php" --include="*.swift" ' +
            '--include="*.kt" --include="*.scala" --include="*.cpp" --include="*.c" --include="*.h"';
        }

        const cmd = `grep -rn -E "(${patterns.join('|')})" "${fullPath}" \
          ${includeFlags} \
          ${buildGrepExcludes(DEFAULT_EXCLUDES)} \
          --exclude-dir=bin \
          --exclude-dir=obj \
          --exclude-dir=target \
          | head -30`;

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: SEARCH_TIMEOUT_MS,
        });

        const lines = output.trim().split('\n').filter(Boolean);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No definition found for "${name}" in ${directory === '.' ? 'project root' : directory}. Try: grep_search for text matching, or glob_search with "*${name.toLowerCase()}*" for filename matching.`,
          };
        }

        const result = lines.map(line => {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (match) {
            const [, filePath, lineNum, content] = match;
            const relPath = path.relative(context.workingDir, filePath!);
            return `${relPath}:${lineNum}\n  ${content!.trim()}`;
          }
          return line;
        });

        return {
          success: true,
          output: `Found definition(s) for "${name}":\n\n${result.join('\n\n')}`,
        };
      } catch (error) {
        if (error instanceof Error && 'status' in error && (error as any).status === 1) {
          return {
            success: true,
            output: `No definition found for "${name}" in ${directory === '.' ? 'project root' : directory}. Try: grep_search for text matching, or glob_search with "*${name.toLowerCase()}*" for filename matching.`,
          };
        }
        if (error instanceof Error && 'killed' in error && (error as any).killed) {
          return {
            success: false,
            error: `Find definition timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Try specifying a narrower directory.`,
          };
        }
        return {
          success: false,
          error: `Find definition failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Get project structure overview — level-by-level exploration
 */
export function createProjectStructureTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'project_structure',
        description: 'Show directory contents at a given path. Defaults to project root, depth 1. Use to explore the codebase incrementally — first see top-level, then drill into specific directories.',
        parameters: {
          type: 'object',
          properties: {
            targetPath: {
              type: 'string',
              description: 'Directory to explore (default: project root). Use to drill deeper into a specific folder.',
            },
            depth: {
              type: 'number',
              description: 'How many levels deep (default: 1, max: 3)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const depth = Math.min((input.depth as number) || 1, 3);
      const targetPath = (input.targetPath as string) || '.';

      // Resolve and validate target path
      const resolvedPath = path.resolve(context.workingDir, targetPath);
      if (!resolvedPath.startsWith(context.workingDir)) {
        return {
          success: false,
          error: 'Cannot access paths outside project directory.',
        };
      }

      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        return {
          success: false,
          error: `"${targetPath}" is not a directory or does not exist.`,
        };
      }

      try {
        const skipNames = new Set(['node_modules', '.git', 'dist', '.next', 'build']);
        const lines: string[] = [];

        function listLevel(dir: string, prefix: string, currentDepth: number): void {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          // Separate dirs and files, sort each group
          const dirs = entries.filter(e => e.isDirectory() && !skipNames.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

          // Show directories with child counts
          for (const d of dirs) {
            const fullPath = path.join(dir, d.name);
            let childDirs = 0;
            let childFiles = 0;
            try {
              const children = fs.readdirSync(fullPath, { withFileTypes: true });
              childDirs = children.filter(c => c.isDirectory() && !skipNames.has(c.name)).length;
              childFiles = children.filter(c => c.isFile()).length;
            } catch {
              // inaccessible
            }
            const info = `${childDirs} dirs, ${childFiles} files`;
            lines.push(`${prefix}${d.name}/  (${info})`);

            if (currentDepth < depth) {
              listLevel(fullPath, prefix + '  ', currentDepth + 1);
            }
          }

          // Show files (only at requested depth, not intermediate levels for brevity)
          if (currentDepth === 1 || depth === 1) {
            for (const f of files) {
              lines.push(`${prefix}${f.name}`);
            }
          }
        }

        listLevel(resolvedPath, '', 1);

        const relPath = path.relative(context.workingDir, resolvedPath) || '.';
        const header = `${relPath}/ (depth ${depth})`;

        return {
          success: true,
          output: `${header}\n\n${lines.join('\n')}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Project structure failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Count lines of code - language agnostic
 */
export function createCodeStatsTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'code_stats',
        description: 'Get line counts and file counts by extension for a directory scope (not single-file line counts).',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to analyze (default: "."). If a file path is provided by mistake, use its parent directory.',
            },
            extensions: {
              type: 'string',
              description: 'Comma-separated list of extensions to count (e.g., "ts,tsx,js" or "cs,csproj" or "py"). If not specified, counts all source files.',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const directory = (input.directory as string) || '.';
      const extensionsInput = input.extensions as string | undefined;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        // Build extension filter
        let extFilter: string;
        if (extensionsInput) {
          const exts = extensionsInput.split(',').map(e => e.trim());
          extFilter = exts.map(e => `-name "*.${e}"`).join(' -o ');
        } else {
          // Default: common source file extensions
          extFilter = '-name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" ' +
            '-o -name "*.py" -o -name "*.cs" -o -name "*.java" -o -name "*.go" ' +
            '-o -name "*.rs" -o -name "*.rb" -o -name "*.php" -o -name "*.swift" ' +
            '-o -name "*.kt" -o -name "*.scala" -o -name "*.cpp" -o -name "*.c" -o -name "*.h"';
        }

        // Count lines total
        const totalCmd = `find "${fullPath}" -type f \\( ${extFilter} \\) \
          ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.git/*" \
          ! -path "*/bin/*" ! -path "*/obj/*" ! -path "*/target/*" ! -path "*/__pycache__/*" \
          -exec wc -l {} + 2>/dev/null | tail -1 || echo "0 total"`;

        const totalOutput = execSync(totalCmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
        }).trim();

        // Count files by extension
        const countByExtCmd = `find "${fullPath}" -type f \\( ${extFilter} \\) \
          ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.git/*" \
          ! -path "*/bin/*" ! -path "*/obj/*" ! -path "*/target/*" ! -path "*/__pycache__/*" \
          | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -15`;

        const countByExt = execSync(countByExtCmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
        }).trim();

        // Total file count
        const fileCountCmd = `find "${fullPath}" -type f \\( ${extFilter} \\) \
          ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.git/*" \
          ! -path "*/bin/*" ! -path "*/obj/*" ! -path "*/target/*" ! -path "*/__pycache__/*" | wc -l`;

        const fileCount = execSync(fileCountCmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
        }).trim();

        return {
          success: true,
          output: `Code statistics for directory ${directory}:\n\nTotal lines: ${totalOutput}\nTotal files: ${fileCount}\n\nFiles by extension:\n${countByExt}\n\nNote: This is directory-level aggregate. For a single file line count, use fs_read on that file and rely on metadata.totalLines.`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Code stats failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
