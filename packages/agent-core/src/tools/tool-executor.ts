/**
 * Tool Executor
 *
 * Executes tools discovered by ToolDiscoverer
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type { ToolCall, ToolResult } from '@kb-labs/agent-contracts';
import { spawn } from 'child_process';
import { join } from 'path';

/**
 * Tool Executor
 *
 * Executes different types of tools:
 * - Built-in filesystem tools (fs:*)
 * - Built-in shell tools (shell:*)
 * - KB Labs plugin commands (devkit:*, mind:*, workflow:*)
 */
export class ToolExecutor {
  constructor(private ctx: PluginContextV3) {}

  /**
   * Execute a tool call
   *
   * @param toolCall - Tool call from LLM
   * @returns Tool execution result
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      this.ctx.platform.logger.debug('Executing tool', {
        name: toolCall.name,
        input: toolCall.input,
      });

      let output: string;

      // Route to appropriate executor based on tool prefix
      if (toolCall.name.startsWith('fs:')) {
        output = await this.executeFilesystemTool(toolCall);
      } else if (toolCall.name.startsWith('shell:')) {
        output = await this.executeShellTool(toolCall);
      } else {
        // Assume it's a KB Labs plugin command
        output = await this.executePluginCommand(toolCall);
      }

      const durationMs = Date.now() - startTime;

      this.ctx.platform.logger.debug('Tool executed successfully', {
        name: toolCall.name,
        durationMs,
      });

      return {
        success: true,
        output,
        metadata: { durationMs },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.warn('Tool execution failed', {
        name: toolCall.name,
        error: errorMessage,
        durationMs,
      });

      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: errorMessage,
        },
        metadata: { durationMs },
      };
    }
  }

  /**
   * Execute filesystem tool (fs:*)
   */
  private async executeFilesystemTool(toolCall: ToolCall): Promise<string> {
    const fs = this.ctx.runtime.fs;
    const input = toolCall.input as Record<string, any>;

    switch (toolCall.name) {
      case 'fs:read': {
        const path = input.path as string;
        if (!path) {
          throw new Error('Missing required parameter: path');
        }
        const content = await fs.readFile(path, 'utf-8');
        return content;
      }

      case 'fs:write': {
        const path = input.path as string;
        const content = input.content as string;
        if (!path || content === undefined) {
          throw new Error('Missing required parameters: path, content');
        }
        await fs.writeFile(path, content, { encoding: 'utf-8' });
        return `File written successfully: ${path}`;
      }

      case 'fs:edit': {
        const path = input.path as string;
        const search = input.search as string;
        const replace = input.replace as string;
        if (!path || !search || replace === undefined) {
          throw new Error('Missing required parameters: path, search, replace');
        }

        // Read file
        const content = await fs.readFile(path, 'utf-8');

        // Check if search string exists
        if (!content.includes(search)) {
          throw new Error(`Search string not found in file: ${search}`);
        }

        // Replace and write back
        const newContent = content.replace(search, replace);
        await fs.writeFile(path, newContent, { encoding: 'utf-8' });

        return `File edited successfully: ${path}`;
      }

      case 'fs:list': {
        const path = input.path as string || '.';
        const recursive = input.recursive as boolean || false;

        const entries = await fs.readdir(path);

        if (recursive) {
          // For recursive listing, we'd need to implement recursive readdir
          // For MVP, just list current directory
          return entries.join('\n');
        }

        return entries.join('\n');
      }

      case 'fs:search': {
        const pattern = input.pattern as string;
        const text = input.text as string;
        const caseInsensitive = input.caseInsensitive as boolean || false;

        if (!pattern || !text) {
          throw new Error('Missing required parameters: pattern, text');
        }

        // Use glob to find files
        const { glob } = await import('glob');
        const files = await glob(pattern, {
          cwd: this.ctx.cwd,
          ignore: ['**/node_modules/**', '**/.git/**'],
        });

        // Search in each file
        const matches: string[] = [];
        const searchRegex = new RegExp(
          text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          caseInsensitive ? 'gi' : 'g'
        );

        for (const file of files) {
          try {
            const filePath = join(this.ctx.cwd, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (searchRegex.test(lines[i] || '')) {
                matches.push(`${file}:${i + 1}: ${lines[i]?.trim()}`);
              }
            }
          } catch {
            // Skip files that can't be read
            continue;
          }
        }

        return matches.length > 0
          ? matches.join('\n')
          : `No matches found for "${text}" in pattern "${pattern}"`;
      }

      default:
        throw new Error(`Unknown filesystem tool: ${toolCall.name}`);
    }
  }

  /**
   * Execute shell tool (shell:*)
   */
  private async executeShellTool(toolCall: ToolCall): Promise<string> {
    const input = toolCall.input as Record<string, any>;

    switch (toolCall.name) {
      case 'shell:exec': {
        const command = input.command as string;
        if (!command) {
          throw new Error('Missing required parameter: command');
        }

        return new Promise((resolve, reject) => {
          const child = spawn(command, {
            shell: true,
            cwd: this.ctx.cwd,
            env: process.env,
          });

          let stdout = '';
          let stderr = '';

          child.stdout?.on('data', (data) => {
            stdout += data.toString();
          });

          child.stderr?.on('data', (data) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Command failed with exit code ${code}:\n${stderr}`));
            } else {
              resolve(stdout || stderr || 'Command executed successfully');
            }
          });

          child.on('error', (error) => {
            reject(new Error(`Failed to execute command: ${error.message}`));
          });
        });
      }

      default:
        throw new Error(`Unknown shell tool: ${toolCall.name}`);
    }
  }

  /**
   * Execute KB Labs plugin command
   *
   * Examples:
   * - devkit:check-imports
   * - mind:rag-query
   * - workflow:run
   */
  private async executePluginCommand(toolCall: ToolCall): Promise<string> {
    const [pluginName, commandName] = toolCall.name.split(':');

    if (!pluginName || !commandName) {
      throw new Error(`Invalid plugin command format: ${toolCall.name}`);
    }

    const input = toolCall.input as Record<string, any>;

    // Build command args from input
    const args: string[] = [pluginName, commandName];

    // Convert input object to CLI flags
    for (const [key, value] of Object.entries(input)) {
      if (value === true) {
        // Boolean flag
        args.push(`--${key}`);
      } else if (value !== false && value !== null && value !== undefined) {
        // Value flag
        args.push(`--${key}`, String(value));
      }
    }

    // Execute using kb CLI
    return new Promise((resolve, reject) => {
      const kbCommand = 'pnpm kb';
      const fullCommand = `${kbCommand} ${args.join(' ')}`;

      this.ctx.platform.logger.debug('Executing plugin command', {
        command: fullCommand,
      });

      const child = spawn(fullCommand, {
        shell: true,
        cwd: this.ctx.cwd,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Command failed with exit code ${code}:\n${stderr}`));
        } else {
          resolve(stdout || stderr || 'Command executed successfully');
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to execute command: ${error.message}`));
      });
    });
  }
}
