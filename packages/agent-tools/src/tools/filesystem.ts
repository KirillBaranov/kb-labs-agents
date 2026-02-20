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
import { toolError } from './tool-error.js';

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
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate path is within working directory (prevent path traversal)
 */
function validatePath(workingDir: string, filePath: string): { valid: boolean; resolved: string; error?: string } {
  // Normalize and resolve the path
  let resolved = path.resolve(workingDir, filePath);

  // Resolve symlinks to prevent symlink-based bypasses
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch (error) {
    // If realpath fails, continue with resolved path (might be a non-existent file)
  }

  // Check if resolved path is within working directory using path.relative()
  // This is more secure than startsWith() which can be bypassed with symlinks
  const relative = path.relative(workingDir, resolved);

  // Path traversal attempt if relative path starts with '..'
  // Note: path.isAbsolute(relative) is always false since relative() returns a relative path
  if (relative.startsWith('..')) {
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

function normalizeListWindow(input: Record<string, unknown>): { offset: number; limit: number } {
  const rawOffset = Number(input.offset);
  const rawLimit = Number(input.limit);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIST_LIMIT, Math.floor(rawLimit))
    : DEFAULT_LIST_LIMIT;
  return { offset, limit };
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
        description: `Read file contents. Supports offset/limit for large files. Default: ${DEFAULT_LINES} lines, max: ${MAX_LINES_PER_READ} lines per read.`,
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
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { filePath, workingDir: context.workingDir },
        });
      }

      const fullPath = pathValidation.resolved;

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'FILE_NOT_FOUND',
          message: `"${filePath}" does not exist.`,
          retryable: true,
          hint: `Use fs_list(path="${path.dirname(filePath) || '.'}") to inspect available files.`,
          details: { filePath, workingDir: context.workingDir },
        });
      }

      // Check if it's a file
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        return toolError({
          code: 'NOT_A_FILE',
          message: `"${filePath}" is a directory, not a file.`,
          retryable: false,
          hint: 'Use fs_list for directories or provide a file path.',
          details: { filePath },
        });
      }

      // Check file size
      if (stats.size > MAX_FILE_SIZE) {
        return toolError({
          code: 'FILE_TOO_LARGE',
          message: `"${filePath}" is ${formatSize(stats.size)}, exceeds limit ${formatSize(MAX_FILE_SIZE)}.`,
          retryable: true,
          hint: `Use fs_read(path="${filePath}", offset=<line>, limit=<small number>).`,
          details: { filePath, size: stats.size, maxSize: MAX_FILE_SIZE },
        });
      }

      // Read file
      const content = fs.readFileSync(fullPath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Validate offset
      if (offset > totalLines) {
        return toolError({
          code: 'OFFSET_OUT_OF_RANGE',
          message: `Requested offset ${offset} but file has ${totalLines} lines.`,
          retryable: true,
          hint: `Use offset between 1 and ${totalLines}.`,
          details: { filePath, offset, totalLines },
        });
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
        description: `Write content to a file. Creates parent directories if needed. For partial edits, use fs_patch instead.`,
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
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { filePath, workingDir: context.workingDir },
        });
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

      // CAPTURE SNAPSHOT BEFORE WRITE
      if (context.fileChangeTracker) {
        const beforeContent = isOverwrite
          ? fs.readFileSync(fullPath, 'utf-8')
          : null;

        await context.fileChangeTracker.captureChange(
          filePath,
          'write',
          beforeContent,
          content,
          { isOverwrite }
        );
      }

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
        description: `Replace a range of lines in a file. You must fs_read the file first. Line numbers are 1-indexed and inclusive.`,
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
        return toolError({
          code: 'CANNOT_EDIT_UNREAD_FILE',
          message: `You must read "${filePath}" before editing it.`,
          retryable: true,
          hint: `Run fs_read(path="${filePath}") first, then patch specific lines.`,
          details: { filePath, startLine, endLine },
        });
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'FILE_NOT_FOUND',
          message: `"${filePath}" does not exist.`,
          retryable: true,
          hint: 'Use fs_list to find files or fs_write to create a new file.',
          details: { filePath },
        });
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
          return toolError({
            code: 'FILE_CHANGED_SINCE_READ',
            message: `"${filePath}" was modified since last read.`,
            retryable: true,
            hint: `Re-read: fs_read(path="${filePath}", offset=${Math.max(1, startLine - 10)}, limit=${endLine - startLine + 20})`,
            details: { filePath, startLine, endLine },
          });
        }
      }

      const allLines = currentContent.split('\n');
      const totalLines = allLines.length;

      // Validate line numbers
      if (startLine < 1 || startLine > totalLines) {
        return toolError({
          code: 'INVALID_START_LINE',
          message: `startLine ${startLine} is out of range (file has ${totalLines} lines).`,
          retryable: true,
          hint: `Use startLine between 1 and ${totalLines}.`,
          details: { filePath, startLine, totalLines },
        });
      }

      if (endLine < startLine || endLine > totalLines) {
        return toolError({
          code: 'INVALID_END_LINE',
          message: `endLine ${endLine} is invalid (startLine=${startLine}, file has ${totalLines} lines).`,
          retryable: true,
          hint: `Use endLine between ${startLine} and ${totalLines}.`,
          details: { filePath, startLine, endLine, totalLines },
        });
      }

      // Apply patch (convert to 0-indexed)
      const beforeLines = allLines.slice(0, startLine - 1);
      const afterLines = allLines.slice(endLine);
      const newLines = newContent ? newContent.split('\n') : [];

      const patchedContent = [...beforeLines, ...newLines, ...afterLines].join('\n');

      // Calculate line changes
      const removedCount = endLine - startLine + 1;
      const addedCount = newLines.length;
      const netChange = addedCount - removedCount;

      // CAPTURE SNAPSHOT BEFORE PATCH
      if (context.fileChangeTracker) {
        await context.fileChangeTracker.captureChange(
          filePath,
          'patch',
          currentContent,
          patchedContent,
          {
            startLine,
            endLine,
            linesAdded: addedCount,
            linesRemoved: removedCount,
          }
        );
      }

      // Write updated content
      fs.writeFileSync(fullPath, patchedContent, 'utf-8');

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
        description: `List files and directories at a path. Non-recursive by default.`,
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
            offset: {
              type: 'number',
              description: 'Result offset for pagination (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Result limit per page (default: ${DEFAULT_LIST_LIMIT}, max: ${MAX_LIST_LIMIT})`,
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const dirPath = (input.path as string) || '.';
      const recursive = (input.recursive as boolean) || false;
      const { offset, limit } = normalizeListWindow(input);

      // Validate path
      const pathValidation = validatePath(context.workingDir, dirPath);
      if (!pathValidation.valid) {
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { path: dirPath, workingDir: context.workingDir },
        });
      }

      const fullPath = pathValidation.resolved;

      // Check exists
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'DIRECTORY_NOT_FOUND',
          message: `"${dirPath}" does not exist.`,
          retryable: true,
          hint: 'Use fs_list on parent directory to discover valid paths.',
          details: { path: dirPath, workingDir: context.workingDir },
        });
      }

      // Check is directory
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return toolError({
          code: 'NOT_A_DIRECTORY',
          message: `"${dirPath}" is a file, not a directory.`,
          retryable: false,
          hint: 'Use fs_read for files or provide a directory path.',
          details: { path: dirPath },
        });
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

      const combinedEntries = [
        ...dirs.map((name) => ({ type: 'dir' as const, name })),
        ...files.map((name) => ({ type: 'file' as const, name })),
      ];
      const pageEntries = combinedEntries.slice(offset, offset + limit);
      const hasMore = offset + limit < combinedEntries.length;
      const nextOffset = hasMore ? offset + limit : null;
      const pageDirs = pageEntries.filter((entry) => entry.type === 'dir');
      const pageFiles = pageEntries.filter((entry) => entry.type === 'file');

      // Format output
      const outputParts = [
        `📁 ${dirPath === '.' ? 'Working Directory' : dirPath} (showing ${pageEntries.length}/${combinedEntries.length}, offset=${offset}, limit=${limit})`,
        '',
      ];

      if (pageDirs.length > 0) {
        outputParts.push(`Directories (${dirs.length}):`);
        for (const d of pageDirs) {
          outputParts.push(`  📁 ${d.name}/`);
        }
        outputParts.push('');
      }

      if (pageFiles.length > 0) {
        outputParts.push(`Files (${files.length}):`);
        for (const f of pageFiles) {
          // Get file size
          const filePath = path.join(fullPath, f.name);
          const fileStats = fs.statSync(filePath);
          outputParts.push(`  📄 ${f.name} (${formatSize(fileStats.size)})`);
        }
      }

      if (combinedEntries.length === 0) {
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

      if (hasMore) {
        outputParts.push('');
        outputParts.push(`Next page: fs_list(path="${dirPath}", recursive=${recursive ? 'true' : 'false'}, offset=${nextOffset}, limit=${limit})`);
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
          totalEntries: combinedEntries.length,
          offset,
          limit,
          hasMore,
          nextOffset,
        },
      };
    },
  };
}
