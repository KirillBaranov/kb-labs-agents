/**
 * Search tools for finding files and content
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

/**
 * Search for files by pattern (glob)
 */
export function createGlobSearchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'glob_search',
        description: 'Search for files matching a pattern using glob syntax. Use to find files by name or extension. Returns up to 50 results. IMPORTANT: Pattern matches filename only - use exact filename like "user.ts" not just "user".',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern to search for. MUST include file extension for exact match (e.g., "user.ts", "*.ts", "*.tsx"). Pattern "user" will NOT find "user.ts" - use "user.ts" or "*user*.ts" instead.',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: ".")',
            },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        // Build find command to search for pattern
        // Exclude common directories
        const cmd = `find "${fullPath}" -type f -name "${pattern}" \
          ! -path "*/node_modules/*" \
          ! -path "*/.git/*" \
          ! -path "*/dist/*" \
          ! -path "*/build/*" \
          ! -path "*/.next/*" \
          | head -50`;

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024, // 1MB
        });

        const files = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(f => path.relative(context.workingDir, f));

        if (files.length === 0) {
          return {
            success: true,
            output: `No files found matching pattern: ${pattern}`,
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
        description: 'Search for text patterns in files using grep. Returns file paths and line numbers. Use to find where specific code or text appears. Returns up to 100 matches.',
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
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';
      const filePattern = input.filePattern as string | undefined;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        // Build grep command
        let cmd = `grep -rn "${pattern}" "${fullPath}" \
          --exclude-dir=node_modules \
          --exclude-dir=.git \
          --exclude-dir=dist \
          --exclude-dir=build \
          --exclude-dir=.next`;

        if (filePattern) {
          cmd += ` --include="${filePattern}"`;
        }

        cmd += ' | head -100';

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024, // 1MB
        });

        const lines = output.trim().split('\n').filter(Boolean);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No matches found for pattern: ${pattern}`,
          };
        }

        const result = [
          `Found ${lines.length} match(es) for "${pattern}":`,
          '',
          ...lines.map(line => {
            // Parse grep output: /path/to/file:linenum:content
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
        if (error instanceof Error && 'status' in error && error.status === 1) {
          return {
            success: true,
            output: `No matches found for pattern: ${pattern}`,
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
        description: 'List all files in a directory. Use this FIRST when you need to find files - it shows exactly what files exist. More reliable than glob_search for discovering available files.',
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
        description: 'Find where a class, function, interface, type, struct, enum, or variable is defined. Works with any language (TypeScript, Python, C#, Go, Rust, Java, etc.). Searches for common definition patterns.',
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
          --exclude-dir=node_modules \
          --exclude-dir=dist \
          --exclude-dir=.git \
          --exclude-dir=bin \
          --exclude-dir=obj \
          --exclude-dir=target \
          --exclude-dir=__pycache__ \
          --exclude-dir=.venv \
          | head -30`;

        const output = execSync(cmd, {
          cwd: context.workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });

        const lines = output.trim().split('\n').filter(Boolean);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No definition found for "${name}"`,
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
        if (error instanceof Error && 'status' in error && error.status === 1) {
          return {
            success: true,
            output: `No definition found for "${name}"`,
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
 * Get project structure overview
 */
export function createProjectStructureTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'project_structure',
        description: 'Get an overview of the project structure - shows directories and key files. Use this to understand the codebase layout before diving into specific files.',
        parameters: {
          type: 'object',
          properties: {
            depth: {
              type: 'number',
              description: 'How many levels deep to show (default: 3)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const depth = (input.depth as number) || 3;

      try {
        // Use tree command if available, otherwise fallback to find
        let output: string;
        try {
          output = execSync(`tree -L ${depth} -I "node_modules|dist|.git|.next|build" --dirsfirst`, {
            cwd: context.workingDir,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });
        } catch {
          // Fallback to find + awk for systems without tree
          output = execSync(`find . -maxdepth ${depth} -type d \
            ! -path "*/node_modules/*" \
            ! -path "*/.git/*" \
            ! -path "*/dist/*" \
            | sort | head -100`, {
            cwd: context.workingDir,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });
        }

        return {
          success: true,
          output: `Project structure:\n\n${output}`,
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
        description: 'Get code statistics - line counts by file type. Works with any language. Shows breakdown by extension.',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to analyze (default: ".")',
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
          output: `Code statistics for ${directory}:\n\nTotal lines: ${totalOutput}\nTotal files: ${fileCount}\n\nFiles by extension:\n${countByExt}`,
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
