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
        description: 'Search for files matching a pattern using glob syntax. Use to find files by name or extension. Returns up to 50 results.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern to search for (e.g., "*.ts", "src/**/*.tsx")',
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
