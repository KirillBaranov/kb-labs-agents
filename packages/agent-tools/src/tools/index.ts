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

// Archive recall tool (Tier 2: Cold Storage)
import { createArchiveRecallTool } from './archive-recall.js';

// Async task tools (fire-and-forget sub-agents)
import { createTaskSubmitTool, createTaskStatusTool, createTaskCollectTool } from './async-tasks.js';

// Plan validation tool (LLM-based plan quality gate)
import { createPlanValidateTool } from './plan-validate.js';

/**
 * Create and register all tools
 */
export function createToolRegistry(context: ToolContext): ToolRegistry {
  const allowed = context.allowedTools;
  const allow = (name: string) => !allowed || allowed.has(name);
  const registry = new ToolRegistry(context);

  // Register filesystem tools
  if (allow('fs_write')) {registry.register(createFsWriteTool(context));}
  if (allow('fs_read')) {registry.register(createFsReadTool(context));}
  if (allow('fs_patch')) {registry.register(createFsPatchTool(context));}
  if (allow('fs_list')) {registry.register(createFsListTool(context));}
  if (allow('mass_replace')) {registry.register(createMassReplaceTool(context));}

  // Register search tools
  if (allow('glob_search')) {registry.register(createGlobSearchTool(context));}
  if (allow('grep_search')) {registry.register(createGrepSearchTool(context));}
  if (allow('find_definition')) {registry.register(createFindDefinitionTool(context));}
  if (allow('code_stats')) {registry.register(createCodeStatsTool(context));}

  // Register shell tool
  if (allow('shell_exec')) {registry.register(createShellExecTool(context));}

  // Register memory tools
  if (allow('memory_get')) {registry.register(createMemoryGetTool(context));}
  if (allow('memory_preference')) {registry.register(createMemoryPreferenceTool(context));}
  if (allow('memory_constraint')) {registry.register(createMemoryConstraintTool(context));}
  if (allow('session_save')) {registry.register(createSessionSaveTool(context));}
  if (allow('memory_correction')) {registry.register(createMemoryCorrectionTool(context));}
  if (allow('memory_finding')) {registry.register(createMemoryFindingTool(context));}
  if (allow('memory_blocker')) {registry.register(createMemoryBlockerTool(context));}
  if (context.archiveMemory && allow('archive_recall')) {
    registry.register(createArchiveRecallTool(context));
  }

  // Register TODO tools
  if (allow('todo_create')) {registry.register(createTodoCreateTool(context));}
  if (allow('todo_update')) {registry.register(createTodoUpdateTool(context));}
  if (allow('todo_get')) {registry.register(createTodoGetTool(context));}

  // Register interaction tools
  if (allow('ask_user')) {registry.register(createAskUserTool(context));}

  // Register reporting tools (sub-agent ↔ parent communication)
  if (allow('ask_parent')) {registry.register(createAskParentTool(context));}
  if (allow('report')) {registry.register(createReportTool(context));}

  // Register async task tools (only when taskManager is provided AND allowed)
  if (context.taskManager) {
    if (allow('task_submit')) { registry.register(createTaskSubmitTool(context)); }
    if (allow('task_status')) { registry.register(createTaskStatusTool(context)); }
    if (allow('task_collect')) { registry.register(createTaskCollectTool(context)); }
  }

  // Register plan validation tool (LLM-based quality gate for plan mode)
  if (allow('plan_validate')) { registry.register(createPlanValidateTool(context)); }

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
  createArchiveRecallTool,
  createTaskSubmitTool,
  createTaskStatusTool,
  createTaskCollectTool,
  createPlanValidateTool,
};
