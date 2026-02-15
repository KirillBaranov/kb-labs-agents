/**
 * Tool registration and exports
 */

import type { ToolContext } from '../types.js';
import { ToolRegistry } from '../registry.js';

// Filesystem tools
import {
  createFsWriteTool,
  createFsReadTool,
  createFsEditTool,
  createFsListTool,
} from './filesystem.js';

// Search tools
import {
  createGlobSearchTool,
  createGrepSearchTool,
  createListFilesTool,
  createFindDefinitionTool,
  createProjectStructureTool,
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

// Orchestration tools
import { createAskOrchestratorTool, createReportToOrchestratorTool, createReflectOnProgressTool } from './orchestration.js';

/**
 * Create and register all tools
 */
export function createToolRegistry(context: ToolContext): ToolRegistry {
  const registry = new ToolRegistry(context);

  // Register filesystem tools
  registry.register(createFsWriteTool(context));
  registry.register(createFsReadTool(context));
  registry.register(createFsEditTool(context));
  registry.register(createFsListTool(context));

  // Register search tools
  registry.register(createListFilesTool(context)); // List first - most reliable for discovery
  registry.register(createGlobSearchTool(context));
  registry.register(createGrepSearchTool(context));
  registry.register(createFindDefinitionTool(context));
  registry.register(createProjectStructureTool(context));
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

  // Register TODO tools
  registry.register(createTodoCreateTool(context));
  registry.register(createTodoUpdateTool(context));
  registry.register(createTodoGetTool(context));

  // Register interaction tools
  registry.register(createAskUserTool(context));

  // Register orchestration tools
  registry.register(createAskOrchestratorTool(context));
  registry.register(createReportToOrchestratorTool(context));
  registry.register(createReflectOnProgressTool(context));

  return registry;
}

// Re-export tool creators
export {
  createFsWriteTool,
  createFsReadTool,
  createFsEditTool,
  createFsListTool,
  createListFilesTool,
  createGlobSearchTool,
  createGrepSearchTool,
  createFindDefinitionTool,
  createProjectStructureTool,
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
  createAskOrchestratorTool,
  createReportToOrchestratorTool,
  createReflectOnProgressTool,
};
