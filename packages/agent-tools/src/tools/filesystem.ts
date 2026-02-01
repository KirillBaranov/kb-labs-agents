/**
 * Filesystem tools for agent operations
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

/**
 * Write content to a file
 */
export function createFsWriteTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_write',
        description: 'Write content to a file. Creates parent directories if needed. Use for creating new files or completely replacing file contents.',
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

      const fullPath = path.resolve(context.workingDir, filePath);
      const dir = path.dirname(fullPath);

      // Create parent directories if needed
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content, 'utf-8');

      return {
        success: true,
        output: `File written successfully: ${filePath} (${content.length} bytes)`,
      };
    },
  };
}

/**
 * Read file contents
 */
export function createFsReadTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_read',
        description: 'Read the contents of a file. Returns full file content.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
          },
          required: ['path'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const fullPath = path.resolve(context.workingDir, filePath);

      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      return {
        success: true,
        output: content,
      };
    },
  };
}

/**
 * Edit file using search and replace
 */
export function createFsEditTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_edit',
        description: 'Edit a file by replacing exact text. The search text must match exactly (including whitespace). Use for making surgical edits to existing files.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            search: {
              type: 'string',
              description: 'Exact text to search for (must match exactly)',
            },
            replace: {
              type: 'string',
              description: 'Text to replace with',
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

      const fullPath = path.resolve(context.workingDir, filePath);

      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      if (!content.includes(search)) {
        return {
          success: false,
          error: `Search text not found in file: ${filePath}`,
        };
      }

      const newContent = content.replace(search, replace);
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      return {
        success: true,
        output: `File edited successfully: ${filePath}`,
      };
    },
  };
}

/**
 * List files in a directory
 */
export function createFsListTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_list',
        description: 'List files and directories at a path. Non-recursive. Use to explore directory structure.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to working directory (default: ".")',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const dirPath = (input.path as string) || '.';
      const fullPath = path.resolve(context.workingDir, dirPath);

      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `Directory not found: ${dirPath}`,
        };
      }

      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `Not a directory: ${dirPath}`,
        };
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .sort();
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();

      const output = [
        `Directory: ${dirPath}`,
        ``,
        `Directories (${dirs.length}):`,
        ...dirs.map(d => `  📁 ${d}`),
        ``,
        `Files (${files.length}):`,
        ...files.map(f => `  📄 ${f}`),
      ].join('\n');

      return {
        success: true,
        output,
      };
    },
  };
}
