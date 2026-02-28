/**
 * SDKAgentRunner — clean agent implementation via AgentSDK.
 *
 * Composition:
 *   AgentSDK state  →  SDKAgentRunner  →  ObservabilityMiddleware (events + file tracking)
 *                                      →  BudgetMiddleware (token budget enforcement)
 *                                      →  ContextFilterMiddleware (sliding window + truncation)
 *                                      →  FactSheetMiddleware (structured working memory)
 *                                      →  ProgressMiddleware (stuck/loop detection)
 *                                      →  TodoSyncMiddleware (feature-flagged)
 *                                      →  SearchSignalMiddleware (feature-flagged)
 *                                      →  ReflectionMiddleware (feature-flagged)
 *                                      →  TaskClassifierMiddleware (feature-flagged)
 *                                      →  MiddlewarePipeline
 *                                      →  ToolManager (ToolPacks)
 *                                      →  ToolExecutor  (guards + processors)
 *                                      →  LoopContextImpl
 *                                      →  ExecutionLoop (LinearExecutionLoop)
 *                                      →  SubAgentOrchestrator (child agents)
 *
 * Tier escalation:
 *   - Runner iterates small → medium → large
 *   - If LoopResult.outcome === 'escalate', move to next tier
 *   - If LoopResult.outcome === 'complete', build TaskResult and return
 *
 * Mode routing:
 *   - mode === 'execute' → run the loop directly
 *   - any other mode    → delegate to getModeHandler() (plan/edit/debug)
 *     getModeHandler still needs a ToolRegistry for legacy mode handlers.
 *     We bridge via a thin ToolRegistry adapter wrapping ToolManager.
 *
 * Observability (from AgentConfig):
 *   - onEvent   → forwarded via ObservabilityMiddleware (agent:start/end, llm:*, tool:*, etc.)
 *   - memory    → context injected into system prompt via SystemPromptBuilder
 *   - conversationHistory → injected into messages before first user turn
 *   - filesRead/Modified/Created → tracked by ObservabilityMiddleware in run.meta
 *   - workingDir → WorkspaceDiscovery enriches system prompt with repo map
 */

import { randomUUID } from 'node:crypto';
import {
  useLLM,
  useLogger,
  type LLMMessage,
  type LLMTool,
} from '@kb-labs/sdk';
import type { AgentConfig, LLMTier, TaskResult } from '@kb-labs/agent-contracts';
import type { AgentSDK, IAgentRunner } from '@kb-labs/agent-sdk';
import { LinearExecutionLoop } from '../execution/linear-execution-loop.js';
import { MiddlewarePipeline } from '../middleware/pipeline.js';
import { ToolManager } from '../tools/tool-manager.js';
import { SystemPromptBuilder } from '../prompt/system-prompt-builder.js';
import { SubAgentOrchestrator } from '../agents/orchestrator.js';
import { createRunContext } from './run-context.js';
import { ToolExecutor } from './tool-executor.js';
import { LoopContextImpl } from './loop-context.js';
import { ObservabilityMiddleware } from '../middleware/builtin/observability-middleware.js';
import { ContextFilterMiddleware } from '../middleware/builtin/context-filter-middleware.js';
import { BudgetMiddleware } from '../middleware/builtin/budget-middleware.js';
import { ProgressMiddleware } from '../middleware/builtin/progress-middleware.js';
import { FactSheetMiddleware } from '../middleware/builtin/factsheet-middleware.js';
import { discoverWorkspace } from '../execution/workspace-discovery.js';
import { ToolInputNormalizer } from '../tools/tool-input-normalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tier escalation order
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: LLMTier[] = ['small', 'medium', 'large'];

