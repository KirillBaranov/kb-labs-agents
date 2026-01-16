/**
 * Execution Memory
 *
 * Tracks what the agent has learned during execution to prevent redundant work.
 *
 * Problem: Agent re-reads same files, re-calls same tools with same queries.
 * Solution: Remember findings from each tool call and make them available in context.
 *
 * Benefits:
 * - Reduces redundant tool calls
 * - Lowers token usage (don't need full tool results in history)
 * - Faster execution (skip duplicate work)
 */

import type { AgentExecutionStep } from '@kb-labs/agent-contracts';

/**
 * A learned fact from tool execution
 */
export interface Finding {
  /** Tool that produced this finding */
  tool: string;

  /** What was asked/searched for */
  query: string;

  /** Key fact learned */
  fact: string;

  /** When this was learned */
  step: number;

  /** Success/failure status */
  success: boolean;

  /** Optional: file path if finding relates to specific file */
  filePath?: string;
}

/**
 * Memory summary for prompt injection
 */
export interface MemorySummary {
  /** Total findings */
  count: number;

  /** Findings grouped by category */
  byCategory: {
    filesRead: Finding[];
    searchResults: Finding[];
    otherFindings: Finding[];
  };

  /** Formatted text for system prompt */
  formattedText: string;
}

/**
 * Execution Memory
 *
 * Stores and retrieves findings from tool executions.
 */
export class ExecutionMemory {
  private findings: Finding[] = [];
  private _taskGoal: string = '';
  private _completedSteps: number[] = [];

  /**
   * Add a finding from a tool execution
   */
  addFinding(finding: Finding): void {
    this.findings.push(finding);
  }

  /**
   * Extract findings from an execution step
   *
   * Automatically parses tool outputs to extract key learnings.
   */
  extractFromStep(step: AgentExecutionStep): void {
    // Track completed step
    this._completedSteps.push(step.step);

    if (!step.toolCalls || step.toolCalls.length === 0) {
      return;
    }

    for (const toolCall of step.toolCalls) {
      const tool = toolCall.name;
      const success = toolCall.success;

      // Extract query/input
      const query = this.extractQuery(
        typeof toolCall.input === 'string' || typeof toolCall.input === 'object'
          ? (toolCall.input as string | Record<string, unknown>)
          : {}
      );

      // Extract key fact from output
      const fact = this.extractFact(tool, toolCall.output || '', success);

      // Extract file path if relevant
      const filePath = this.extractFilePath(
        tool,
        typeof toolCall.input === 'string' || typeof toolCall.input === 'object'
          ? (toolCall.input as string | Record<string, unknown>)
          : {},
        toolCall.output
      );

      this.addFinding({
        tool,
        query,
        fact,
        step: step.step,
        success,
        filePath,
      });
    }
  }

  /**
   * Get all findings
   */
  getFindings(): Finding[] {
    return [...this.findings];
  }

  /**
   * Get findings for a specific tool
   */
  getFindingsByTool(toolName: string): Finding[] {
    return this.findings.filter((f) => f.tool === toolName);
  }

  /**
   * Check if we already have a finding for this query
   *
   * Helps prevent redundant tool calls.
   */
  hasFindingFor(tool: string, query: string): boolean {
    return this.findings.some(
      (f) => f.tool === tool && f.success && this.isSimilarQuery(f.query, query)
    );
  }

  /**
   * Get summary of findings for prompt injection
   */
  getSummary(): MemorySummary {
    const filesRead: Finding[] = [];
    const searchResults: Finding[] = [];
    const otherFindings: Finding[] = [];

    for (const finding of this.findings) {
      if (finding.tool === 'fs:read' && finding.success) {
        filesRead.push(finding);
      } else if (
        (finding.tool === 'mind:rag-query' || finding.tool === 'fs:search') &&
        finding.success
      ) {
        searchResults.push(finding);
      } else if (finding.success) {
        otherFindings.push(finding);
      }
    }

    const formattedText = this.formatFindings({
      filesRead,
      searchResults,
      otherFindings,
    });

    return {
      count: this.findings.filter((f) => f.success).length,
      byCategory: {
        filesRead,
        searchResults,
        otherFindings,
      },
      formattedText,
    };
  }

  /**
   * Clear all findings
   */
  clear(): void {
    this.findings = [];
    this._taskGoal = '';
    this._completedSteps = [];
  }

  /**
   * Set task goal
   */
  setTaskGoal(taskGoal: string): void {
    this._taskGoal = taskGoal;
  }

  /**
   * Get task goal
   */
  get taskGoal(): string {
    return this._taskGoal;
  }

  /**
   * Get completed steps
   */
  get completedSteps(): number[] {
    return [...this._completedSteps];
  }

