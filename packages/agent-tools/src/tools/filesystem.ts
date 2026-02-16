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
import * as crypto from 'node:crypto';
import type { Tool, ToolContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum file size to read in bytes (500KB) */
const MAX_FILE_SIZE = 500_000;

/** Maximum lines to return per read (prevents context overflow) */
const MAX_LINES_PER_READ = 1000;

/** Default lines to return if not specified */
const DEFAULT_LINES = 100;

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
  if (bytes < 1024) {return `${bytes} bytes`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
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
        description: `Read file contents with automatic chunking for large files.

⚠️ IMPORTANT: DO NOT try to read entire large files (>1000 lines)!
- Read small sections first to understand structure
- Then request specific line ranges based on what you need
- Tool will warn you when there are more lines available

LIMITS:
- Max ${MAX_LINES_PER_READ} lines per read (default: ${DEFAULT_LINES})
- Max file size: ${formatSize(MAX_FILE_SIZE)}

WORKFLOW FOR LARGE FILES:
1. First read: fs_read(path="file.ts", limit=100) → see structure, get overview
2. Tool tells you: "⚠️ File has 2500 more lines after this section"
3. You decide: do I need to read more? If yes, which specific sections?
4. Read specific sections: fs_read(path="file.ts", offset=500, limit=200)

TIPS:
- Start with small limit (50-100 lines) to see file structure
- Use grep_search to find specific code before reading
- Only read what you actually need for the task
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
      const linesRemaining = totalLines - endIndex;

      const warnings = [];
      if (requestedLimit > MAX_LINES_PER_READ) {
        warnings.push(`⚠️ Limit capped at ${MAX_LINES_PER_READ} (you requested ${requestedLimit})`);
      }
      if (hasMore && linesRemaining > 100) {
        warnings.push(`⚠️ File has ${linesRemaining} more lines after this section`);
        warnings.push(`💡 To read more: fs_read(path="${filePath}", offset=${endIndex + 1}, limit=1000)`);
        warnings.push(`💡 Or request specific sections based on what you need`);
      }

      const header = [
        `File: ${filePath}`,
        `Lines: ${offset}-${endIndex} of ${totalLines}`,
        hasMore ? `(${linesRemaining} more lines after this)` : '(end of file)',
        ...warnings,
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
          // Add content hash for edit protection
          contentHash: computeHash(content),
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
// fs_patch - Edit file by line numbers (like Claude Code)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edit file by replacing a range of lines
 */
export function createFsPatchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_patch',
        description: `Edit file by replacing a range of lines with new content.

⚠️ CRITICAL PROTECTION: You MUST read the file before editing it!
- This prevents editing files you haven't seen
- This prevents conflicts when file was changed externally

WORKFLOW:
1. Read the file: fs_read(path="file.ts", offset=100, limit=50)
2. See the line numbers in the output (e.g., "  105→const x = 1;")
3. Edit those lines: fs_patch(path="file.ts", startLine=105, endLine=105, newContent="const x = 2;")

REQUIREMENTS:
- You must have read this file in this session (protection against blind edits)
- File must not have changed since you read it (protection against conflicts)
- Line numbers are from fs_read output (1-indexed)
- startLine and endLine are inclusive (both lines are replaced)

TIPS:
- Use fs_read first to see current content and line numbers
- To insert lines: set startLine = endLine (replaces single line)
- To delete lines: set newContent = "" (removes lines)
- Line numbers match exactly what fs_read shows you`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            startLine: {
              type: 'number',
              description: 'First line to replace (1-indexed, inclusive)',
            },
            endLine: {
              type: 'number',
              description: 'Last line to replace (1-indexed, inclusive)',
            },
            newContent: {
              type: 'string',
              description: 'New content to replace the line range with',
            },
          },
          required: ['path', 'startLine', 'endLine', 'newContent'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const startLine = input.startLine as number;
      const endLine = input.endLine as number;
      const newContent = input.newContent as string;

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // ═══════════════════════════════════════════════════════════════════════
      // PROTECTION 1: File must have been read in this session
      // ═══════════════════════════════════════════════════════════════════════
      if (context.filesRead && !context.filesRead.has(filePath)) {
        return {
          success: false,
          error: `CANNOT_EDIT_UNREAD_FILE: You must read "${filePath}" before editing it.

WHY THIS ERROR:
This is a safety feature to prevent:
- Editing files you haven't seen (blind edits)
- Making changes without understanding current content
- Accidentally breaking code you didn't review

HOW TO FIX:
1. First: fs_read(path="${filePath}", limit=100) → see file structure
2. Find the section you want to edit
3. Read that section: fs_read(path="${filePath}", offset=<line>, limit=50)
4. Then: fs_patch(path="${filePath}", startLine=<num>, endLine=<num>, newContent="...")

EXAMPLE:
  fs_read(path="${filePath}", offset=100, limit=20)
  → You see lines 100-120 with their content
  fs_patch(path="${filePath}", startLine=105, endLine=108, newContent="new code")`,
        };
      }

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
      const currentContent = fs.readFileSync(fullPath, 'utf-8');

      // ═══════════════════════════════════════════════════════════════════════
      // PROTECTION 2: File must not have changed since read
      // ═══════════════════════════════════════════════════════════════════════
      if (context.filesReadHash) {
        const savedHash = context.filesReadHash.get(filePath);
        const currentHash = computeHash(currentContent);

        if (savedHash && savedHash !== currentHash) {
          return {
            success: false,
            error: `FILE_CHANGED_SINCE_READ: "${filePath}" was modified since you last read it.

WHY THIS ERROR:
The file content changed between when you read it and now. This could cause:
- Line numbers to be wrong (your edit might target wrong lines)
- Merge conflicts (your changes might conflict with other changes)
- Loss of work (your edit might overwrite important changes)

HOW TO FIX:
1. Re-read the file to see current content:
   fs_read(path="${filePath}", offset=${Math.max(1, startLine - 10)}, limit=${endLine - startLine + 20})
2. Review the current state
3. Adjust your edit based on new line numbers/content
4. Apply the patch again

NOTE: This protection ensures you're always editing the file you actually read.`,
          };
        }
      }

      const allLines = currentContent.split('\n');
      const totalLines = allLines.length;

      // Validate line numbers
      if (startLine < 1 || startLine > totalLines) {
        return {
          success: false,
          error: `INVALID_START_LINE: startLine ${startLine} is out of range (file has ${totalLines} lines).

HOW TO FIX: Use startLine between 1 and ${totalLines}.`,
        };
      }

      if (endLine < startLine || endLine > totalLines) {
        return {
          success: false,
          error: `INVALID_END_LINE: endLine ${endLine} is invalid (startLine=${startLine}, file has ${totalLines} lines).

HOW TO FIX: Use endLine between ${startLine} and ${totalLines}.`,
        };
      }

      // Apply patch (convert to 0-indexed)
      const beforeLines = allLines.slice(0, startLine - 1);
      const afterLines = allLines.slice(endLine);
      const newLines = newContent ? newContent.split('\n') : [];

      const patchedContent = [...beforeLines, ...newLines, ...afterLines].join('\n');

      // Write updated content
      fs.writeFileSync(fullPath, patchedContent, 'utf-8');

      const removedCount = endLine - startLine + 1;
      const addedCount = newLines.length;
      const netChange = addedCount - removedCount;

      let action: string;
      if (addedCount === 0) {
        action = `Deleted ${removedCount} line(s)`;
      } else if (removedCount === addedCount) {
        action = `Replaced ${removedCount} line(s)`;
      } else if (netChange > 0) {
        action = `Replaced ${removedCount} line(s) with ${addedCount} line(s) (+${netChange})`;
      } else {
        action = `Replaced ${removedCount} line(s) with ${addedCount} line(s) (${netChange})`;
      }

      return {
        success: true,
        output: `${action} in ${filePath}
Lines ${startLine}-${endLine} → ${addedCount} new line(s)
File now has ${beforeLines.length + newLines.length + afterLines.length} lines (was ${totalLines})`,
        metadata: {
          filePath,
          startLine,
          endLine,
          linesRemoved: removedCount,
          linesAdded: addedCount,
          netChange,
          totalLinesBefore: totalLines,
          totalLinesAfter: beforeLines.length + newLines.length + afterLines.length,
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
