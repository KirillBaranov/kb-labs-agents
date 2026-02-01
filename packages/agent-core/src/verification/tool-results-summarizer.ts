/**
 * Tool Results Summarizer
 *
 * Prepares tool results for verification by extracting key information.
 * The verifier needs to know what files were read and what was found.
 */

import type {
  ToolResultRecord,
  ToolResultsSummary,
} from '@kb-labs/agent-contracts';

/**
 * Summarize tool results for verification.
 *
 * Extracts key information from tool calls:
 * - Files read/written
 * - Commands executed
 * - Searches performed
 *
 * @param results - Array of tool call records
 * @returns Summary with categorized results
 */
export function summarizeToolResults(results: ToolResultRecord[]): ToolResultsSummary {
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  const commandsRun: string[] = [];
  const searchQueries: string[] = [];
  const summaryParts: string[] = [];

  for (const result of results) {
    const toolName = result.tool.toLowerCase();
    const input = result.input;

    // Categorize by tool type
    if (toolName.includes('read') || toolName === 'fs:read' || toolName === 'fs_read') {
      const path = (input.path || input.file_path || input.filePath) as string;
      if (path) {
        filesRead.push(path);
        summaryParts.push(`Read file: ${path}`);
      }
    } else if (toolName.includes('write') || toolName.includes('edit') || toolName === 'fs:write' || toolName === 'fs_write') {
      const path = (input.path || input.file_path || input.filePath) as string;
      if (path) {
        filesWritten.push(path);
        summaryParts.push(`Wrote file: ${path}`);
      }
    } else if (toolName.includes('bash') || toolName.includes('exec') || toolName.includes('shell')) {
      const cmd = (input.command || input.cmd) as string;
      if (cmd) {
        commandsRun.push(cmd);
        summaryParts.push(`Ran command: ${cmd.slice(0, 100)}`);
      }
    } else if (toolName.includes('search') || toolName.includes('grep') || toolName.includes('glob')) {
      const query = (input.query || input.pattern || input.text) as string;
      if (query) {
        searchQueries.push(query);
        summaryParts.push(`Searched: ${query}`);
      }
    } else if (toolName.includes('mind') || toolName.includes('rag')) {
      const query = (input.text || input.query) as string;
      if (query) {
        searchQueries.push(query);
        summaryParts.push(`Mind RAG query: ${query}`);
        // Include RAG results summary (first 500 chars)
        if (result.output) {
          summaryParts.push(`  Result: ${result.output.slice(0, 500)}...`);
        }
      }
    } else if (toolName.includes('list') || toolName === 'fs:list' || toolName === 'fs_list') {
      const path = (input.path || input.directory) as string;
      if (path) {
        summaryParts.push(`Listed directory: ${path}`);
        // Include listing results
        if (result.output) {
          summaryParts.push(`  Contents: ${result.output.slice(0, 300)}...`);
        }
      }
    }
  }

  return {
    text: summaryParts.join('\n') || 'No tool calls recorded',
    filesRead: [...new Set(filesRead)],
    filesWritten: [...new Set(filesWritten)],
    commandsRun,
    searchQueries,
  };
}

/**
 * Extract files from tool result records.
 *
 * Convenience function to get just the file lists.
 */
export function extractFilesFromToolResults(results: ToolResultRecord[]): {
  filesRead: string[];
  filesWritten: string[];
} {
  const summary = summarizeToolResults(results);
  return {
    filesRead: summary.filesRead,
    filesWritten: summary.filesWritten,
  };
}
