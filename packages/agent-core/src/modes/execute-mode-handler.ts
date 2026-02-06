/**
 * Execute mode handler - standard task execution
 */

import type { TaskResult, AgentConfig } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import type { ModeHandler } from './mode-handler';
import { Agent } from '../agent';

/**
 * Execute mode - standard agent execution
 */
export class ExecuteModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    // Standard execution - create agent and execute
    const agent = new Agent(config, toolRegistry);
    return agent.execute(task);
  }
}
