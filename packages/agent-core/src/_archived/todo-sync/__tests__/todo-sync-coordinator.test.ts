import { describe, it, expect, vi } from 'vitest';
import {
  TodoSyncCoordinator,
  shouldNudgeTodoDiscipline,
  buildInitialTodoItems,
} from '../todo-sync-coordinator';
import type {
  TodoToolExecutor,
  TodoHasToolCheck,
} from '../todo-sync-coordinator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutor(success = true): TodoToolExecutor {
  return vi.fn().mockResolvedValue({ success, output: 'ok' });
}

function makeHasTool(available = true): TodoHasToolCheck {
  return vi.fn().mockReturnValue(available);
}

const noop = () => {};

// ---------------------------------------------------------------------------
// shouldNudgeTodoDiscipline (pure)
// ---------------------------------------------------------------------------

describe('shouldNudgeTodoDiscipline', () => {
  it('returns false when nudge already sent', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: true,
      iteration: 5,
      toolsUsedCount: new Map([['fs_read', 3]]),
      task: 'fix the bug',
    })).toBe(false);
  });

  it('returns false when iteration < 2', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 1,
      toolsUsedCount: new Map([['fs_read', 3]]),
      task: 'fix the bug',
    })).toBe(false);
  });

  it('returns false when todo tools already used', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 3,
      toolsUsedCount: new Map([['fs_read', 3], ['todo_create', 1]]),
      task: 'fix the bug',
    })).toBe(false);
  });

  it('returns false when fewer than 2 total tool calls', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 3,
      toolsUsedCount: new Map([['fs_read', 1]]),
      task: 'fix the bug',
    })).toBe(false);
  });

  it('returns false when task does not match action regex', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 3,
      toolsUsedCount: new Map([['fs_read', 3]]),
      task: 'what is this?',
    })).toBe(false);
  });

  it('returns true for action task with sufficient tool usage and no todo', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 3,
      toolsUsedCount: new Map([['fs_read', 2], ['grep_search', 1]]),
      task: 'implement the new feature',
    })).toBe(true);
  });

  it('matches Russian action keywords', () => {
    expect(shouldNudgeTodoDiscipline({
      nudgeSent: false,
      iteration: 3,
      toolsUsedCount: new Map([['fs_read', 2], ['grep_search', 1]]),
      task: 'исправь баг',
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildInitialTodoItems (pure)
// ---------------------------------------------------------------------------

describe('buildInitialTodoItems', () => {
  it('returns 4 items', () => {
    const items = buildInitialTodoItems('implement auth');
    expect(items).toHaveLength(4);
  });

  it('first item contains truncated task', () => {
    const longTask = 'a'.repeat(200);
    const items = buildInitialTodoItems(longTask);
    expect(items[0]!.description.length).toBeLessThanOrEqual(120);
    expect(items[0]!.priority).toBe('high');
  });

  it('has correct priorities', () => {
    const items = buildInitialTodoItems('fix bug');
    expect(items[0]!.priority).toBe('high');
    expect(items[1]!.priority).toBe('high');
    expect(items[2]!.priority).toBe('medium');
    expect(items[3]!.priority).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// TodoSyncCoordinator class
// ---------------------------------------------------------------------------

describe('TodoSyncCoordinator', () => {
  describe('ensureInitialized', () => {
    it('creates initial todo items on first call', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.ensureInitialized('fix bug', 'session-1');
      // Wait for enqueued async work
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).toHaveBeenCalledWith('todo_create', expect.objectContaining({
        sessionId: 'session-1',
        items: expect.any(Array),
      }));
      expect(coord.state.enabled).toBe(true);
      expect(coord.state.initialized).toBe(true);
    });

    it('does not re-initialize on second call', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.ensureInitialized('fix bug', 'session-1');
      coord.ensureInitialized('fix bug', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      // Only called once
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('skips when no sessionId', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.ensureInitialized('fix bug', undefined);
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).not.toHaveBeenCalled();
    });

    it('skips when todo_create not available', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool(false);
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.ensureInitialized('fix bug', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('syncWithPhase', () => {
    it('marks scoping as in-progress', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      // Manually enable
      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      coord.syncWithPhase('scoping', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).toHaveBeenCalledWith('todo_update', expect.objectContaining({
        itemId: 's-1',
        status: 'in-progress',
      }));
    });

    it('marks scoping complete and executing in-progress for executing phase', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      coord.syncWithPhase('executing', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).toHaveBeenCalledWith('todo_update', expect.objectContaining({
        itemId: 's-1',
        status: 'completed',
      }));
      expect(executor).toHaveBeenCalledWith('todo_update', expect.objectContaining({
        itemId: 's-2',
        status: 'in-progress',
      }));
    });

    it('does nothing when not enabled', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.syncWithPhase('scoping', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    it('marks reporting completed on success', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      await coord.finalize(true, 'All done', 'session-1');

      expect(executor).toHaveBeenCalledWith('todo_update', expect.objectContaining({
        itemId: 's-4',
        status: 'completed',
      }));
    });

    it('marks reporting blocked on failure', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      await coord.finalize(false, 'Failed', 'session-1');

      expect(executor).toHaveBeenCalledWith('todo_update', expect.objectContaining({
        itemId: 's-4',
        status: 'blocked',
      }));
    });

    it('reads back todo list if todo_get available', async () => {
      const executor = makeExecutor();
      const hasTool = makeHasTool();
      const coord = new TodoSyncCoordinator(executor, hasTool, noop);

      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      await coord.finalize(true, 'Done', 'session-1');

      expect(executor).toHaveBeenCalledWith('todo_get', { sessionId: 'session-1' });
    });
  });

  describe('reset', () => {
    it('resets all state', () => {
      const coord = new TodoSyncCoordinator(makeExecutor(), makeHasTool(), noop);
      coord.state.enabled = true;
      coord.state.initialized = true;
      coord.state.nudgeSent = true;

      coord.reset();

      expect(coord.state.enabled).toBe(false);
      expect(coord.state.initialized).toBe(false);
      expect(coord.state.nudgeSent).toBe(false);
      expect(coord.state.phaseItemIds.scoping).toBeNull();
    });
  });

  describe('markNudgeSent', () => {
    it('sets nudgeSent to true', () => {
      const coord = new TodoSyncCoordinator(makeExecutor(), makeHasTool(), noop);
      expect(coord.state.nudgeSent).toBe(false);
      coord.markNudgeSent();
      expect(coord.state.nudgeSent).toBe(true);
    });
  });

  describe('error handling', () => {
    it('disables sync on TODO_LIST_NOT_FOUND error', async () => {
      const executor = vi.fn().mockResolvedValue({
        success: false,
        errorDetails: { code: 'TODO_LIST_NOT_FOUND' },
      });
      const hasTool = makeHasTool();
      const log = vi.fn();
      const coord = new TodoSyncCoordinator(executor, hasTool, log);

      coord.state.enabled = true;
      coord.state.phaseItemIds = {
        scoping: 's-1', executing: 's-2', verifying: 's-3', reporting: 's-4',
      };

      coord.syncWithPhase('scoping', 'session-1');
      await new Promise((r) => { setTimeout(r, 20); });

      expect(coord.state.enabled).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('TODO_LIST_NOT_FOUND'));
    });
  });
});
