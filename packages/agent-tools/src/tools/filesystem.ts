/**
 * Filesystem tools for agent operations
 *
 * Features:
 * - Atomic operations with offset/limit for large files
 * - Path traversal protection
 * - Clear error messages for agent understanding
 * - Size limits to prevent context overflow
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum file size to read in bytes (500KB) */
const MAX_FILE_SIZE = 500_000;

/** Maximum lines to return per read (prevents context overflow) */
const MAX_LINES_PER_READ = 500;

/** Default lines to return if not specified */
const DEFAULT_LINES = 200;

/** Maximum content size for write operations (1MB) */
const MAX_WRITE_SIZE = 1_000_000;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate path is within working directory (prevent path traversal)
 */
function validatePath(workingDir: string, filePath: string): { valid: boolean; resolved: string; error?: string } {
  // Normalize and resolve the path
  const resolved = path.resolve(workingDir, filePath);

  // Check if resolved path is within working directory
  if (!resolved.startsWith(workingDir)) {
    return {
      valid: false,
      resolved,
      error: `PATH_TRAVERSAL_ERROR: Cannot access "${filePath}" - path is outside working directory.

HOW TO FIX: Use paths relative to the working directory. Do not use ".." to navigate above it.
WORKING_DIR: ${workingDir}
ATTEMPTED_PATH: ${resolved}`,
    };
  }

  return { valid: true, resolved };
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_read - Read file with offset/limit support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read file contents with optional line range
 */
export function createFsReadTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_read',
        description: `Read file contents. For large files, use offset and limit to read specific line ranges.

LIMITS:
- Max ${MAX_LINES_PER_READ} lines per read (default: ${DEFAULT_LINES})
- Max file size: ${formatSize(MAX_FILE_SIZE)}

TIPS:
- For large files: first read with limit=50 to see structure, then read specific sections
- Use offset to skip to specific line numbers
- Line numbers are 1-indexed (first line is 1)`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            offset: {
              type: 'number',
              description: 'Line number to start from (1-indexed, default: 1)',
            },
            limit: {
              type: 'number',
              description: `Number of lines to read (default: ${DEFAULT_LINES}, max: ${MAX_LINES_PER_READ})`,
            },
          },
          required: ['path'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const offset = Math.max(1, (input.offset as number) || 1);
      const requestedLimit = (input.limit as number) || DEFAULT_LINES;
      const limit = Math.min(requestedLimit, MAX_LINES_PER_READ);

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `FILE_NOT_FOUND: "${filePath}" does not exist.

HOW TO FIX:
1. Use fs_list to see available files in the directory
2. Check for typos in the file name
3. Verify the path is relative to working directory

WORKING_DIR: ${context.workingDir}`,
        };
      }

      // Check if it's a file
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        return {
          success: false,
          error: `NOT_A_FILE: "${filePath}" is a directory, not a file.

HOW TO FIX: Use fs_list to explore directory contents, or specify a file path.`,
        };
      }

      // Check file size
      if (stats.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `FILE_TOO_LARGE: "${filePath}" is ${formatSize(stats.size)}, exceeds limit of ${formatSize(MAX_FILE_SIZE)}.

HOW TO FIX: This file is too large to read entirely. Use offset and limit to read sections:
- Read first 100 lines: fs_read(path="${filePath}", limit=100)
- Read lines 500-600: fs_read(path="${filePath}", offset=500, limit=100)
- Read last section: first check total lines, then read from there`,
        };
      }

      // Read file
      const content = fs.readFileSync(fullPath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Validate offset
      if (offset > totalLines) {
        return {
          success: false,
          error: `OFFSET_OUT_OF_RANGE: Requested offset ${offset} but file only has ${totalLines} lines.

HOW TO FIX: Use offset between 1 and ${totalLines}.`,
        };
      }

      // Extract requested lines (convert to 0-indexed)
      const startIndex = offset - 1;
      const endIndex = Math.min(startIndex + limit, totalLines);
      const selectedLines = allLines.slice(startIndex, endIndex);

      // Format output with line numbers
      const numberedLines = selectedLines.map((line, i) => {
        const lineNum = (startIndex + i + 1).toString().padStart(5, ' ');
        return `${lineNum}→${line}`;
      });

      // Build metadata header
      const hasMore = endIndex < totalLines;
      const header = [
        `File: ${filePath}`,
        `Lines: ${offset}-${endIndex} of ${totalLines}`,
        hasMore ? `(${totalLines - endIndex} more lines after this)` : '(end of file)',
        requestedLimit > MAX_LINES_PER_READ ? `Note: limit capped at ${MAX_LINES_PER_READ}` : '',
        '─'.repeat(60),
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: `${header}\n${numberedLines.join('\n')}`,
        metadata: {
          filePath,
          totalLines,
          readFrom: offset,
          readTo: endIndex,
          hasMore,
          fileSize: stats.size,
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_write - Write file with size limits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write content to a file
 */
export function createFsWriteTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_write',
        description: `Write content to a file. Creates parent directories if needed.

LIMITS:
- Max content size: ${formatSize(MAX_WRITE_SIZE)}

TIPS:
- Use for creating new files or completely replacing file contents
- For partial edits, use fs_edit instead
- Parent directories are created automatically`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['path', 'content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const content = input.content as string;

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // Check content size
      const contentSize = Buffer.byteLength(content, 'utf-8');
      if (contentSize > MAX_WRITE_SIZE) {
        return {
          success: false,
          error: `CONTENT_TOO_LARGE: Content is ${formatSize(contentSize)}, exceeds limit of ${formatSize(MAX_WRITE_SIZE)}.

HOW TO FIX: Split the content into smaller files, or write in chunks.`,
        };
      }

      // Check if overwriting existing file
      const isOverwrite = fs.existsSync(fullPath);

      // Create parent directories if needed
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(fullPath, content, 'utf-8');

      const lineCount = content.split('\n').length;

      return {
        success: true,
        output: `${isOverwrite ? 'Overwrote' : 'Created'} file: ${filePath}
Size: ${formatSize(contentSize)}
Lines: ${lineCount}`,
        metadata: {
          filePath,
          fileContent: content,
          size: contentSize,
          lines: lineCount,
          isOverwrite,
          uiHint: 'code',
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_edit - Edit file with search/replace
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edit file using search and replace
 */
export function createFsEditTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_edit',
        description: `Edit a file by replacing exact text.

REQUIREMENTS:
- Search text must match EXACTLY (including whitespace and indentation)
- By default replaces only FIRST occurrence
- Use replace_all=true to replace ALL occurrences

TIPS:
- First use fs_read to see the exact content and indentation
- Include enough context in search to make it unique
- If search fails, the text doesn't exist exactly as specified`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            search: {
              type: 'string',
              description: 'Exact text to search for (must match exactly including whitespace)',
            },
            replace: {
              type: 'string',
              description: 'Text to replace with',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences instead of just the first (default: false)',
            },
          },
          required: ['path', 'search', 'replace'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const search = input.search as string;
      const replace = input.replace as string;
      const replaceAll = (input.replace_all as boolean) || false;

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `FILE_NOT_FOUND: "${filePath}" does not exist.

HOW TO FIX:
1. Use fs_list to see available files
2. Check path spelling
3. Use fs_write to create a new file instead`,
        };
      }

      // Read current content
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check if search text exists
      if (!content.includes(search)) {
        // Provide helpful debugging info
        const searchPreview = search.length > 100 ? search.slice(0, 100) + '...' : search;
        const searchLines = search.split('\n').length;

        // Try to find similar text
        const searchFirstLine = search.split('\n')[0]?.trim() || '';
        const possibleMatches = content.split('\n')
          .map((line, i) => ({ line: line.trim(), lineNum: i + 1 }))
          .filter(({ line }) => line.includes(searchFirstLine.slice(0, 20)))
          .slice(0, 3);

        let hint = '';
        if (possibleMatches.length > 0) {
          hint = `\n\nPOSSIBLE MATCHES (first line similar):
${possibleMatches.map(m => `  Line ${m.lineNum}: "${m.line.slice(0, 60)}..."`).join('\n')}

TIP: Use fs_read with offset=${possibleMatches[0]?.lineNum} to see the exact content.`;
        }

        return {
          success: false,
          error: `SEARCH_TEXT_NOT_FOUND: The exact search text was not found in "${filePath}".

SEARCH TEXT (${searchLines} line(s)):
"${searchPreview}"

COMMON CAUSES:
1. Whitespace mismatch (spaces vs tabs, trailing spaces)
2. Line ending differences
3. The text was already changed
4. Typo in search text

HOW TO FIX:
1. Use fs_read to see the exact current content
2. Copy the exact text including whitespace
3. Make sure indentation matches exactly${hint}`,
        };
      }

      // Count occurrences
      const occurrences = content.split(search).length - 1;

      // Perform replacement
      let newContent: string;
      let replacedCount: number;

      if (replaceAll) {
        newContent = content.split(search).join(replace);
        replacedCount = occurrences;
      } else {
        newContent = content.replace(search, replace);
        replacedCount = 1;
      }

      // Write updated content
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      const message = replaceAll
        ? `Replaced all ${replacedCount} occurrence(s) in ${filePath}`
        : `Replaced 1 occurrence in ${filePath}${occurrences > 1 ? ` (${occurrences - 1} more occurrences remain)` : ''}`;

      return {
        success: true,
        output: message,
        metadata: {
          filePath,
          replacedCount,
          totalOccurrences: occurrences,
          replaceAll,
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_list - List directory contents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List files in a directory
 */
export function createFsListTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_list',
        description: `List files and directories at a path.

FEATURES:
- Shows files and directories separately
- Non-recursive by default
- Use recursive=true to see nested structure (limited depth)

TIPS:
- Start with root directory to understand project structure
- Navigate into subdirectories for more detail`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to working directory (default: ".")',
            },
            recursive: {
              type: 'boolean',
              description: 'Include subdirectories recursively (default: false, max depth: 3)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const dirPath = (input.path as string) || '.';
      const recursive = (input.recursive as boolean) || false;

      // Validate path
      const pathValidation = validatePath(context.workingDir, dirPath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // Check exists
      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `DIRECTORY_NOT_FOUND: "${dirPath}" does not exist.

HOW TO FIX:
1. Check the path spelling
2. Use fs_list with parent directory to see available directories
3. Working directory is: ${context.workingDir}`,
        };
      }

      // Check is directory
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `NOT_A_DIRECTORY: "${dirPath}" is a file, not a directory.

HOW TO FIX: Use fs_read to read file contents, or specify a directory path.`,
        };
      }

      // List contents
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });

      // Separate and sort
      const files = entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => !name.startsWith('.')) // Hide hidden files
        .sort();

      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => !name.startsWith('.') && name !== 'node_modules')
        .sort();

      // Format output
      const outputParts = [
        `📁 ${dirPath === '.' ? 'Working Directory' : dirPath}`,
        '',
      ];

      if (dirs.length > 0) {
        outputParts.push(`Directories (${dirs.length}):`);
        for (const d of dirs) {
          outputParts.push(`  📁 ${d}/`);
        }
        outputParts.push('');
      }

      if (files.length > 0) {
        outputParts.push(`Files (${files.length}):`);
        for (const f of files) {
          // Get file size
          const filePath = path.join(fullPath, f);
          const fileStats = fs.statSync(filePath);
          outputParts.push(`  📄 ${f} (${formatSize(fileStats.size)})`);
        }
      }

      if (dirs.length === 0 && files.length === 0) {
        outputParts.push('(empty directory)');
      }

      // Add recursive listing if requested
      if (recursive && dirs.length > 0) {
        outputParts.push('');
        outputParts.push('─'.repeat(40));
        outputParts.push('Recursive structure (depth 2):');

        for (const d of dirs.slice(0, 10)) { // Limit to 10 dirs
          outputParts.push(`\n📁 ${d}/`);
          const subPath = path.join(fullPath, d);
          try {
            const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
            const subDirs = subEntries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
            const subFiles = subEntries.filter(e => e.isFile() && !e.name.startsWith('.'));

            for (const sd of subDirs.slice(0, 5)) {
              outputParts.push(`  📁 ${sd.name}/`);
            }
            if (subDirs.length > 5) {
              outputParts.push(`  ... and ${subDirs.length - 5} more directories`);
            }

            for (const sf of subFiles.slice(0, 5)) {
              outputParts.push(`  📄 ${sf.name}`);
            }
            if (subFiles.length > 5) {
              outputParts.push(`  ... and ${subFiles.length - 5} more files`);
            }
          } catch {
            outputParts.push('  (unable to read)');
          }
        }

        if (dirs.length > 10) {
          outputParts.push(`\n... and ${dirs.length - 10} more directories`);
        }
      }

      return {
        success: true,
        output: outputParts.join('\n'),
        metadata: {
          path: dirPath,
          directoryCount: dirs.length,
          fileCount: files.length,
          directories: dirs,
          files,
        },
      };
    },
  };
}
