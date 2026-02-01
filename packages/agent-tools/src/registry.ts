/**
 * Tool registry for managing available tools
 */

import type { Tool, ToolContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  /**
   * Get tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool definitions for LLM
   */
  getDefinitions() {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Execute a tool
   */
  async execute(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.executor(input);
  }

  /**
   * Get context
   */
  getContext(): ToolContext {
    return this.context;
  }
}
