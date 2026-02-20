/**
 * Shell execution tool
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

/**
 * Execute shell command
 */
export function createShellExecTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Execute a shell command and return output. Use for running builds, tests, git commands, etc. Commands run in the working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute',
            },
            cwd: {
              type: 'string',
              description: 'Optional working directory relative to agent workingDir. Use to run command in a specific package/subdirectory.',
            },
          },
          required: ['command'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const command = input.command as string;
      const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
      const resolvedCwd = requestedCwd
        ? path.resolve(context.workingDir, requestedCwd)
        : context.workingDir;

      const relative = path.relative(context.workingDir, resolvedCwd);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          success: false,
          error: `Invalid cwd "${requestedCwd}" - outside working directory.`,
        };
      }

      try {
        const output = execSync(command, {
          cwd: resolvedCwd,
          encoding: 'utf-8',
          maxBuffer: 5 * 1024 * 1024, // 5MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        return {
          success: true,
          output: `[cwd: ${resolvedCwd}]\n${output || '(command completed with no output)'}`,
          metadata: {
            cwd: resolvedCwd,
          },
        };
      } catch (error: any) {
        // execSync throws when command exits with non-zero code
        const stderr = error.stderr?.toString() || '';
        const stdout = error.stdout?.toString() || '';
        const exitCode = error.status ?? -1;

        return {
          success: false,
          error: `Command failed with exit code ${exitCode}\n[cwd: ${resolvedCwd}]\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}`,
          metadata: {
            cwd: resolvedCwd,
            exitCode,
          },
        };
      }
    },
  };
}
