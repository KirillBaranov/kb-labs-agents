/**
 * TodoSyncCoordinator
 *
 * Manages todo-list lifecycle for execution-phase tracking: creates initial
 * items, syncs status on phase transitions, nudges todo discipline, and
 * finalizes on task completion.
 *
 * All tool execution is delegated via injected callbacks — the module has
 * zero dependency on Agent or tool-registry internals.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TodoPhase = 'scoping' | 'executing' | 'verifying' | 'reporting';
export type TodoStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type ExecutionPhase = 'scoping' | 'planning_lite' | 'executing' | 'converging' | 'verifying' | 'reporting';

export interface TodoToolResult {
  success: boolean;
  output?: string;
  error?: string;
  errorDetails?: { code?: string };
}

export type TodoToolExecutor = (
  toolName: 'todo_create' | 'todo_update' | 'todo_get',
  input: Record<string, unknown>,
) => Promise<TodoToolResult>;

export type TodoHasToolCheck = (toolName: string) => boolean;

export interface TodoSyncState {
  enabled: boolean;
  initialized: boolean;
  phaseItemIds: Record<TodoPhase, string | null>;
  phaseStatus: Record<TodoPhase, TodoStatus>;
  nudgeSent: boolean;
}

// ---------------------------------------------------------------------------
// TodoSyncCoordinator
// ---------------------------------------------------------------------------

export class TodoSyncCoordinator {
  readonly state: TodoSyncState;
  private queue: Promise<void> = Promise.resolve();
  private readonly executeTool: TodoToolExecutor;
  private readonly hasTool: TodoHasToolCheck;
  private readonly log: (msg: string) => void;

  constructor(
    executeTool: TodoToolExecutor,
    hasTool: TodoHasToolCheck,
    log: (msg: string) => void,
  ) {
    this.executeTool = executeTool;
    this.hasTool = hasTool;
    this.log = log;
    this.state = {
      enabled: false,
      initialized: false,
      phaseItemIds: { scoping: null, executing: null, verifying: null, reporting: null },
      phaseStatus: { scoping: 'pending', executing: 'pending', verifying: 'pending', reporting: 'pending' },
      nudgeSent: false,
    };
  }

  // ── Initialization ──────────────────────────────────────────────────────

  ensureInitialized(task: string, sessionId: string | undefined): void {
    if (this.state.initialized) {
      return;
    }
    this.state.initialized = true;
    this.enqueue(async () => {
      if (!sessionId || !this.hasTool('todo_create')) {
        return;
      }

      const items = buildInitialTodoItems(task);
      const result = await this.executeTool('todo_create', { sessionId, items });
      if (!result.success) {
        return;
      }

      this.state.enabled = true;
      this.state.phaseItemIds = {
        scoping: `${sessionId}-1`,
        executing: `${sessionId}-2`,
        verifying: `${sessionId}-3`,
        reporting: `${sessionId}-4`,
      };
    });
  }

  // ── Phase sync ──────────────────────────────────────────────────────────

  syncWithPhase(phase: ExecutionPhase, sessionId: string | undefined): void {
    if (!this.state.enabled || !sessionId || !this.hasTool('todo_update')) {
      return;
    }

    this.enqueue(async () => {
      if (phase === 'scoping') {
        await this.updatePhaseStatus('scoping', 'in-progress', 'Identifying task scope', sessionId);
        return;
      }

      if (phase === 'executing' || phase === 'converging') {
        await this.updatePhaseStatus('scoping', 'completed', 'Scope identified', sessionId);
        await this.updatePhaseStatus('executing', 'in-progress', 'Executing task steps', sessionId);
        return;
      }

      if (phase === 'verifying') {
        await this.updatePhaseStatus('executing', 'completed', 'Execution done', sessionId);
        await this.updatePhaseStatus('verifying', 'in-progress', 'Verifying evidence', sessionId);
        return;
      }

      if (phase === 'reporting') {
        await this.updatePhaseStatus('verifying', 'completed', 'Verification done', sessionId);
        await this.updatePhaseStatus('reporting', 'in-progress', 'Preparing final response', sessionId);
      }
    });
  }

  // ── Finalization ────────────────────────────────────────────────────────

  async finalize(success: boolean, notes: string, sessionId: string | undefined): Promise<void> {
    // Wait for any queued operations
    await this.queue.catch(() => {});

    if (!this.state.enabled || !sessionId) {
      return;
    }

    if (success) {
      await this.updatePhaseStatus('reporting', 'completed', notes.slice(0, 180), sessionId);
    } else {
      await this.updatePhaseStatus('reporting', 'blocked', notes.slice(0, 180), sessionId);
    }

    if (this.hasTool('todo_get')) {
      await this.executeTool('todo_get', { sessionId });
    }
  }

  // ── Nudge ───────────────────────────────────────────────────────────────

  markNudgeSent(): void {
    this.state.nudgeSent = true;
  }

  // ── Reset ───────────────────────────────────────────────────────────────

  reset(): void {
    this.state.enabled = false;
    this.state.initialized = false;
    this.state.phaseItemIds = { scoping: null, executing: null, verifying: null, reporting: null };
    this.state.phaseStatus = { scoping: 'pending', executing: 'pending', verifying: 'pending', reporting: 'pending' };
    this.state.nudgeSent = false;
    this.queue = Promise.resolve();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((err) => {
      this.log(`[Agent] TODO sync failed: ${err}`);
    });
  }

  private async updatePhaseStatus(
    phase: TodoPhase,
    status: TodoStatus,
    notes: string | undefined,
    sessionId: string,
  ): Promise<void> {
    const itemId = this.state.phaseItemIds[phase];
    if (!itemId) {
      return;
    }
    if (this.state.phaseStatus[phase] === status) {
      return;
    }

    const result = await this.executeTool('todo_update', { sessionId, itemId, status, notes });
    if (result.success) {
      this.state.phaseStatus[phase] = status;
      return;
    }

    const code = result.errorDetails?.code || '';
    if (code === 'TODO_LIST_NOT_FOUND' || code === 'TODO_ITEM_NOT_FOUND') {
      this.state.enabled = false;
      this.log(`[Agent] TODO sync disabled after ${code} to avoid repeated failed updates.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function shouldNudgeTodoDiscipline(opts: {
  nudgeSent: boolean;
  iteration: number;
  toolsUsedCount: ReadonlyMap<string, number>;
  task: string;
}): boolean {
  if (opts.nudgeSent || opts.iteration < 2) {
    return false;
  }

  const hasTodo = ['todo_create', 'todo_update', 'todo_get']
    .some((name) => (opts.toolsUsedCount.get(name) ?? 0) > 0);
  if (hasTodo) {
    return false;
  }

  const totalToolCalls = Array.from(opts.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
  if (totalToolCalls < 2) {
    return false;
  }

  return /(fix|refactor|implement|add|change|update|investigate|analyze|проанализ|исправ|добав|обнов|сделай|проверь)/i.test(opts.task);
}

export function buildInitialTodoItems(task: string): Array<{ description: string; priority: 'high' | 'medium' }> {
  return [
    { description: `Scope task: ${task.slice(0, 80)}`, priority: 'high' },
    { description: 'Collect evidence and execute relevant actions', priority: 'high' },
    { description: 'Verify findings and convergence', priority: 'medium' },
    { description: 'Prepare final response', priority: 'medium' },
  ];
}
