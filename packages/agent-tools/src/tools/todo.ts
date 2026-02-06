/**
 * TODO tools for task planning and progress tracking
 */

import type { Tool, ToolContext } from '../types.js';
import type { TodoList, TodoItem } from '@kb-labs/agent-contracts';

// In-memory TODO storage (session-scoped)
const todoLists = new Map<string, TodoList>();

/**
 * Create TODO list with tasks
 */
export function createTodoCreateTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_create',
        description: 'Create a TODO list to track task progress. Optional - use if helpful for planning complex tasks.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier to associate TODO list',
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description: 'Task description',
                  },
                  priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Task priority',
                  },
                },
                required: ['description'],
              },
              description: 'List of tasks',
            },
          },
          required: ['sessionId', 'items'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;
      const items = input.items as Array<{
        description: string;
        priority?: 'low' | 'medium' | 'high';
      }>;

      const todoItems: TodoItem[] = items.map((item, index) => ({
        id: `${sessionId}-${index + 1}`,
        description: item.description,
        status: 'pending',
        priority: item.priority || 'medium',
        createdAt: new Date().toISOString(),
      }));

      const todoList: TodoList = {
        sessionId,
        items: todoItems,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      todoLists.set(sessionId, todoList);

      const output = [
        `TODO list created for session: ${sessionId}`,
        '',
        ...todoItems.map(
          (item, i) => `${i + 1}. [ ] ${item.description} (${item.priority})`
        ),
      ].join('\n');

      return {
        success: true,
        output,
      };
    },
  };
}

/**
 * Update TODO item status
 */
export function createTodoUpdateTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_update',
        description: 'Update status of a TODO item. Use to mark tasks as in-progress or completed.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier',
            },
            itemId: {
              type: 'string',
              description: 'TODO item ID to update',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in-progress', 'completed', 'blocked'],
              description: 'New status',
            },
            notes: {
              type: 'string',
              description: 'Optional notes about the update',
            },
          },
          required: ['sessionId', 'itemId', 'status'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;
      const itemId = input.itemId as string;
      const status = input.status as TodoItem['status'];
      const notes = input.notes as string | undefined;

      const todoList = todoLists.get(sessionId);

      if (!todoList) {
        return {
          success: false,
          error: `No TODO list found for session: ${sessionId}`,
        };
      }

      const item = todoList.items.find(i => i.id === itemId);

      if (!item) {
        return {
          success: false,
          error: `TODO item not found: ${itemId}`,
        };
      }

      item.status = status;
      item.updatedAt = new Date().toISOString();

      if (notes) {
        item.notes = notes;
      }

      todoList.updatedAt = new Date().toISOString();

      const statusIcon =
        status === 'completed'
          ? '✓'
          : status === 'in-progress'
            ? '⏳'
            : status === 'blocked'
              ? '🚫'
              : ' ';

      return {
        success: true,
        output: `[${statusIcon}] ${item.description} → ${status}${notes ? `\n  Note: ${notes}` : ''}`,
      };
    },
  };
}

/**
 * Get TODO list status
 */
export function createTodoGetTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'todo_get',
        description: 'Get current TODO list with task statuses. Use to check progress.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session identifier',
            },
          },
          required: ['sessionId'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const sessionId = input.sessionId as string;

      const todoList = todoLists.get(sessionId);

      if (!todoList) {
        return {
          success: false,
          error: `No TODO list found for session: ${sessionId}`,
        };
      }

      const completed = todoList.items.filter(i => i.status === 'completed')
        .length;
      const total = todoList.items.length;

      const output = [
        `TODO List for ${sessionId} (${completed}/${total} completed)`,
        '',
        ...todoList.items.map(item => {
          const icon =
            item.status === 'completed'
              ? '✓'
              : item.status === 'in-progress'
                ? '⏳'
                : item.status === 'blocked'
                  ? '🚫'
                  : ' ';
          return `[${icon}] ${item.description} (${item.priority})${item.notes ? `\n    ${item.notes}` : ''}`;
        }),
      ].join('\n');

      return {
        success: true,
        output,
      };
    },
  };
}
