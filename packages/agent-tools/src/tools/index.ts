/**
 * Tool registration and exports
 */

import type { ToolContext } from '../types.js';
import { ToolRegistry } from '../registry.js';

// Filesystem tools
import {
  createFsWriteTool,
  createFsReadTool,
  createFsPatchTool,
  createFsListTool,
} from './filesystem.js';

// Mass replace tool
import { createMassReplaceTool } from './mass-replace.js';

// Search tools
import {
  createGlobSearchTool,
  createGrepSearchTool,
  createListFilesTool,
  createFindDefinitionTool,
  createCodeStatsTool,
} from './search.js';

// Shell tool
import { createShellExecTool } from './shell.js';

// Memory tools
import {
  // Shared memory (persistent)
  createMemoryGetTool,
  createMemoryPreferenceTool,
  createMemoryConstraintTool,
  createSessionSaveTool,
  // Session memory (session-scoped)
  createMemoryCorrectionTool,
  createMemoryFindingTool,
  createMemoryBlockerTool,
} from './memory.js';

// TODO tools
import {
  createTodoCreateTool,
  createTodoUpdateTool,
  createTodoGetTool,
} from './todo.js';

// Interaction tools
import { createAskUserTool } from './interaction.js';

// Reporting tools (sub-agent ↔ parent communication)
import { createAskParentTool, createReportTool } from './reporting.js';

// Delegation tools
import { createSpawnAgentTool } from './delegation.js';

// Archive recall tool (Tier 2: Cold Storage)
import { createArchiveRecallTool } from './archive-recall.js';

/**
 * Create and register all tools
 */
export function createToolRegistry(context: ToolContext): ToolRegistry {
  const registry = new ToolRegistry(context);

  // Register filesystem tools
  registry.register(createFsWriteTool(context));
  registry.register(createFsReadTool(context));
  registry.register(createFsPatchTool(context));
  registry.register(createFsListTool(context));
  registry.register(createMassReplaceTool(context));

  // Register search tools (list_files removed — duplicates fs_list)
  registry.register(createGlobSearchTool(context));
  registry.register(createGrepSearchTool(context));
  registry.register(createFindDefinitionTool(context));
  registry.register(createCodeStatsTool(context));

  // Register shell tool
  registry.register(createShellExecTool(context));

  // Register memory tools
  // Shared memory (persistent)
  registry.register(createMemoryGetTool(context));
  registry.register(createMemoryPreferenceTool(context));
  registry.register(createMemoryConstraintTool(context));
  registry.register(createSessionSaveTool(context));
  // Session memory (session-scoped)
  registry.register(createMemoryCorrectionTool(context));
  registry.register(createMemoryFindingTool(context));
  registry.register(createMemoryBlockerTool(context));
  // Archive recall (Tier 2: Cold Storage)
  if (context.archiveMemory) {
    registry.register(createArchiveRecallTool(context));
  }

  // Register TODO tools
  registry.register(createTodoCreateTool(context));
  registry.register(createTodoUpdateTool(context));
  registry.register(createTodoGetTool(context));

  // Register interaction tools
  registry.register(createAskUserTool(context));

  // Register reporting tools (sub-agent ↔ parent communication)
  registry.register(createAskParentTool(context));
  registry.register(createReportTool(context));

  // Register delegation tools (only for main agent — sub-agents don't get spawn_agent)
  if (context.spawnAgent) {
    registry.register(createSpawnAgentTool(context));
  }

  return registry;
}

// Re-export tool creators
export {
  createFsWriteTool,
  createFsReadTool,
  createFsPatchTool,
  createFsListTool,
  createMassReplaceTool,
  createListFilesTool,
  createGlobSearchTool,
  createGrepSearchTool,
  createFindDefinitionTool,
  createCodeStatsTool,
  createShellExecTool,
  // Shared memory
  createMemoryGetTool,
  createMemoryPreferenceTool,
  createMemoryConstraintTool,
  createSessionSaveTool,
  // Session memory
  createMemoryCorrectionTool,
  createMemoryFindingTool,
  createMemoryBlockerTool,
  // Other
  createTodoCreateTool,
  createTodoUpdateTool,
  createTodoGetTool,
  createAskUserTool,
  createAskParentTool,
  createReportTool,
  createSpawnAgentTool,
  createArchiveRecallTool,
};
