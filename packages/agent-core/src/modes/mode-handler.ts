/**
 * Mode handler interface and base implementation
 */

import type { TaskResult, ModeConfig, AgentConfig } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';

/**
 * Mode handler interface - each mode implements this
 */
export interface ModeHandler {
  /**
   * Execute task in this mode
   */
  execute(task: string, config: AgentConfig, toolRegistry: ToolRegistry): Promise<TaskResult>;
}

/**
 * Get mode handler for specified mode (async for dynamic imports)
 */
export async function getModeHandler(modeConfig?: ModeConfig): Promise<ModeHandler> {
  const mode = modeConfig?.mode || 'execute';

  switch (mode) {
    case 'plan': {
      const { PlanModeHandler } = await import('./plan-mode-handler');
      return new PlanModeHandler();
    }
    case 'edit': {
      const { EditModeHandler } = await import('./edit-mode-handler');
      return new EditModeHandler();
    }
    case 'debug': {
      const { DebugModeHandler } = await import('./debug-mode-handler');
      return new DebugModeHandler();
    }
    case 'execute':
    default: {
      const { ExecuteModeHandler } = await import('./execute-mode-handler');
      return new ExecuteModeHandler();
    }
  }
}
