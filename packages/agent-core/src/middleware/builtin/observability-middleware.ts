/**
 * ObservabilityMiddleware — bridges AgentMiddleware hooks to AgentEvent stream.
 *
 * Converts middleware lifecycle callbacks into AgentEvent objects and forwards
 * them to the onEvent callback from AgentConfig. Also tracks file operations
 * in run.meta for later extraction into TaskResult.
 *
 * Design:
 *   - order = 5 (runs before all other middlewares so events fire first)
 *   - failPolicy = 'fail-open' (observability NEVER breaks execution)
 *
 * File tracking (via run.meta):
 *   - 'files' namespace, keys: 'read', 'modified', 'created'
 *   - Populated by afterToolExec based on tool name + input
 *   - SDKAgentRunner reads these at the end to build TaskResult
 */

import type {
  RunContext,
  LLMCtx,
  LLMCallResult,
  ToolExecCtx,
  ToolOutput,
  ContextMeta,
} from '@kb-labs/agent-sdk';
import type {
  AgentEvent,
  AgentEventCallback,
  AgentStartEvent,
  AgentEndEvent,
  LLMStartEvent,
  LLMEndEvent,
  ToolStartEvent,
  ToolEndEvent,
  IterationStartEvent,
  IterationEndEvent,
} from '@kb-labs/agent-contracts';

// ── File-tracking tool name → operation mapping ────────────────────────────

const FILE_READ_TOOLS = new Set(['fs_read', 'fs_list']);
const FILE_WRITE_TOOLS = new Set(['fs_write', 'fs_patch']);
const FILE_CREATE_TOOLS = new Set(['fs_write']); // fs_write creates if not exists

// ── Helpers ────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function makeBase(
  type: AgentEvent['type'],
  agentId: string,
  parentAgentId: string | undefined,
  sessionId: string | undefined,
) {
  return { type, timestamp: now(), agentId, parentAgentId, sessionId };
}

function addToMeta(meta: ContextMeta, key: 'read' | 'modified' | 'created', filePath: string): void {
  const existing = meta.get<string[]>('files', key) ?? [];
  if (!existing.includes(filePath)) {
    meta.set('files', key, [...existing, filePath]);
  }
}

function trackFilesInMeta(ctx: ToolExecCtx, result: ToolOutput): void {
  if (!result.success) {return;}

  const meta = ctx.run.meta;
  const toolName = ctx.toolName;
  const input = ctx.input;

  // Extract file path from common input shapes
  const filePath =
    typeof input['path'] === 'string' ? input['path'] :
    typeof input['file_path'] === 'string' ? input['file_path'] :
    typeof input['filePath'] === 'string' ? input['filePath'] :
    null;

  if (!filePath) {return;}

  if (FILE_READ_TOOLS.has(toolName)) {
    addToMeta(meta, 'read', filePath);
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const outputLower = result.output.toLowerCase();
    if (FILE_CREATE_TOOLS.has(toolName) && outputLower.includes('created')) {
      addToMeta(meta, 'created', filePath);
    } else {
      addToMeta(meta, 'modified', filePath);
    }
  }
}

// ── ObservabilityMiddleware ────────────────────────────────────────────────

export class ObservabilityMiddleware {
  readonly name = 'observability';
  readonly order = 5;
  readonly config = { failPolicy: 'fail-open' as const };

  private _startedAt = 0;
  private _llmStartedAt = 0;
  private _toolStartedAt = new Map<string, number>();
  private _lastIteration = 0;
  private _totalTokens = 0;

  constructor(
    private readonly agentId: string,
    private readonly parentAgentId: string | undefined,
    private readonly sessionId: string | undefined,
    private readonly onEvent: AgentEventCallback | undefined,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onStart(ctx: RunContext): void {
    this._startedAt = Date.now();
    const event: AgentStartEvent = {
      ...makeBase('agent:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        task: (ctx as unknown as { task?: string }).task ?? '',
        tier: ctx.tier,
        maxIterations: ctx.maxIterations,
        toolCount: ctx.tools.length,
      },
    } as AgentStartEvent;
    this._emit(event);
  }

  onStop(ctx: RunContext, reason: string): void {
    const filesCreated = ctx.meta.get<string[]>('files', 'created') ?? [];
    const filesModified = ctx.meta.get<string[]>('files', 'modified') ?? [];
    const event: AgentEndEvent = {
      ...makeBase('agent:end', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        success: reason !== 'abort_signal' && reason !== 'hard_budget',
        summary: '',
        iterations: this._lastIteration,
        tokensUsed: this._totalTokens,
        durationMs: Date.now() - this._startedAt,
        filesCreated,
        filesModified,
      },
    } as AgentEndEvent;
    this._emit(event);
  }

  // ── Iteration hooks ────────────────────────────────────────────────────

  beforeIteration(ctx: RunContext): 'continue' {
    const event: IterationStartEvent = {
      ...makeBase('iteration:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        iteration: ctx.iteration,
        maxIterations: ctx.maxIterations,
      },
    } as IterationStartEvent;
    this._emit(event);
    return 'continue';
  }

  afterIteration(ctx: RunContext): void {
    this._lastIteration = ctx.iteration;
    const event: IterationEndEvent = {
      ...makeBase('iteration:end', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        iteration: ctx.iteration,
        hadToolCalls: false,
        toolCallCount: 0,
        cumulativeTokens: this._totalTokens,
      },
    } as IterationEndEvent;
    this._emit(event);
  }

  // ── LLM hooks ─────────────────────────────────────────────────────────

  beforeLLMCall(ctx: LLMCtx): undefined {
    this._llmStartedAt = Date.now();
    const event: LLMStartEvent = {
      ...makeBase('llm:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        tier: ctx.run.tier,
        messageCount: ctx.messages.length,
      },
    } as LLMStartEvent;
    this._emit(event);
    return undefined;
  }

  afterLLMCall(_ctx: LLMCtx, result: LLMCallResult): void {
    const tokensUsed = result.usage
      ? result.usage.promptTokens + result.usage.completionTokens
      : 0;
    this._totalTokens += tokensUsed;

    const event: LLMEndEvent = {
      ...makeBase('llm:end', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        tokensUsed,
        durationMs: Date.now() - this._llmStartedAt,
        hasToolCalls: (result.toolCalls?.length ?? 0) > 0,
        content: result.content ?? undefined,
      },
    } as LLMEndEvent;
    this._emit(event);
  }

  // ── Tool hooks ─────────────────────────────────────────────────────────

  beforeToolExec(ctx: ToolExecCtx): 'execute' {
    this._toolStartedAt.set(ctx.toolName, Date.now());
    const event: ToolStartEvent = {
      ...makeBase('tool:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        toolName: ctx.toolName,
        input: ctx.input,
      },
    } as ToolStartEvent;
    this._emit(event);
    return 'execute';
  }

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    // Track file operations in meta
    trackFilesInMeta(ctx, result);

    const durationMs = Date.now() - (this._toolStartedAt.get(ctx.toolName) ?? Date.now());
    this._toolStartedAt.delete(ctx.toolName);

    const event: ToolEndEvent = {
      ...makeBase('tool:end', this.agentId, this.parentAgentId, this.sessionId),
      toolCallId: result.toolCallId,
      data: {
        toolName: ctx.toolName,
        success: result.success,
        output: result.output,
        durationMs,
      },
    } as ToolEndEvent;
    this._emit(event);
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // fail-open: swallow errors from event callback
    }
  }
}
