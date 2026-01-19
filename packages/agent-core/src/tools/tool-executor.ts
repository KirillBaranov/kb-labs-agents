/**
 * Tool Executor
 *
 * Executes tools discovered by ToolDiscoverer
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type { ToolCall, ToolResult } from '@kb-labs/agent-contracts';
import { spawn } from 'child_process';
import { join } from 'path';
import { getParser, detectLanguage } from './parsers';
import type { ToolTraceRecorder } from '../trace/tool-trace-recorder.js';
import type { ISchemaValidator } from '../trace/schema-validator.js';
import { validateToolResult } from '../trace/schema-validator.js';

/**
 * Tool Executor
 *
 * Executes different types of tools:
 * - Built-in filesystem tools (fs:*)
 * - Built-in shell tools (shell:*)
 * - KB Labs plugin commands (devkit:*, mind:*, workflow:*)
 */
export class ToolExecutor {
  private agentId?: string;
  private sessionId: string;
  private traceRecorder?: ToolTraceRecorder;
  private schemaValidator?: ISchemaValidator;

  constructor(
    private ctx: PluginContextV3,
    private agentContext?: { tools: Array<{ name: string; inputSchema: any }> }
  ) {
    // Generate unique session ID for this ToolExecutor instance
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Set agent ID for cache key generation
   * Called by AgentExecutor after context is loaded
   */
  setAgentId(agentId: string): void {
    this.agentId = agentId;
  }

  /**
   * Set trace recorder for recording tool invocations
   * Called by AgentExecutor when trace is enabled
   */
  setTraceRecorder(recorder: ToolTraceRecorder): void {
    this.traceRecorder = recorder;
  }

  /**
   * Set schema validator for validating plugin tool outputs
   * Called by AgentExecutor when validation is enabled
   */
  setSchemaValidator(validator: ISchemaValidator): void {
    this.schemaValidator = validator;
  }

  /**
   * Execute a tool call
   *
   * @param toolCall - Tool call from LLM
   * @returns Tool execution result
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();

    // Record invocation start (if trace enabled)
    let invocationId: string | undefined;
    if (this.traceRecorder) {
      invocationId = await this.traceRecorder.recordStart(toolCall);
    }

    try {
      this.ctx.platform.logger.debug('Executing tool', {
        name: toolCall.name,
        input: toolCall.input,
      });

      // Generate cache key
      const cacheKey = this.generateCacheKey(toolCall);

      // Check if forceRefresh flag is set in input
      const input = toolCall.input as Record<string, any> | undefined;
      const forceRefresh = input?.forceRefresh === true;

      // Try to get from cache if not forcing refresh
      if (!forceRefresh && this.ctx.platform.cache) {
        const cached = await this.ctx.platform.cache.get<ToolResult>(cacheKey);
        if (cached) {
          const durationMs = Date.now() - startTime;
          console.log('[TOOL CACHE] ✅ HIT', {
            tool: toolCall.name,
            cacheKey: cacheKey.substring(0, 60) + '...',
            durationMs,
          });

          const result = {
            ...cached,
            metadata: { ...cached.metadata, durationMs, fromCache: true },
          };

          // Record invocation result (if trace enabled)
          if (this.traceRecorder && invocationId) {
            await this.traceRecorder.recordResult(invocationId, toolCall, result, durationMs);
          }

          // Return cached result with fromCache flag
          return result;
        }
      }

      // Cache miss or forceRefresh - execute tool
      let output: string;

      // Route to appropriate executor based on tool prefix
      if (toolCall.name.startsWith('fs:')) {
        output = await this.executeFilesystemTool(toolCall);
      } else if (toolCall.name.startsWith('shell:')) {
        output = await this.executeShellTool(toolCall);
      } else if (toolCall.name.startsWith('code:')) {
        output = await this.executeCodeTool(toolCall);
      } else {
        // Assume it's a KB Labs plugin command
        output = await this.executePluginCommand(toolCall);
      }

      const durationMs = Date.now() - startTime;

      this.ctx.platform.logger.debug('Tool executed successfully', {
        name: toolCall.name,
        durationMs,
      });

      let result: ToolResult = {
        success: true,
        output,
        metadata: { durationMs, fromCache: false },
      };

      // Validate output against schema (if validator enabled)
      if (this.schemaValidator) {
        result = await validateToolResult(this.schemaValidator, toolCall.name, result);
      }

      // Cache successful results for 1 minute (60000ms)
      if (result.success && this.ctx.platform.cache) {
        await this.ctx.platform.cache.set(cacheKey, result, 60000);
        console.log('[TOOL CACHE] 💾 STORED', {
          tool: toolCall.name,
          cacheKey: cacheKey.substring(0, 60) + '...',
          ttl: '60s',
        });
      }

      // Record invocation result (if trace enabled)
      if (this.traceRecorder && invocationId) {
        await this.traceRecorder.recordResult(invocationId, toolCall, result, durationMs);
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.warn('Tool execution failed', {
        name: toolCall.name,
        error: errorMessage,
        durationMs,
      });

      const result: ToolResult = {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: errorMessage,
        },
        metadata: { durationMs, fromCache: false },
      };

      // Record invocation result (if trace enabled)
      if (this.traceRecorder && invocationId) {
        await this.traceRecorder.recordResult(invocationId, toolCall, result, durationMs);
      }

      return result;
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
        const maxLines = (input.maxLines as number) || 2000;
        const startLine = (input.startLine as number) || 1;

        if (!path) {
          throw new Error('Missing required parameter: path');
        }

        try {
          // Check file size first to prevent reading huge files
          const stat = await fs.stat(path);
          const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

          if (stat.size > MAX_FILE_SIZE) {
            return [
              `⚠️ File too large: ${path}`,
              `Size: ${(stat.size / 1024).toFixed(1)} KB (limit: ${MAX_FILE_SIZE / 1024} KB)`,
              ``,
              `Use startLine and maxLines parameters to read specific sections:`,
              `  fs:read with path="${path}", startLine=1, maxLines=500`,
              ``,
              `Or use fs:search to find specific content in the file.`,
            ].join('\n');
          }

          const content = await fs.readFile(path, 'utf-8');
          const lines = content.split('\n');

          // Apply line limits
          const endLine = Math.min(startLine + maxLines - 1, lines.length);
          const selectedLines = lines.slice(startLine - 1, endLine);

          // Build output with line numbers
          const output: string[] = [];

          // Add header if truncated
          if (startLine > 1 || endLine < lines.length) {
            output.push(`📄 ${path} (lines ${startLine}-${endLine} of ${lines.length})`);
            output.push('');
          }

          // Add content with line numbers
          for (let i = 0; i < selectedLines.length; i++) {
            const lineNum = startLine + i;
            const line = selectedLines[i] || '';
            // Truncate very long lines
            const truncatedLine = line.length > 500 ? line.substring(0, 500) + '...[truncated]' : line;
            output.push(`${lineNum.toString().padStart(5)}│ ${truncatedLine}`);
          }

          // Add footer if more content available
          if (endLine < lines.length) {
            output.push('');
            output.push(`... ${lines.length - endLine} more lines. Use startLine=${endLine + 1} to continue.`);
          }

          return output.join('\n');
        } catch (error: any) {
          // Enhanced error handling for ENOENT (file not found)
          if (error.code === 'ENOENT') {
            return await this.handleFileNotFound(path);
          }
          throw error;
        }
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

      case 'fs:glob': {
        const pattern = input.pattern as string;
        const ignore = input.ignore as string[] | undefined;
        const maxResults = (input.maxResults as number) || 100;

        if (!pattern) {
          throw new Error('Missing required parameter: pattern');
        }

        const { glob } = await import('glob');
        const files = await glob(pattern, {
          cwd: this.ctx.cwd,
          ignore: ignore || [],
          nodir: true,
        });

        // Limit results
        const limited = files.slice(0, maxResults);
        const hasMore = files.length > maxResults;

        if (limited.length === 0) {
          return `No files found matching pattern: ${pattern}`;
        }

        let result = limited.join('\n');
        if (hasMore) {
          result += `\n\n... and ${files.length - maxResults} more files (use maxResults to increase limit)`;
        }

        return result;
      }

      case 'fs:exists': {
        const path = input.path as string;
        if (!path) {
          throw new Error('Missing required parameter: path');
        }

        try {
          const stat = await fs.stat(path);
          const type = stat.isDirectory() ? 'directory' : 'file';
          return `EXISTS: ${path} (${type})`;
        } catch {
          return `NOT_EXISTS: ${path}`;
        }
      }

      case 'fs:search': {
        const pattern = input.pattern as string;
        const text = input.text as string;
        const caseInsensitive = input.caseInsensitive as boolean || false;
        const ignore = input.ignore as string[] | undefined;

        if (!pattern || !text) {
          throw new Error('Missing required parameters: pattern, text');
        }

        // Use glob to find files
        const { glob } = await import('glob');
        const files = await glob(pattern, {
          cwd: this.ctx.cwd,
          ignore: ignore || [], // No default ignores - agent controls everything
        });

        // Search in each file and group by file
        const matchesByFile = new Map<string, Array<{ line: number; content: string }>>();
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
                if (!matchesByFile.has(file)) {
                  matchesByFile.set(file, []);
                }
                matchesByFile.get(file)!.push({
                  line: i + 1,
                  content: lines[i]?.trim() || '',
                });
              }
            }
          } catch {
            // Skip files that can't be read
            continue;
          }
        }

        if (matchesByFile.size === 0) {
          return `No matches found for "${text}" in pattern "${pattern}"`;
        }

        const totalMatches = Array.from(matchesByFile.values()).reduce(
          (sum, m) => sum + m.length,
          0
        );

        // Check if too many files found
        const tooManyFiles = matchesByFile.size > 20;
        const filesToShow = tooManyFiles
          ? Array.from(matchesByFile.entries()).slice(0, 20)
          : Array.from(matchesByFile.entries());

        // Format output - machine-readable format
        const formatted: string[] = [];

        // Add warning if too many files
        if (tooManyFiles) {
          formatted.push('⚠️  WARNING: Too many files found!');
          formatted.push(`Found ${matchesByFile.size} files with ${totalMatches} matches.`);
          formatted.push('Showing only first 20 files to avoid context overflow.');
          formatted.push('');
          formatted.push('RECOMMENDATION: Use the "ignore" parameter to filter results:');
          formatted.push('  ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"]');
          formatted.push('');
          formatted.push('Example:');
          formatted.push(`  fs:search with pattern="${pattern}", text="${text}", ignore=["**/node_modules/**", "**/dist/**"]`);
          formatted.push('');
          formatted.push('---');
          formatted.push('');
        }

        // Show files (limited to 20 if too many)
        for (const [file, matches] of filesToShow) {
          formatted.push(`FILE: ${file}`);
          for (const match of matches.slice(0, 3)) {
            // Only first 3 matches per file
            formatted.push(`  ${match.line}: ${match.content}`);
          }
          if (matches.length > 3) {
            formatted.push(`  ... ${matches.length - 3} more matches in this file`);
          }
          formatted.push(''); // Empty line between files
        }

        // Summary
        if (tooManyFiles) {
          formatted.push(`Showing 20 of ${matchesByFile.size} files. ${matchesByFile.size - 20} files omitted.`);
          formatted.push(`Total in ALL files: ${totalMatches} matches in ${matchesByFile.size} files`);
        } else {
          formatted.push(`Total: ${totalMatches} matches in ${matchesByFile.size} files`);
        }
        formatted.push('');

        // Path usage instruction
        formatted.push('INSTRUCTION: When using fs:read, use the FULL path shown after "FILE:" above.');
        formatted.push(
          'Example: If you see "FILE: kb-labs-mind/packages/mind-engine/src/indexing/stages/storage.ts"'
        );
        formatted.push(
          'Then use: fs:read with path "kb-labs-mind/packages/mind-engine/src/indexing/stages/storage.ts"'
        );

        const result = formatted.join('\n');

        // Debug logging - show actual output sent to LLM
        console.log('\n========== fs:search OUTPUT ==========');
        console.log(result);
        console.log('======================================\n');

        return result;
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
   * Execute code analysis tool (code:*)
   *
   * Provides AST-based code analysis using tree-sitter.
   * Falls back to regex patterns if tree-sitter is not available.
   */
  private async executeCodeTool(toolCall: ToolCall): Promise<string> {
    const fs = this.ctx.runtime.fs;
    const input = toolCall.input as Record<string, any>;

    switch (toolCall.name) {
      case 'code:find-definition': {
        const symbol = input.symbol as string;
        const symbolType = (input.type as string) || 'any';
        const scope = (input.scope as string) || '**/*.ts';

        if (!symbol) {
          throw new Error('Missing required parameter: symbol');
        }

        const { glob } = await import('glob');
        const files = await glob(scope, {
          cwd: this.ctx.cwd,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
          nodir: true,
        });

        const definitions: Array<{
          file: string;
          line: number;
          type: string;
          content: string;
          exported: boolean;
        }> = [];

        // Search files for definitions using tree-sitter
        for (const file of files.slice(0, 500)) {
          try {
            const filePath = join(this.ctx.cwd, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const language = detectLanguage(file);
            const parser = getParser(language);

            // Try to load parser (async, first time)
            await parser.loadParser();

            // Find definitions
            const defs = parser.findDefinitions(content, symbol);

            for (const def of defs) {
              // Filter by type if specified
              if (symbolType !== 'any' && def.type !== symbolType) {
                continue;
              }

              // Get context (lines around definition)
              const lines = content.split('\n');
              const startIdx = Math.max(0, def.startLine - 1);
              const endIdx = Math.min(lines.length, def.startLine + 5);
              const contextLines = lines.slice(startIdx, endIdx).join('\n');

              definitions.push({
                file,
                line: def.startLine,
                type: def.type,
                content: contextLines,
                exported: def.exported,
              });
            }
          } catch {
            continue;
          }
        }

        if (definitions.length === 0) {
          return `No definition found for symbol: ${symbol} (type: ${symbolType})`;
        }

        // Format output
        const output: string[] = [`Found ${definitions.length} definition(s) for "${symbol}":\n`];
        for (const def of definitions.slice(0, 10)) {
          const exportMarker = def.exported ? ' [exported]' : '';
          output.push(`FILE: ${def.file}:${def.line} (${def.type})${exportMarker}`);
          output.push('```');
          output.push(def.content);
          output.push('```\n');
        }

        if (definitions.length > 10) {
          output.push(`... and ${definitions.length - 10} more definitions`);
        }

        return output.join('\n');
      }

      case 'code:find-usages': {
        const symbol = input.symbol as string;
        const scope = (input.scope as string) || '**/*.ts';
        const includeDefinition = input.includeDefinition as boolean || false;

        if (!symbol) {
          throw new Error('Missing required parameter: symbol');
        }

        const { glob } = await import('glob');
        const files = await glob(scope, {
          cwd: this.ctx.cwd,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
          nodir: true,
        });

        const usages: Array<{
          file: string;
          line: number;
          column: number;
          content: string;
          isDefinition: boolean;
        }> = [];

        // Search files for usages using tree-sitter
        for (const file of files.slice(0, 500)) {
          try {
            const filePath = join(this.ctx.cwd, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const language = detectLanguage(file);
            const parser = getParser(language);

            await parser.loadParser();

            const fileUsages = parser.findUsages(content, symbol);

            for (const usage of fileUsages) {
              if (usage.isDefinition && !includeDefinition) {
                continue;
              }

              usages.push({
                file,
                line: usage.line,
                column: usage.column,
                content: usage.context,
                isDefinition: usage.isDefinition,
              });
            }
          } catch {
            continue;
          }
        }

        if (usages.length === 0) {
          return `No usages found for symbol: ${symbol}`;
        }

        // Group by file
        const byFile = new Map<string, typeof usages>();
        for (const usage of usages) {
          if (!byFile.has(usage.file)) {
            byFile.set(usage.file, []);
          }
          byFile.get(usage.file)!.push(usage);
        }

        // Format output
        const output: string[] = [`Found ${usages.length} usage(s) of "${symbol}" in ${byFile.size} file(s):\n`];

        for (const [file, fileUsages] of Array.from(byFile.entries()).slice(0, 15)) {
          output.push(`FILE: ${file}`);
          for (const usage of fileUsages.slice(0, 5)) {
            const marker = usage.isDefinition ? ' [DEF]' : '';
            output.push(`  ${usage.line}:${usage.column}: ${usage.content}${marker}`);
          }
          if (fileUsages.length > 5) {
            output.push(`  ... and ${fileUsages.length - 5} more in this file`);
          }
          output.push('');
        }

        if (byFile.size > 15) {
          output.push(`... and ${byFile.size - 15} more files`);
        }

        return output.join('\n');
      }

      case 'code:outline': {
        const path = input.path as string;
        const depth = (input.depth as number) || 2;

        if (!path) {
          throw new Error('Missing required parameter: path');
        }

        const filePath = join(this.ctx.cwd, path);
        const content = await fs.readFile(filePath, 'utf-8');
        const language = detectLanguage(path);
        const parser = getParser(language);

        await parser.loadParser();

        const outline = parser.getOutline(content, depth);

        if (outline.length === 0) {
          return `No outline items found in: ${path}`;
        }

        // Format output
        const output: string[] = [`Outline of ${path}:\n`];

        // Group by type for summary
        const byType = new Map<string, number>();
        for (const item of outline) {
          byType.set(item.type, (byType.get(item.type) || 0) + 1);
        }

        output.push('Summary:');
        for (const [type, count] of byType) {
          output.push(`  ${type}: ${count}`);
        }
        output.push('');

        output.push('Items:');
        for (const item of outline) {
          const indent = '  '.repeat(item.depth);
          output.push(`${indent}${item.line}: [${item.type}] ${item.name}`);

          // Show children if any
          if (item.children && depth > 1) {
            for (const child of item.children) {
              output.push(`  ${child.line}: [${child.type}] ${child.name}`);
            }
          }
        }

        return output.join('\n');
      }

      default:
        throw new Error(`Unknown code tool: ${toolCall.name}`);
    }
  }

  /**
   * Execute KB Labs plugin command via CLI spawn
   *
   * Uses subprocess execution instead of broken invoke API.
   * Commands are executed as: pnpm kb <commandId> --flag=value
   *
   * Examples:
   * - devkit:check-imports
   * - mind:rag-query
   * - workflow:run
   */
  private async executePluginCommand(toolCall: ToolCall): Promise<string> {
    const commandId = toolCall.name; // e.g., "mind:rag-query"

    if (!commandId.includes(':')) {
      throw new Error(`Invalid plugin command format: ${toolCall.name}`);
    }

    console.log('[SPAWN] Plugin command input:', {
      name: toolCall.name,
      input: toolCall.input,
      inputType: typeof toolCall.input,
    });

    // Normalize input (handle string -> object conversion)
    const input = this.normalizePluginInput(toolCall);

    // Build CLI arguments from input
    const args = this.buildCLIArgs(commandId, input);

    console.log('[SPAWN] Executing CLI command:', {
      command: 'pnpm kb',
      args: args.join(' '),
    });

    return new Promise((resolve, reject) => {
      const child = spawn('pnpm', ['kb', ...args], {
        cwd: this.ctx.cwd,
        env: {
          ...process.env,
          // Request JSON output for easier parsing
          KB_OUTPUT_FORMAT: 'json',
          // Disable interactive prompts
          CI: '1',
        },
        shell: true,
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
        console.log('[SPAWN] Command completed:', {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        if (code !== 0) {
          // Try to extract meaningful error from stderr or stdout
          const errorOutput = stderr || stdout || 'Unknown error';
          reject(new Error(`CLI command failed (exit ${code}): ${errorOutput.substring(0, 500)}`));
        } else {
          // Parse and return output
          const result = this.parseCLIOutput(stdout, stderr);
          resolve(result);
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn CLI command: ${error.message}`));
      });
    });
  }

  /**
   * Normalize plugin input (handle string -> object conversion)
   */
  private normalizePluginInput(toolCall: ToolCall): Record<string, any> {
    // If input is already an object, use it directly
    if (typeof toolCall.input === 'object' && toolCall.input !== null) {
      return toolCall.input as Record<string, any>;
    }

    // If input is a string, try to map it to the main parameter
    if (typeof toolCall.input === 'string' && this.agentContext) {
      const tool = this.agentContext.tools.find(t => t.name === toolCall.name);

      if (tool?.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, any>;
        const required = (tool.inputSchema.required as string[]) || [];

        // Find the "main" parameter:
        // 1. First required string parameter
        // 2. Common names: 'text', 'query', 'command', 'message', 'prompt'
        // 3. First string parameter
        let mainParam: string | undefined;

        // Try required params first
        for (const req of required) {
          if (props[req]?.type === 'string') {
            mainParam = req;
            break;
          }
        }

        // Try common names
        if (!mainParam) {
          const commonNames = ['text', 'query', 'command', 'message', 'prompt', 'input'];
          for (const name of commonNames) {
            if (props[name]?.type === 'string') {
              mainParam = name;
              break;
            }
          }
        }

        // Use first string parameter
        if (!mainParam) {
          for (const [key, value] of Object.entries(props)) {
            if ((value as any).type === 'string') {
              mainParam = key;
              break;
            }
          }
        }

        if (mainParam) {
          console.log(`[SPAWN] Converted string to object: { ${mainParam}: "${toolCall.input}" }`);
          return { [mainParam]: toolCall.input };
        }
      }
    }

    // Fallback: empty object
    return {};
  }

  /**
   * Build CLI arguments from command ID and input
   *
   * Converts: { text: "hello", mode: "instant" }
   * To: ["mind:rag-query", "--text", "hello", "--mode", "instant"]
   */
  private buildCLIArgs(commandId: string, input: Record<string, any>): string[] {
    const args: string[] = [commandId];

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) {
        continue;
      }

      // Handle boolean flags
      if (typeof value === 'boolean') {
        if (value) {
          args.push(`--${key}`);
        }
        // Skip false booleans (don't add --no-flag)
        continue;
      }

      // Handle arrays
      if (Array.isArray(value)) {
        for (const item of value) {
          args.push(`--${key}`, String(item));
        }
        continue;
      }

      // Handle strings and numbers
      args.push(`--${key}`, String(value));
    }

    // Always add --agent flag for JSON output (for commands that support it)
    if (!args.includes('--agent')) {
      args.push('--agent');
    }

    return args;
  }

  /**
   * Parse CLI output, extracting JSON if present
   */
  private parseCLIOutput(stdout: string, _stderr: string): string {
    // Try to find JSON in stdout (may be mixed with logs)
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // If it's a structured response, extract the answer
        if (parsed.answer) {
          return parsed.answer;
        }
        // Return pretty-printed JSON
        return JSON.stringify(parsed, null, 2);
      } catch {
        // Not valid JSON, fall through
      }
    }

    // Return raw stdout if no JSON found
    // Filter out common log prefixes
    const cleanedOutput = stdout
      .split('\n')
      .filter(line => {
        // Skip pnpm/npm lifecycle logs
        if (line.startsWith('>')) return false;
        // Skip empty lines at start/end
        if (line.trim() === '') return false;
        // Skip debug logs
        if (line.includes('[DEBUG]') || line.includes('[v3-adapter DEBUG]')) return false;
        // Skip AdapterLoader logs
        if (line.includes('[AdapterLoader]')) return false;
        return true;
      })
      .join('\n')
      .trim();

    return cleanedOutput || stdout;
  }

  /**
   * Generate cache key for tool call
   *
   * Format: agent-tools:{agentId}:{sessionId}:{toolName}:{inputHash}
   *
   * @param toolCall - Tool call to generate key for
   * @returns Cache key string
   */
  private generateCacheKey(toolCall: ToolCall): string {
    const agentId = this.agentId || 'unknown';
    const inputHash = this.hashInput(toolCall.input);
    return `agent-tools:${agentId}:${this.sessionId}:${toolCall.name}:${inputHash}`;
  }

  /**
   * Hash tool input for cache key
   *
   * Creates a deterministic hash from input object.
   * Removes forceRefresh flag before hashing to ensure consistent keys.
   *
   * @param input - Tool input (string, object, or undefined)
   * @returns Short hash string
   */
  private hashInput(input: any): string {
    // Handle undefined/null
    if (input === undefined || input === null) {
      return 'none';
    }

    // Clone and remove forceRefresh flag (shouldn't affect cache key)
    let inputToHash = input;
    if (typeof input === 'object' && !Array.isArray(input)) {
      inputToHash = { ...input };
      delete inputToHash.forceRefresh;
    }

    // Convert to deterministic string
    const str = typeof inputToHash === 'string'
      ? inputToHash
      : JSON.stringify(inputToHash, Object.keys(inputToHash).sort());

    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
    }

    // Convert to base36 (alphanumeric) and take first 8 chars
    return Math.abs(hash).toString(36).substring(0, 8);
  }

  /**
   * Handle file not found error with helpful suggestions
   *
   * Provides:
   * 1. Similar file names (fuzzy match)
   * 2. Contents of parent directory
   * 3. Actionable suggestions
   */
  private async handleFileNotFound(path: string): Promise<string> {
    const fs = this.ctx.runtime.fs;
    const { dirname, basename } = await import('path');

    const parentDir = dirname(path);
    const fileName = basename(path);
    const suggestions: string[] = [];

    // Try to list parent directory
    try {
      const entries = await fs.readdir(parentDir);

      // Find similar files (case-insensitive partial match)
      const similar = entries.filter(entry => {
        const lowerEntry = entry.toLowerCase();
        const lowerFile = fileName.toLowerCase();

        // Exact match (shouldn't happen, but just in case)
        if (lowerEntry === lowerFile) return true;

        // Contains the filename
        if (lowerEntry.includes(lowerFile) || lowerFile.includes(lowerEntry)) return true;

        // Remove extension and check stem
        const stemEntry = lowerEntry.replace(/\.[^.]+$/, '');
        const stemFile = lowerFile.replace(/\.[^.]+$/, '');
        if (stemEntry.includes(stemFile) || stemFile.includes(stemEntry)) return true;

        return false;
      }).slice(0, 5); // Limit to 5 suggestions

      if (similar.length > 0) {
        suggestions.push(`Similar files in ${parentDir}:`);
        similar.forEach(file => {
          suggestions.push(`  - ${parentDir}/${file}`);
        });
      } else {
        // No similar files, show all files in directory
        suggestions.push(`Files in ${parentDir}:`);
        const limited = entries.slice(0, 10); // Show max 10 files
        limited.forEach(file => {
          suggestions.push(`  - ${file}`);
        });
        if (entries.length > 10) {
          suggestions.push(`  ... and ${entries.length - 10} more files`);
        }
      }
    } catch (dirError) {
      // Parent directory doesn't exist either
      suggestions.push(`Parent directory ${parentDir} also doesn't exist.`);

      // Try to suggest checking path construction
      suggestions.push(`The path may be incorrectly constructed.`);
      suggestions.push(`Common issues:`);
      suggestions.push(`  - Wrong monorepo name (check: kb-labs-mind vs kb-labs-core)`);
      suggestions.push(`  - Missing/wrong package name`);
      suggestions.push(`  - File moved or deleted`);
    }

    // Build helpful error message
    const errorMessage = [
      `❌ File not found: ${path}`,
      ``,
      ...suggestions,
      ``,
      `💡 Suggestions:`,
      `  1. Use fs:list to explore the correct directory`,
      `  2. Try one of the similar files listed above`,
      `  3. Use mind:rag-query to search for the code semantically`,
      `  4. Check if the file was moved or renamed`,
    ].join('\n');

    throw new Error(errorMessage);
  }
}
