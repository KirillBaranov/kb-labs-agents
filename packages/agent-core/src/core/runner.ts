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
  useAnalytics,
  useLogger,
  type LLMMessage,
  type LLMTool,
} from '@kb-labs/sdk';
import { AGENT_ANALYTICS_EVENTS } from '@kb-labs/agent-contracts';
import type { AgentConfig, LLMTier, TaskResult } from '@kb-labs/agent-contracts';
import type { Turn } from '@kb-labs/agent-contracts';
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
import { AnalyticsMiddleware } from '../middleware/builtin/analytics-middleware.js';
import { discoverWorkspace } from '../execution/workspace-discovery.js';
import { ToolInputNormalizer } from '../tools/tool-input-normalizer.js';
import { SessionManager } from '../planning/session-manager.js';
import { RunMetricsEmitter, getKpiBaselineKey } from '../analytics/index.js';
import type { RunKpiPayload } from '../analytics/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tier escalation order
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: LLMTier[] = ['small', 'medium', 'large'];

function nextTier(current: LLMTier): LLMTier | undefined {
  const idx = TIER_ORDER.indexOf(current);
  return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : undefined;
}

type TierMetrics = {
  durationMs: number;
  toolCallsTotal: number;
  toolSuccessCount: number;
  toolErrorCount: number;
};

type TierResult = TaskResult & {
  _escalated?: boolean;
  _escalationReason?: string;
  _metrics: TierMetrics;
};