  /**
   * Get known facts (extracted from successful findings)
   */
  get knownFacts(): string[] {
    return this.findings
      .filter((f) => f.success)
      .map((f) => `${f.tool}: ${f.fact}`)
      .slice(0, 10); // Limit to 10 most recent facts
  }

  /**
   * Extract query string from tool input
   */
  private extractQuery(input: string | Record<string, unknown>): string {
    if (typeof input === 'string') {
      return input;
    }

    // Common query fields
    if (input.text) return String(input.text);
    if (input.query) return String(input.query);
    if (input.pattern) return String(input.pattern);
    if (input.filePath) return String(input.filePath);

    return JSON.stringify(input);
  }

  /**
   * Extract key fact from tool output
   */
  private extractFact(tool: string, output: string, success: boolean): string {
    if (!success) {
      return `Failed: ${output.slice(0, 100)}`;
    }

    // Tool-specific fact extraction
    if (tool === 'fs:read') {
      return this.extractFileReadFact(output);
    }

    if (tool === 'mind:rag-query') {
      return this.extractRagQueryFact(output);
    }

    if (tool === 'fs:search') {
      return this.extractSearchFact(output);
    }

    // Generic: truncate output
    return output.length > 200 ? `${output.slice(0, 200)}...` : output;
  }

  /**
   * Extract fact from fs:read output
   */
  private extractFileReadFact(output: string): string {
    const lines = output.split('\n');

    // File is small, just note we read it
    if (lines.length < 50) {
      return `File read (${lines.length} lines)`;
    }

    // File is large, extract key info (interfaces, classes, exports)
    const keyLines = lines.filter(
      (line) =>
        line.includes('export') ||
        line.includes('interface') ||
        line.includes('class') ||
        line.includes('function')
    );

    if (keyLines.length > 0) {
      const sample = keyLines.slice(0, 3).join('; ');
      return `File contains: ${sample}${keyLines.length > 3 ? '...' : ''}`;
    }

    return `File read (${lines.length} lines)`;
  }

  /**
   * Extract fact from mind:rag-query output
   */
  private extractRagQueryFact(output: string): string {
    // Extract answer from JSON if present
    try {
      const json = JSON.parse(output);
      if (json.answer) {
        return json.answer.length > 200 ? `${json.answer.slice(0, 200)}...` : json.answer;
      }
    } catch {
      // Not JSON, use as-is
    }

    return output.length > 200 ? `${output.slice(0, 200)}...` : output;
  }

  /**
   * Extract fact from fs:search output
   */
  private extractSearchFact(output: string): string {
    const lines = output.split('\n');
    const fileCount = lines.filter((line) => line.trim()).length;

    if (fileCount === 0) {
      return 'No files found';
    }

    const sample = lines.slice(0, 3).join(', ');
    return `Found ${fileCount} files: ${sample}${fileCount > 3 ? '...' : ''}`;
  }

  /**
   * Extract file path from tool call
   */
  private extractFilePath(
    tool: string,
    input: string | Record<string, unknown>,
    output?: string
  ): string | undefined {
    if (tool === 'fs:read') {
      if (typeof input === 'string') return input;
      if (typeof input === 'object' && input.filePath) {
        return String(input.filePath);
      }
    }

    // Try to extract from output for search results
    if (tool === 'fs:search' && output) {
      const firstLine = output.split('\n')[0];
      if (firstLine) return firstLine.trim();
    }

    return undefined;
  }

  /**
   * Check if two queries are similar (simple heuristic)
   */
  private isSimilarQuery(query1: string, query2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().trim();
    return normalize(query1) === normalize(query2);
  }

  /**
   * Format findings for prompt injection
   */
  private formatFindings(categories: {
    filesRead: Finding[];
    searchResults: Finding[];
    otherFindings: Finding[];
  }): string {
    const parts: string[] = [];

    // Files read
    if (categories.filesRead.length > 0) {
      parts.push('**Files Already Read:**');
      for (const finding of categories.filesRead) {
        parts.push(`- ${finding.filePath || finding.query}: ${finding.fact}`);
      }
    }

    // Search results
    if (categories.searchResults.length > 0) {
      parts.push('\n**Previous Search Results:**');
      for (const finding of categories.searchResults) {
        parts.push(`- ${finding.query}: ${finding.fact}`);
      }
    }

    // Other findings
    if (categories.otherFindings.length > 0) {
      parts.push('\n**Other Findings:**');
      for (const finding of categories.otherFindings) {
        parts.push(`- ${finding.tool} (${finding.query}): ${finding.fact}`);
      }
    }

    return parts.join('\n');
  }
}