function nextTier(current: LLMTier): LLMTier | undefined {
  const idx = TIER_ORDER.indexOf(current);
  return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDKAgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class SDKAgentRunner implements IAgentRunner {
  readonly agentId: string;

  private readonly abortController: AbortController;
  private readonly injectedMessages: LLMMessage[] = [];

  constructor(
    private readonly config: AgentConfig,
    private readonly sdk: AgentSDK,
  ) {
    this.agentId = config.agentId ?? randomUUID();
    this.abortController = new AbortController();

    // Honor parent abort signal
    if (config.abortSignal) {
      config.abortSignal.addEventListener('abort', () => this.abortController.abort());
    }
  }

  // ── IAgentRunner API ────────────────────────────────────────────────────────

  async execute(task: string): Promise<TaskResult> {
    const mode = this.config.mode?.mode ?? 'execute';

    // Non-execute modes delegate to legacy ModeHandler
    if (mode !== 'execute') {
      return this.runWithModeHandler(task);
    }

    return this.runExecuteMode(task);
  }

  requestStop(): void {
    this.abortController.abort();
  }

  injectUserContext(message: string): void {
    this.injectedMessages.push({ role: 'user', content: message });
  }

  // ── Execute mode: tier escalation loop ─────────────────────────────────────

  private async runExecuteMode(task: string): Promise<TaskResult> {
    const startTier: LLMTier = this.config.tier ?? 'medium';
    let currentTier = startTier;

    while (true) {
      const result = await this.executeWithTier(task, currentTier);

      if (result._escalated) {
        const next = nextTier(currentTier);
        if (next) {
          const logger = useLogger();
          logger.info(`[SDKAgentRunner] Escalating: ${currentTier} → ${next}`);
          this.config.onEvent?.({
            type: 'status:change',
            timestamp: new Date().toISOString(),
            agentId: this.agentId,
            data: { status: 'escalating', message: `Tier escalation: ${currentTier} → ${next}` },
          } as any);
          currentTier = next;
          continue;
        }
        // Already at highest tier — return whatever we got
        const { _escalated: _, ...taskResult } = result;
        return taskResult;
      }

      const { _escalated: _, ...taskResult } = result;
      return taskResult;
    }
  }

  // ── Single-tier execution ───────────────────────────────────────────────────

  private async executeWithTier(
    task: string,
    tier: LLMTier,
  ): Promise<TaskResult & { _escalated?: boolean }> {
    const logger = useLogger();

    // ── 1. LLM ───────────────────────────────────────────────────────────────
    const llm = useLLM({ tier });
    if (!llm?.chatWithTools) {
      return this.failResult(`LLM tier "${tier}" not available or doesn't support tool calling`, 0);
    }

    // ── 2. ToolManager ───────────────────────────────────────────────────────
    const toolManager = new ToolManager({
      onAudit: (toolName, packId, input) => {
        logger?.debug?.(`[audit] pack=${packId} tool=${toolName} input=${JSON.stringify(input)}`);
      },
    });

    for (const pack of this.sdk.packs) {
      toolManager.register(pack);
    }
    await toolManager.initializeAll();

    // ── 3. ToolExecutor (normalizers + guards + processors) ───────────────────
    const coreNormalizer = new ToolInputNormalizer({
      workingDir: this.config.workingDir,
    });
    const toolExecutor = new ToolExecutor(
      toolManager,
      this.sdk.guards,
      this.sdk.outputProcessors,
      [coreNormalizer, ...this.sdk.inputNormalizers],
    );

    // ── 4. Core middlewares ───────────────────────────────────────────────────

    let totalTokens = 0;

    // ObservabilityMiddleware — events + file tracking (order=5)
    const observabilityMw = new ObservabilityMiddleware(
      this.agentId,
      this.config.parentAgentId,
      this.config.sessionId,
      this.config.onEvent,
    );

    // BudgetMiddleware — token enforcement (order=10)
    // Only active when config.tokenBudget.enabled = true.
    const budgetCfg = this.config.tokenBudget;
    const budgetMw = new BudgetMiddleware(
      {
        active: !!(budgetCfg?.enabled),
        maxTokens: budgetCfg?.maxTokens ?? 0,
        softLimitRatio: budgetCfg?.softLimitRatio ?? 0.7,
        hardLimitRatio: budgetCfg?.hardLimitRatio ?? 1.0,
        hardStop: budgetCfg?.hardStop ?? false,
        forceSynthesisOnHardLimit: budgetCfg?.forceSynthesisOnHardLimit ?? true,
      },
      () => totalTokens,
    );

    // ContextFilterMiddleware — sliding window + output truncation (order=15)
    const contextFilterMw = new ContextFilterMiddleware({
      maxOutputLength: 8000,
      slidingWindowSize: 10,
    });

    // FactSheetMiddleware — structured working memory (order=20)
    const factSheetMw = new FactSheetMiddleware({
      persistDir: this.config.sessionId
        ? `${this.config.workingDir}/.kb/memory/sessions/${this.config.sessionId}`
        : undefined,
      summarizationInterval: 5,
    });

    // ProgressMiddleware — stuck/loop detection (order=50)
    const progressMw = new ProgressMiddleware(4, {
      onStuck: (iteration, iters) => {
        logger?.warn?.(`[progress] stuck at iteration ${iteration} (${iters} iters without progress)`);
      },
      onLoop: (iteration, calls) => {
        logger?.warn?.(`[progress] loop detected at iteration ${iteration}: ${calls.join(', ')}`);
      },
    });

    // ── 5. MiddlewarePipeline ────────────────────────────────────────────────
    // sdk.middlewares = optional extras registered by the caller (TodoSync, Reflection, etc.)
    const featureFlags = {
      twoTierMemory: false, todoSync: true, searchSignal: true,
      reflection: true, taskClassifier: true, smartSummarizer: true,
      tierEscalation: true,
    };
    const pipeline = new MiddlewarePipeline(
      [observabilityMw, budgetMw, contextFilterMw, factSheetMw, progressMw, ...this.sdk.middlewares],
      {
        featureFlags,
        onError: (middlewareName, hookName, error) => {
          const msg = error instanceof Error ? error.message : String(error);
          logger?.warn?.(`[middleware] ${middlewareName}.${hookName} failed (fail-open): ${msg}`);
        },
      },
    );

    // ── 8. Sub-agent orchestrator ────────────────────────────────────────────
    //  (injected via spawn_agent tool in CoreToolPack — not wired here directly,
    //   but we build it so it's available when tool packs request it)
    const _orchestrator = new SubAgentOrchestrator(
      async (request, _tokenBudget, _signal) => {
        const res = await this.spawnChildAgent(task, request.task, {
          maxIterations: request.maxIterations,
          workingDir: request.workingDir,
        });
        return {
          task: request.task,
          agentType: request.agentType ?? 'researcher',
          success: res.success,
          result: res.result,
          iterations: res.iterations,
          tokensUsed: res.tokensUsed,
        };
      },
      this.abortController.signal,
      { strategy: 'sequential', executor: {}, depth: (this.config.parentAgentId ? 1 : 0) },
    );

    // ── 9. RunContext ────────────────────────────────────────────────────────
    const requestId = randomUUID();
    const tools = this.buildLLMTools(toolManager);

    const { run, messages } = createRunContext({
      config: this.config,
      tier,
      tools,
      abortController: this.abortController,
      requestId,
    });
    (run as { task: string }).task = task;

    // ── 10. System prompt (memory + workspace discovery) ──────────────────────
    // WorkspaceDiscovery: only for top-level agents (not sub-agents) to avoid noise
    const workspaceDiscovery = !this.config.parentAgentId
      ? await discoverWorkspace(this.config.workingDir).catch(() => null)
      : null;

    const promptBuilder = new SystemPromptBuilder();
    const systemPrompt = await promptBuilder.build({
      workingDir: this.config.workingDir,
      responseMode: 'auto',
      isSubAgent: !!this.config.parentAgentId,
      sessionId: this.config.sessionId,
      currentTask: task,
      workspaceDiscovery: workspaceDiscovery ?? undefined,
    });

    // ── 11. Initial messages: system + task ──────────────────────────────────
    messages.push({ role: 'system', content: systemPrompt });

    messages.push({ role: 'user', content: task });

    // Inject any queued user context (from injectUserContext() calls)
    for (const msg of this.injectedMessages) {
      messages.push(msg);
    }

    // ── 12. Loop ──────────────────────────────────────────────────────────────
    const loop = this.sdk.loop ?? new LinearExecutionLoop();

    const loopCtx = new LoopContextImpl(
      run,
      messages,
      llm,
      pipeline,
      toolExecutor,
      (delta) => { totalTokens += delta; },
    );

    await pipeline.onStart(run);

    const loopResult = await loop.run(loopCtx);

    // ── 11. Handle escalation ─────────────────────────────────────────────────
    if (loopResult.outcome === 'escalate') {
      await pipeline.onStop(run, 'escalate');
      return {
        ...this.failResult(`Escalating to next tier: ${loopResult.reason}`, run.iteration),
        _escalated: true,
      };
    }

    // ── 12. Build TaskResult ──────────────────────────────────────────────────
    // Handle handoff (treat as a failed run — handoff routing not implemented here)
    if (loopResult.outcome === 'handoff') {
      await pipeline.onStop(run, 'handoff');
      await toolManager.disposeAll();
      return this.failResult(
        `Agent requested handoff to "${loopResult.toAgent}" (not supported in SDKAgentRunner)`,
        run.iteration,
      );
    }

    const output = loopResult.result;

    await pipeline.onStop(run, output.reasonCode);
    if (output.success) {
      await pipeline.onComplete(run);
    }

    await toolManager.disposeAll();

    // Read file tracking from run.meta (populated by ObservabilityMiddleware)
    const filesRead = run.meta.get<string[]>('files', 'read') ?? [];
    const filesModified = run.meta.get<string[]>('files', 'modified') ?? [];
    const filesCreated = run.meta.get<string[]>('files', 'created') ?? [];

    const taskResult: TaskResult = {
      success: output.success,
      summary: output.answer,
      filesCreated,
      filesModified,
      filesRead,
      iterations: run.iteration,
      tokensUsed: totalTokens,
      sessionId: this.config.sessionId,
    };

    return taskResult;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildLLMTools(toolManager: ToolManager): LLMTool[] {
    return toolManager.getDefinitions().map((def) => ({
      name: def.function.name,
      description: def.function.description,
      inputSchema: def.function.parameters,
    }));
  }

  private async spawnChildAgent(
    _parentTask: string,
    childTask: string,
    spawnConfig?: { maxIterations?: number; workingDir?: string },
  ): Promise<{ success: boolean; result: string; iterations: number; tokensUsed: number }> {
    const childConfig: AgentConfig = {
      ...this.config,
      agentId: randomUUID(),
      parentAgentId: this.agentId,
      maxIterations: spawnConfig?.maxIterations ?? this.config.maxIterations,
      workingDir: spawnConfig?.workingDir ?? this.config.workingDir,
      abortSignal: this.abortController.signal,
    };
    const childSDK = this.sdk.extend();
    const childRunner = new SDKAgentRunner(childConfig, childSDK);
    const result = await childRunner.execute(childTask);
    return {
      success: result.success,
      result: result.summary,
      iterations: result.iterations,
      tokensUsed: result.tokensUsed,
    };
  }

  private async runWithModeHandler(task: string): Promise<TaskResult> {
    const { getModeHandler } = await import('../modes/mode-handler.js');
    const { createToolRegistry } = await import('@kb-labs/agent-tools');

    const toolRegistry = createToolRegistry({
      workingDir: this.config.workingDir,
      sessionId: this.config.sessionId,
      verbose: false,
    });

    const handler = await getModeHandler(this.config.mode);
    return handler.execute(task, this.config, toolRegistry);
  }

  private failResult(message: string, iterations: number): TaskResult & { _escalated?: boolean } {
    return {
      success: false,
      summary: message,
      filesCreated: [],
      filesModified: [],
      filesRead: [],
      iterations,
      tokensUsed: 0,
      error: message,
      sessionId: this.config.sessionId,
    };
  }
}