type QualityGateResult = {
  status: 'pass' | 'partial' | 'fail';
  score: number;
  reasons: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// SDKAgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class SDKAgentRunner implements IAgentRunner {
  readonly agentId: string;

  private readonly abortController: AbortController;
  private readonly injectedMessages: LLMMessage[] = [];
  private readonly runMetricsEmitter = new RunMetricsEmitter();

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
    this.runMetricsEmitter.reset();
    const startTier: LLMTier = this.config.tier ?? 'medium';
    let currentTier = startTier;
    let tiersUsed = 0;
    let aggregateDurationMs = 0;
    let aggregateToolCalls = 0;
    let aggregateToolSuccesses = 0;
    let aggregateToolErrors = 0;
    let aggregateTokens = 0;
    let aggregateIterations = 0;
    const filesRead = new Set<string>();
    const filesModified = new Set<string>();
    const filesCreated = new Set<string>();

    while (true) {
      const result = await this.executeWithTier(task, currentTier);
      tiersUsed += 1;
      aggregateDurationMs += result._metrics.durationMs;
      aggregateToolCalls += result._metrics.toolCallsTotal;
      aggregateToolSuccesses += result._metrics.toolSuccessCount;
      aggregateToolErrors += result._metrics.toolErrorCount;
      aggregateTokens += result.tokensUsed;
      aggregateIterations += result.iterations;
      for (const path of result.filesRead) {filesRead.add(path);}
      for (const path of result.filesModified) {filesModified.add(path);}
      for (const path of result.filesCreated) {filesCreated.add(path);}

      if (result._escalated) {
        const next = nextTier(currentTier);
        if (next) {
          const logger = useLogger();
          logger.info(`[SDKAgentRunner] Escalating: ${currentTier} → ${next}`);
          await this.recordTierEscalation(
            currentTier,
            next,
            result._escalationReason ?? result.summary,
            result.iterations,
            task,
          );
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
        const { _escalated: _, _escalationReason: __, _metrics: ___, ...taskResult } = result;
        const finalResult: TaskResult = {
          ...taskResult,
          iterations: aggregateIterations,
          tokensUsed: aggregateTokens,
          filesRead: [...filesRead],
          filesModified: [...filesModified],
          filesCreated: [...filesCreated],
        };
        await this.emitRunKpis(task, startTier, currentTier, tiersUsed, finalResult, {
          durationMs: aggregateDurationMs,
          toolCallsTotal: aggregateToolCalls,
          toolSuccessCount: aggregateToolSuccesses,
          toolErrorCount: aggregateToolErrors,
        });
        return finalResult;
      }

      const { _escalated: _, _escalationReason: __, _metrics: ___, ...taskResult } = result;
      const finalResult: TaskResult = {
        ...taskResult,
        iterations: aggregateIterations,
        tokensUsed: aggregateTokens,
        filesRead: [...filesRead],
        filesModified: [...filesModified],
        filesCreated: [...filesCreated],
      };
      await this.emitRunKpis(task, startTier, currentTier, tiersUsed, finalResult, {
        durationMs: aggregateDurationMs,
        toolCallsTotal: aggregateToolCalls,
        toolSuccessCount: aggregateToolSuccesses,
        toolErrorCount: aggregateToolErrors,
      });
      return finalResult;
    }
  }

  // ── Single-tier execution ───────────────────────────────────────────────────

  private async executeWithTier(
    task: string,
    tier: LLMTier,
  ): Promise<TierResult> {
    const logger = useLogger();
    const tierStartedAt = Date.now();
    let toolSuccessCount = 0;
    let toolErrorCount = 0;
    let toolCallsTotal = 0;
    let runDurationMs = 0;

    // ── 1. LLM ───────────────────────────────────────────────────────────────
    const llm = useLLM({ tier });
    if (!llm?.chatWithTools) {
      return this.withMetrics(
        this.failResult(`LLM tier "${tier}" not available or doesn't support tool calling`, 0),
        { durationMs: Date.now() - tierStartedAt, toolCallsTotal: 0, toolSuccessCount: 0, toolErrorCount: 0 },
      );
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
    const analytics = this.getAnalytics();
    const analyticsMw = new AnalyticsMiddleware({
      onToolOutcome: (outcome) => {
        toolCallsTotal += 1;
        if (outcome.success) {
          toolSuccessCount += 1;
        } else {
          toolErrorCount += 1;
        }
        this.runMetricsEmitter.trackToolOutcome(
          {
            toolName: outcome.toolName,
            success: outcome.success,
            durationMs: outcome.durationMs ?? 0,
            errorCode: outcome.errorCode,
          },
          {
            analytics,
            toolCalledEvent: AGENT_ANALYTICS_EVENTS.TOOL_CALLED,
            log: (msg: string) => logger?.warn?.(msg),
          },
        );
      },
      onRunComplete: (metrics) => {
        runDurationMs = metrics.durationMs;
      },
    });

    // ── 5. MiddlewarePipeline ────────────────────────────────────────────────
    // sdk.middlewares = optional extras registered by the caller (TodoSync, Reflection, etc.)
    const featureFlags = {
      twoTierMemory: true, todoSync: true, searchSignal: true,
      reflection: true, taskClassifier: true, smartSummarizer: true,
      tierEscalation: true,
    };
    const pipeline = new MiddlewarePipeline(
      [observabilityMw, budgetMw, contextFilterMw, factSheetMw, progressMw, analyticsMw, ...this.sdk.middlewares],
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
    const sessionManager = this.config.sessionId
      ? new SessionManager(this.config.workingDir)
      : null;
    const lastAnswerHint = await this.getLastAnswerHint(task);
    const continuityEnabled = this.shouldInjectContinuity(task, lastAnswerHint.lastTask);
    const traceArtifactsContext = continuityEnabled && this.config.sessionId && sessionManager
      ? await sessionManager.getTraceArtifactsContext(this.config.sessionId).catch(() => '')
      : '';
    const sessionFactsHint = this.config.sessionId && sessionManager && this.shouldInjectSessionFacts(task)
      ? await this.getSessionFactsHint(sessionManager, this.config.sessionId)
      : '';
    const promptMemory = this.getPromptMemory();

    const promptBuilder = new SystemPromptBuilder();
    const systemPrompt = await promptBuilder.build({
      workingDir: this.config.workingDir,
      responseMode: 'auto',
      isSubAgent: !!this.config.parentAgentId,
      sessionId: this.config.sessionId,
      currentTask: task,
      workspaceDiscovery: workspaceDiscovery ?? undefined,
      memory: promptMemory,
      archiveSummaryHint: [sessionFactsHint, continuityEnabled ? lastAnswerHint.hint : '', traceArtifactsContext]
        .filter(Boolean)
        .join('\n\n') || undefined,
    });

    // ── 11. Initial messages: system + task ──────────────────────────────────
    messages.push({ role: 'system', content: systemPrompt });

    const historyMessages = continuityEnabled ? await this.loadConversationMessages(task) : [];
    messages.push(...historyMessages);

    messages.push({ role: 'user', content: task });
    await this.recordTaskStartInMemory(task);

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
      return this.withMetrics({
        ...this.failResult(`Escalating to next tier: ${loopResult.reason}`, run.iteration),
        _escalated: true,
        _escalationReason: loopResult.reason,
      }, {
        durationMs: runDurationMs || (Date.now() - tierStartedAt),
        toolCallsTotal,
        toolSuccessCount,
        toolErrorCount,
      });
    }

    // ── 12. Build TaskResult ──────────────────────────────────────────────────
    // Handle handoff (treat as a failed run — handoff routing not implemented here)
    if (loopResult.outcome === 'handoff') {
      await pipeline.onStop(run, 'handoff');
      await toolManager.disposeAll();
      return this.withMetrics(this.failResult(
        `Agent requested handoff to "${loopResult.toAgent}" (not supported in SDKAgentRunner)`,
        run.iteration,
      ), {
        durationMs: runDurationMs || (Date.now() - tierStartedAt),
        toolCallsTotal,
        toolSuccessCount,
        toolErrorCount,
      });
    }

    const output = loopResult.result;

    // Store final answer in meta so ObservabilityMiddleware can include it in agent:end
    if (output.answer) {
      run.meta.set('agent', 'finalAnswer', output.answer);
    }

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
      metrics: {
        stopReasonCode: output.reasonCode,
        repeatNoEvidenceCount: run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0,
        repeatNoEvidenceRate:
          run.iteration > 0
            ? (run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0) / run.iteration
            : 0,
      },
    };

    await this.recordTaskCompletionInMemory(task, taskResult);

    return this.withMetrics(taskResult, {
      durationMs: runDurationMs || (Date.now() - tierStartedAt),
      toolCallsTotal,
      toolSuccessCount,
      toolErrorCount,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractTurnText(turn: Turn, role: 'user' | 'assistant'): string | undefined {
    const parts = turn.steps
      .filter((step): step is Extract<Turn['steps'][number], { type: 'text' }> =>
        step.type === 'text' && step.role === role
      )
      .map((step) => step.content?.trim())
      .filter((value): value is string => Boolean(value));
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join('\n\n');
  }

  private async loadConversationMessages(currentTask: string): Promise<LLMMessage[]> {
    if (!this.config.sessionId || this.config.parentAgentId) {
      return [];
    }
    try {
      const manager = new SessionManager(this.config.workingDir);
      const turns = await manager.getTurns(this.config.sessionId);
      const sorted = [...turns].sort((a, b) => a.sequence - b.sequence).slice(-16);
      const messages: LLMMessage[] = [];

      for (const turn of sorted) {
        if (turn.type === 'user') {
          const text = this.extractTurnText(turn, 'user');
          if (text) {
            messages.push({ role: 'user', content: text });
          }
          continue;
        }
        if (turn.type === 'assistant') {
          const text = this.extractTurnText(turn, 'assistant');
          if (text) {
            messages.push({ role: 'assistant', content: text });
          }
        }
      }

      // If CLI already pre-created a user turn for current task, avoid duplicate.
      while (messages.length > 0) {
        const tail = messages[messages.length - 1];
        if (tail?.role === 'user' && tail.content.trim() === currentTask.trim()) {
          messages.pop();
          continue;
        }
        break;
      }

      return messages;
    } catch {
      return [];
    }
  }

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

  private withMetrics(
    result: TaskResult & { _escalated?: boolean; _escalationReason?: string },
    metrics: TierMetrics,
  ): TierResult {
    return {
      ...result,
      _escalated: result._escalated,
      _escalationReason: result._escalationReason,
      _metrics: metrics,
    };
  }

  private makeEmitContext() {
    const analytics = this.getAnalytics();
    const sessionId = this.config.sessionId;
    const logger = useLogger();

    if (!sessionId) {
      return {
        analytics,
        baselineKey: getKpiBaselineKey('', this.config.workingDir || ''),
        log: (msg: string) => logger?.warn?.(msg),
      };
    }

    const sessionManager = new SessionManager(this.config.workingDir);
    return {
      analytics,
      sessionId,
      persister: {
        getKpiBaseline: async (sid: string) => sessionManager.getKpiBaseline(sid),
        updateKpiBaseline: async (
          sid: string,
          updater: () => {
            version: number;
            updatedAt: string;
            driftRateEma: number;
            evidenceDensityEma: number;
            toolErrorRateEma: number;
            samples: number;
            tokenHistory: number[];
            iterationUtilizationHistory: number[];
            qualityScoreHistory: number[];
          },
        ) => sessionManager.updateKpiBaseline(sid, () => updater()),
      },
      baselineKey: getKpiBaselineKey('', this.config.workingDir || ''),
      log: (msg: string) => logger?.warn?.(msg),
    };
  }

  private async recordTierEscalation(
    from: LLMTier,
    to: LLMTier,
    reason: string,
    iteration: number,
    task: string,
  ): Promise<void> {
    await this.runMetricsEmitter.recordTierEscalation(from, to, reason, iteration, {
      analytics: this.getAnalytics(),
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task,
      tierEscalatedEvent: AGENT_ANALYTICS_EVENTS.TIER_ESCALATED,
      log: (msg: string) => useLogger()?.warn?.(msg),
    });
  }

  private async emitRunKpis(
    task: string,
    startTier: LLMTier,
    finalTier: LLMTier,
    tiersUsed: number,
    result: TaskResult,
    aggregate: TierMetrics,
  ): Promise<void> {
    const iterationBudget = Math.max(1, (this.config.maxIterations || 0) * Math.max(1, tiersUsed));
    const tokenBudget = this.config.tokenBudget?.enabled ? this.config.tokenBudget.maxTokens : undefined;
    const driftDomains = this.deriveDriftDomains(result);
    const qualityGate = this.evaluateQualityGate(result, aggregate, driftDomains.length);

    const payload: RunKpiPayload = {
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task,
      success: result.success,
      error: result.error,
      summaryPreview: (result.summary || '').slice(0, 300),
      iterationsUsed: result.iterations,
      iterationBudget,
      tokenBudget,
      tokenUtilization: tokenBudget && tokenBudget > 0 ? result.tokensUsed / tokenBudget : undefined,
      startTier,
      finalTier,
      durationMs: aggregate.durationMs,
      tokensUsed: result.tokensUsed,
      toolCallsTotal: aggregate.toolCallsTotal,
      toolSuccessCount: aggregate.toolSuccessCount,
      toolErrorCount: aggregate.toolErrorCount,
      todoToolCalls: 0,
      filesReadCount: result.filesRead.length,
      filesModifiedCount: result.filesModified.length,
      filesCreatedCount: result.filesCreated.length,
      driftDomainCount: driftDomains.length,
      driftDomains,
      executionPhase: result.success ? 'complete' : 'failed',
      phaseDurationsMs: {},
      phaseTransitionCount: 0,
      phaseTransitions: [],
      ledger: { failedSteps: aggregate.toolErrorCount, pendingSteps: 0 },
      qualityGate,
      repeatNoEvidenceRate: typeof result.metrics?.['repeatNoEvidenceRate'] === 'number'
        ? Number(result.metrics['repeatNoEvidenceRate'])
        : undefined,
    };

    await this.runMetricsEmitter.emitRunKpis(payload, this.makeEmitContext());
  }

  private getAnalytics() {
    return this.config.analytics ?? useAnalytics() ?? null;
  }

  private failResult(message: string, iterations: number): TaskResult {
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

  private getPromptMemory():
    | import('@kb-labs/agent-contracts').AgentMemory
    | undefined {
    const memory = this.sdk.memory as unknown;
    if (!memory || typeof memory !== 'object') {
      return undefined;
    }
    const maybe = memory as {
      getContext?: unknown;
      getRecent?: unknown;
    };
    if (typeof maybe.getContext !== 'function' || typeof maybe.getRecent !== 'function') {
      return undefined;
    }
    return memory as import('@kb-labs/agent-contracts').AgentMemory;
  }

  private async getLastAnswerHint(task: string): Promise<{ hint: string; lastTask?: string }> {
    const memory = this.sdk.memory as {
      getLastAnswer?: () => Promise<{
        answer: string;
        task: string;
        timestamp: string;
      } | null>;
    } | null;
    if (!memory?.getLastAnswer) {
      return { hint: '' };
    }
    const last = await memory.getLastAnswer().catch(() => null);
    if (!last || !last.answer?.trim()) {
      return { hint: '' };
    }
    if (last.task?.trim() === task.trim()) {
      return { hint: '', lastTask: last.task };
    }
    const preview = last.answer.length > 700 ? `${last.answer.slice(0, 700)}...` : last.answer;
    const hint = [
      '# Last Strong Answer (for follow-up continuity)',
      `Previous task: ${last.task}`,
      `Timestamp: ${last.timestamp}`,
      `Answer preview: ${preview}`,
      'Use this for continuity only. Re-validate with tools/files before final claims.',
    ].join('\n');
    return { hint, lastTask: last.task };
  }

  private shouldInjectContinuity(task: string, previousTask?: string): boolean {
    const normalizedTask = task.toLowerCase();
    const followUpHints = [
      'предыдущ',
      'выше',
      'до этого',
      'тот же',
      'этот же',
      'прошл',
      'follow-up',
      'previous',
      'earlier',
      'same task',
      'same as before',
      'again',
      'remind',
      'напомни',
    ];
    if (followUpHints.some((hint) => normalizedTask.includes(hint))) {
      return true;
    }
    if (!previousTask) {
      return false;
    }
    const overlap = lexicalOverlap(task, previousTask);
    return overlap >= 2;
  }

  private async getSessionFactsHint(sessionManager: SessionManager, sessionId: string): Promise<string> {
    const turns = await sessionManager.getTurns(sessionId).catch(() => []);
    if (turns.length === 0) {
      return '';
    }
    const completedUserTurns = turns.filter((t) => t.type === 'user' && t.status === 'completed').length;
    const completedAssistantTurns = turns.filter((t) => t.type === 'assistant' && t.status === 'completed').length;
    const lines = [
      '# Session Facts',
      `Completed user turns in this session: ${completedUserTurns}`,
      `Completed assistant turns in this session: ${completedAssistantTurns}`,
    ];
    lines.push('For meta-session questions (previous message/count in this session), prefer these facts before file search.');
    return lines.join('\n');
  }

  private shouldInjectSessionFacts(task: string): boolean {
    const lower = task.toLowerCase();
    const hints = [
      'предыдущ',
      'сообщен',
      'в этом бенче',
      'в этой сессии',
      'previous',
      'message',
      'session',
      'in this bench',
      'in this session',
    ];
    return hints.some((h) => lower.includes(h));
  }

  private async recordTaskStartInMemory(task: string): Promise<void> {
    const memory = this.sdk.memory as { add?: (entry: {
      content: string;
      type: 'fact' | 'task' | 'observation' | 'error';
      metadata?: Record<string, unknown>;
    }) => Promise<void> } | null;
    if (!memory?.add) {
      return;
    }
    await memory.add({
      content: `Task started: ${task}`,
      type: 'task',
      metadata: { sessionId: this.config.sessionId, agentId: this.agentId },
    }).catch(() => {});
  }

  private async recordTaskCompletionInMemory(task: string, result: TaskResult): Promise<void> {
    const memory = this.sdk.memory as {
      add?: (entry: {
        content: string;
        type: 'fact' | 'task' | 'observation' | 'error';
        metadata?: Record<string, unknown>;
      }) => Promise<void>;
      saveLastAnswer?: (
        answer: string,
        task: string,
        metadata?: {
          confidence?: number;
          completeness?: number;
          sources?: string[];
          filesCreated?: string[];
          filesModified?: string[];
        },
      ) => Promise<void>;
    } | null;
    if (!memory?.add) {
      return;
    }
    await memory.add({
      content: result.summary,
      type: result.success ? 'observation' : 'error',
      metadata: {
        sessionId: this.config.sessionId,
        agentId: this.agentId,
        success: result.success,
        filesRead: result.filesRead.length,
        filesModified: result.filesModified.length,
        filesCreated: result.filesCreated.length,
      },
    }).catch(() => {});

    if (typeof memory.saveLastAnswer === 'function') {
      await memory.saveLastAnswer(result.summary, task, {
        confidence: result.success ? 0.8 : 0.35,
        completeness: result.success ? 0.9 : 0.45,
        sources: result.filesRead.slice(0, 20),
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
      }).catch(() => {});
    }
  }

  private deriveDriftDomains(result: TaskResult): string[] {
    const domains = new Set<string>();
    const files = [...result.filesRead, ...result.filesModified, ...result.filesCreated];
    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');
      const rel = normalized.startsWith(this.config.workingDir.replace(/\\/g, '/'))
        ? normalized.slice(this.config.workingDir.length).replace(/^\/+/, '')
        : normalized;
      const first = rel.split('/').find((part) => part.length > 0);
      domains.add(first ?? '.');
    }
    return [...domains];
  }

  private evaluateQualityGate(
    result: TaskResult,
    aggregate: TierMetrics,
    driftDomainCount: number,
  ): QualityGateResult {
    const reasons: string[] = [];
    const evidenceCount = result.filesRead.length + result.filesModified.length + result.filesCreated.length;
    const evidenceDensity = result.iterations > 0 ? evidenceCount / result.iterations : evidenceCount;
    const toolReliability = aggregate.toolCallsTotal > 0
      ? aggregate.toolSuccessCount / aggregate.toolCallsTotal
      : (result.success ? 1 : 0);

    const completionScore = result.success ? 1 : 0.35;
    const evidenceScore = Math.min(1, evidenceDensity / 1.5);
    const reliabilityScore = Math.min(1, Math.max(0, toolReliability));
    const repeatNoEvidenceRate = typeof result.metrics?.['repeatNoEvidenceRate'] === 'number'
      ? Number(result.metrics['repeatNoEvidenceRate'])
      : 0;
    const forgetfulnessPenalty = repeatNoEvidenceRate > 0.2
      ? Math.min(0.15, repeatNoEvidenceRate * 0.3)
      : 0;
    const driftPenalty = driftDomainCount > 2 ? 0.08 : 0;

    let score =
      (completionScore * 0.45) +
      (evidenceScore * 0.25) +
      (reliabilityScore * 0.30) -
      driftPenalty -
      forgetfulnessPenalty;
    score = Math.max(0, Math.min(1, score));

    if (!result.success) {
      reasons.push('task_not_completed');
    }
    if (aggregate.toolErrorCount > 0) {
      reasons.push('tool_errors_present');
    }
    if (evidenceCount === 0) {
      reasons.push('no_evidence_collected');
    }
    if (driftDomainCount > 2) {
      reasons.push('scope_drift_detected');
    }
    if (repeatNoEvidenceRate > 0.2) {
      reasons.push('repeated_without_new_evidence');
    }

    const stopReason = typeof result.metrics?.['stopReasonCode'] === 'string'
      ? String(result.metrics?.['stopReasonCode'])
      : '';
    if ((stopReason === 'max_iterations' || stopReason === 'loop_detected') && evidenceCount > 0) {
      reasons.push('partial_due_to_iteration_limit');
      score = Math.max(score, 0.35);
    }

    if (score >= 0.55 && result.success) {
      return { status: 'pass', score, reasons };
    }
    if (score >= 0.3) {
      return { status: 'partial', score, reasons };
    }
    return { status: 'fail', score, reasons };
  }
}

function lexicalOverlap(a: string, b: string): number {
  const wa = extractLexicalTokens(a);
  const wb = extractLexicalTokens(b);
  let count = 0;
  for (const token of wa) {
    if (wb.has(token)) {
      count += 1;
    }
  }
  return count;
}

function extractLexicalTokens(input: string): Set<string> {
  const tokens = (input.toLowerCase().match(/[\\p{L}\\p{N}_-]+/gu) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !/^\\d+$/.test(t));
  return new Set(tokens);
}
