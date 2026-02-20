/**
 * Shell execution tool
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { toolError } from './tool-error.js';

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
        return toolError({
          code: 'INVALID_CWD',
          message: `Invalid cwd "${requestedCwd}" - outside working directory.`,
          retryable: false,
          hint: 'Use cwd relative to the agent working directory.',
          details: { requestedCwd, resolvedCwd, workingDir: context.workingDir },
        });
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
        const commandText = typeof command === 'string' ? command.trim() : '';

        if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
          return toolError({
            code: 'SHELL_TIMEOUT',
            message: `Command timed out in ${resolvedCwd}`,
            retryable: true,
            hint: 'Use a narrower command or run package-scoped command via cwd.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        if (/command not found/i.test(stderr) || exitCode === 127) {
          return toolError({
            code: 'COMMAND_NOT_FOUND',
            message: `Command not found: ${commandText}`,
            retryable: false,
            hint: 'Check binary name or ensure dependency is installed in this workspace.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        if (/permission denied/i.test(stderr) || exitCode === 126) {
          return toolError({
            code: 'PERMISSION_DENIED',
            message: `Permission denied while executing command in ${resolvedCwd}`,
            retryable: false,
            hint: 'Check file permissions and executable bits.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        return toolError({
          code: 'NON_ZERO_EXIT',
          message: `Command failed with exit code ${exitCode}`,
          retryable: true,
          hint: 'Inspect stderr/stdout tails and adjust command or cwd.',
          details: {
            cwd: resolvedCwd,
            exitCode,
            stdoutTail: stdout.slice(-1000),
            stderrTail: stderr.slice(-1000),
          },
        });
      }
    },
  };
}
