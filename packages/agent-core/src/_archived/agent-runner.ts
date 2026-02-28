/**
 * AgentRunner — thin orchestrator for the Agent v2 modular architecture.
 *
 * Responsibilities (and ONLY these):
 *  1. Lifecycle: start, execute, stop, emit events
 *  2. Tier escalation loop (small → medium → large)
 *  3. Mode routing (execute / plan / spec / debug / edit)
 *  4. Build LoopContext and delegate to ExecutionLoop
 *  5. Wire StateManager, ToolRegistry, EventEmitter
 *
 * Everything else lives in dedicated modules:
 *  - ExecutionLoop  — iteration engine (execution/loop.ts)
 *  - StateManager   — all mutable state (state/index.ts)
 *  - SystemPromptBuilder — prompt assembly (prompt/index.ts)
 *  - TaskClassifier — intent + budget (task-classifier/index.ts)
 *  - ToolRegistry   — tool execution (agent-tools)
 *  - SmartSummarizer, FactSheet, ArchiveMemory — memory (context/, memory/)
 *  - ReflectionEngine, SearchSignalTracker — analytics
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  TaskResult,
  LLMTier,
  Tracer,
  AgentMemory,
  AgentEvent,
  TaskStartEvent,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import { createToolRegistry } from '@kb-labs/agent-tools';
import {
  useLLM,
  useCache,
  useLogger,
  useAnalytics,
  type ILLM,
  type LLMMessage,
  type LLMTool,
  type LLMToolCall,
  type LLMToolCallResponse,
} from '@kb-labs/sdk';
import { AGENT_CONTEXT, AGENT_SUMMARIZER, AGENT_MEMORY } from './constants.js';
import {
  IterationBudget,
  QualityGate,
  TierSelector,
} from './budget/index.js';
import { SystemPromptBuilder } from '../prompt/index.js';
import { ToolInputNormalizer } from './tool-input/index.js';
import { ProgressTracker as ProgressTrackerModule, countFailedToolResults } from './progress/index.js';
import {
  SearchSignalTracker,
} from './search-signal/index.js';
import type { SearchArtifact } from './search-signal/index.js';
import { RunMetricsEmitter } from '../analytics/index.js';
import { ReflectionEngine } from './reflection/index.js';
import { TodoSyncCoordinator, shouldNudgeTodoDiscipline } from './todo-sync/index.js';
import { TaskClassifier } from './task-classifier/index.js';
import { TaskCompletionEvaluator, getHistoricalChangesForSimilarTask } from './task-completion/index.js';
import { createEventEmitter } from './events/event-emitter.js';
import { SessionManager } from '../planning/session-manager.js';
import {
  createIterationDetailEvent,
  createMemorySnapshotEvent,
  createStoppingAnalysisEvent,
  createFactAddedEvent,
  createSummarizationResultEvent,
  createSummarizationLLMCallEvent,
} from '@kb-labs/agent-tracing';
import { ContextFilter } from './context/context-filter.js';
import { SmartSummarizer } from './context/smart-summarizer.js';
import { FactSheet } from './memory/fact-sheet.js';
import { ArchiveMemory } from './memory/archive-memory.js';
import { FileChangeTracker, SnapshotStorage, ConflictDetector, ConflictResolver } from '@kb-labs/agent-history';
import {
  DEFAULT_FILE_HISTORY_CONFIG,
} from '@kb-labs/agent-contracts';
import type { ExecutionStateMachine } from '../execution/state-machine.js';
import { createDefaultAgentBehaviorPolicy, type AgentBehaviorPolicy } from '../execution/policy.js';
import { type WorkspaceDiscoveryResult } from '../execution/workspace-discovery.js';
import { ToolResultCache } from '../execution/tool-result-cache.js';
import { ExecutionLoop } from '../execution/loop.js';
import type { LoopContext } from '../execution/loop.js';
import { StateManager } from './state/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_TYPE_STATUS_CHANGE = 'status:change';
const DEFAULT_EXECUTION_TIER: LLMTier = 'medium';
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 90_000;
const SYNTHESIS_HEARTBEAT_INTERVAL_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  errorDetails?: {
    code: string;
    message: string;
    retryable?: boolean;
    hint?: string;
    details?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

interface ResolvedTokenBudgetPolicy {
  active: boolean;
  maxTokens: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  hardStop: boolean;
  forceSynthesisOnHardLimit: boolean;
  restrictBroadExplorationAtSoftLimit: boolean;
  allowIterationBudgetExtension: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier escalation control (no throw — returned from ExecutionLoop)
// ─────────────────────────────────────────────────────────────────────────────

class TierEscalationSignal extends Error {
  public readonly reason: string;
  public readonly iteration: number;
  constructor(reason: string, iteration: number) {
    super(`tier_escalation:${reason}`);
    this.name = 'TierEscalationSignal';
    this.reason = reason;
    this.iteration = iteration;
  }
}

function isTierEscalationSignal(error: unknown): error is TierEscalationSignal {
  return error instanceof TierEscalationSignal;
}

function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class AgentRunner {
  // ── Identity & config ──────────────────────────────────────────────────────
  public readonly agentId: string;
   
  private config: any;
  private readonly abortController: AbortController;

  // ── Core infrastructure ────────────────────────────────────────────────────
  private toolRegistry: ToolRegistry;
  private state: StateManager;
  private tracer?: Tracer;
  private memory?: AgentMemory;
  private eventEmitter = createEventEmitter();

  // ── Modules (stateless workers) ────────────────────────────────────────────
  private readonly toolResultCache = new ToolResultCache();
  private readonly iterationBudget = new IterationBudget();
  private readonly qualityGate = new QualityGate();
  private readonly tierSelector = new TierSelector();
  private readonly systemPromptBuilder = new SystemPromptBuilder();
  private readonly runMetricsEmitter = new RunMetricsEmitter();
  private readonly toolInputNormalizer: ToolInputNormalizer;
  private readonly searchSignalTracker: SearchSignalTracker;
  private readonly reflectionEngine: ReflectionEngine;
  private readonly todoSyncCoordinator: TodoSyncCoordinator;
  private readonly taskClassifier: TaskClassifier;
  private readonly taskCompletionEvaluator: TaskCompletionEvaluator;
  private progressTracker = new ProgressTrackerModule();

  // ── Memory ─────────────────────────────────────────────────────────────────
  private contextFilter: ContextFilter;
  private smartSummarizer: SmartSummarizer;
  private factSheet: FactSheet;
  private archiveMemory: ArchiveMemory;
  private memPersistDir?: string;
  private factSheetConfig: { maxTokens: number; maxEntries: number };
  private archiveMemoryConfig: { maxEntries: number; maxTotalChars: number };

  // ── Execution run state ────────────────────────────────────────────────────
  private currentTask?: string;
  private startTime = 0;
  private startTimestamp = '';
  private runStartTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private runFinalTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private taskIntent: 'action' | 'discovery' | 'analysis' | null = null;
  private completedIterations: number[] = [];
  private injectedUserContext: string[] = [];
  private searchesMadeCount = 0;
  private lastLLMCall?: { request: unknown; response: unknown; durationMs: number };
  private lastToolCall?: { name: string; input: unknown; output?: unknown; error?: string };
  private behaviorPolicy: AgentBehaviorPolicy = createDefaultAgentBehaviorPolicy();
  private workspaceDiscovery: WorkspaceDiscoveryResult | null = null;
  private lastSignalIteration = 0;
  private lastQualityGate: { status: 'pass' | 'partial'; score: number; reasons: string[]; nextChecks?: string[] } | null = null;
  private cachedSystemPrompt?: string;
  private cachedTaskMessage?: string;
  private sessionRootDir: string;
  private previousContextSnapshot: {
    iteration: number;
    messageCount: number;
    totalChars: number;
    systemPromptChars: number;
    messages: Array<{ role: string; chars: number }>;
  } | null = null;

  // ── File history (conflict detection) ─────────────────────────────────────
  private fileChangeTracker?: FileChangeTracker;
  private conflictDetector?: ConflictDetector;
  private conflictResolver?: ConflictResolver;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

   
  constructor(config: any, toolRegistry: ToolRegistry) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.agentId = config.agentId || generateAgentId();
    this.tracer = config.tracer;
    this.memory = config.memory;
    this.sessionRootDir = config.workingDir;

    this.state = new StateManager({
      maxIterations: config.maxIterations ?? 25,
      initialTier: DEFAULT_EXECUTION_TIER,
    });

    // AbortController — propagate parent's signal
    this.abortController = new AbortController();
    if (config.abortSignal) {
      config.abortSignal.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }

    // Modules that need callbacks into this instance
    this.toolInputNormalizer = new ToolInputNormalizer(fs);
    this.searchSignalTracker = new SearchSignalTracker(
      (artifacts) => this.callSearchSignalLLM(artifacts),
    );
    this.reflectionEngine = new ReflectionEngine(
      (input) => this.callReflectionLLM(input),
    );
    this.todoSyncCoordinator = new TodoSyncCoordinator(
      (toolName, input) => this.executeTodoTool(toolName, input),
      (name) => this.toolRegistry.getDefinitions().some((d) => d.function.name === name),
      (msg) => this.log(msg),
    );
    this.taskClassifier = new TaskClassifier(
      (tier) => useLLM({ tier: tier as LLMTier }) ?? null,
      (msg) => this.log(msg),
    );

    // Memory
    const memConfig = config.twoTierMemory;
    this.memPersistDir = config.sessionId
      ? path.join(this.sessionRootDir, '.kb', 'memory', config.sessionId)
      : undefined;
    this.factSheetConfig = {
      maxTokens: memConfig?.factSheetMaxTokens ?? AGENT_MEMORY.factSheetMaxTokens,
      maxEntries: memConfig?.factSheetMaxEntries ?? AGENT_MEMORY.factSheetMaxEntries,
    };
    this.archiveMemoryConfig = {
      maxEntries: memConfig?.archiveMaxEntries ?? AGENT_MEMORY.archiveMaxEntries,
      maxTotalChars: AGENT_MEMORY.archiveMaxTotalChars,
    };
    this.factSheet = new FactSheet(this.factSheetConfig);
    this.archiveMemory = new ArchiveMemory({
      ...this.archiveMemoryConfig,
      persistDir: this.memPersistDir,
    });

    // Context optimization
    this.contextFilter = new ContextFilter({
      maxOutputLength: AGENT_CONTEXT.maxToolOutputChars,
      slidingWindowSize: AGENT_CONTEXT.slidingWindowSize,
      enableDeduplication: true,
    });

    this.smartSummarizer = new SmartSummarizer({
      summarizationInterval: AGENT_SUMMARIZER.summarizationInterval,
      llmTier: 'small',
      maxSummaryTokens: AGENT_SUMMARIZER.maxSummaryTokens,
      onTrace: (event) => {
        this.tracer?.trace(createSummarizationLLMCallEvent({
          iteration: event.iteration,
          prompt: event.prompt,
          rawResponse: event.rawResponse,
          parseSuccess: event.parseSuccess,
          parseError: event.parseError,
          durationMs: event.durationMs,
          outputTokens: event.outputTokens,
        }));
      },
      onFactsExtracted: (result) => this.handleFactsExtracted(result, memConfig),
    });

    // Task completion evaluator
    this.taskCompletionEvaluator = new TaskCompletionEvaluator(
      () => {
        const tier = this.chooseSmartTier('taskValidation', {
          task: this.currentTask,
          isInformationalTask: this.taskIntent ? this.taskIntent !== 'action' : undefined,
          iterationsUsed: 0,
        });
        return useLLM({ tier }) ?? null;
      },
      async (filePath) => {
        const result = await this.toolRegistry.execute('fs_read', { path: filePath });
        return result.success && result.output ? result.output : null;
      },
      (task) => getHistoricalChangesForSimilarTask(task, {
        sessionId: this.config.sessionId,
        sessionRootDir: this.sessionRootDir,
        agentId: this.agentId,
      }, SessionManager),
      (msg) => this.log(msg),
    );

    // Wire tool context
    const context = toolRegistry.getContext();
    this.state.files.importSharedContext(context.filesRead, context.filesReadHash);
    context.archiveMemory = this.archiveMemory;

    // Event listener
    if (config.onEvent) {
      this.eventEmitter.on(config.onEvent);
    }

    // File change tracking (non-critical)
    this.initFileChangeTracker(config, context);

    // Spawn agent capability (main agents only — no recursion for sub-agents)
    if (!config.parentAgentId) {
      this.initSpawnAgent(config, context);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /** Request graceful stop. Agent finishes current tool call then exits. */
  public requestStop(): void {
    this.abortController.abort();
  }

  /** Inject user context (correction/feedback) into the running agent. */
  public injectUserContext(message: string): void {
    this.injectedUserContext.push(message);
    this.log(`💬 User context injected: ${message.slice(0, 100)}...`);
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: { status: 'thinking', message: 'Processing user feedback...' },
    });
  }

  /**
   * Execute a task. Routes to mode handler if mode !== 'execute',
   * otherwise runs the tier escalation loop → ExecutionLoop.
   */
  async execute(task: string): Promise<TaskResult> {
    // Mode routing
    if (this.config.mode && this.config.mode.mode !== 'execute') {
      const { getModeHandler } = await import('../modes/mode-handler');
      const handler = await getModeHandler(this.config.mode);
      return handler.execute(task, this.config, this.toolRegistry);
    }

    // Load memory from disk
    if (this.memPersistDir) {
      this.factSheet = await FactSheet.load(this.memPersistDir, this.factSheetConfig);
      this.archiveMemory = await ArchiveMemory.load({
        ...this.archiveMemoryConfig,
        persistDir: this.memPersistDir,
      });
      this.toolRegistry.getContext().archiveMemory = this.archiveMemory;
    }

    await this.ensureWorkspaceDiscoveryLoaded();

    const startTier = this.config.tier || DEFAULT_EXECUTION_TIER;
    this.taskIntent = await this.inferTaskIntent(task);
    this.runStartTier = startTier;
    this.runFinalTier = startTier;
    this.state.budget.setCurrentTier(startTier);
    this.runMetricsEmitter.reset();

    // No escalation — single tier
    if (!this.config.enableEscalation) {
      return this.executeWithTier(task, startTier);
    }

    // Tier escalation loop: small → medium → large
    const tiers: LLMTier[] = ['small', 'medium', 'large'];
    const startIndex = Math.max(0, tiers.indexOf(startTier));

    for (let i = startIndex; i < tiers.length; i++) {
      const tier = tiers[i]!;
      this.log(`\n🎯 Trying with tier: ${tier}`);

      try {
        const result = await this.executeWithTier(task, tier);

        if (result.success) {
          if (tier !== startTier) {this.log(`✅ Succeeded after escalation to ${tier} tier`);}
          return result;
        }

        if (i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          await this.recordTierEscalation(tier, nextTier, 'tier_result_unsuccessful',
            this.completedIterations[this.completedIterations.length - 1] ?? 0);
          this.emitStatusChange(`Tier escalation: ${tier} -> ${nextTier} (previous tier returned partial/failed result)`);
          this.log(`⚠️  Failed with ${tier} tier, escalating to ${nextTier}...`);
        }
      } catch (error) {
        if (isTierEscalationSignal(error) && i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          await this.recordTierEscalation(tier, nextTier, error.reason, error.iteration);
          this.emitStatusChange(`Tier escalation: ${tier} -> ${nextTier} (reason: ${error.reason})`);
          this.log(`⚡ Escalating from ${tier} to ${nextTier} after ${error.iteration} iterations (${error.reason})`);
          continue;
        }
        this.log(`❌ Error with ${tier} tier: ${error}`);
        if (i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          const message = error instanceof Error ? error.message : String(error);
          await this.recordTierEscalation(tier, nextTier,
            `tier_error:${message.slice(0, 120)}`,
            this.completedIterations[this.completedIterations.length - 1] ?? 0);
        }
        if (i === tiers.length - 1) {throw error;}
      }
    }

    return this.executeWithTier(task, 'large');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core: executeWithTier → builds LoopContext → ExecutionLoop.run()
  // ─────────────────────────────────────────────────────────────────────────

  private async executeWithTier(task: string, tier: LLMTier): Promise<TaskResult> {
    this.runFinalTier = tier;
    this.state.budget.setCurrentTier(tier);
    this.logTaskHeader(task, tier);
    this.resetState();
    this.currentTask = task;
    this.startTime = Date.now();
    this.startTimestamp = new Date().toISOString();

    const effectiveMaxIterations = this.computeIterationBudget(task);
    this.state.budget.setIterationBudget(effectiveMaxIterations);
    const effectiveTokenBudget = await this.computeTokenBudget(task);
    this.state.budget.setTokenBudget(effectiveTokenBudget);
    const tokenBudgetPolicy = this.resolveTokenBudgetPolicy();

    // Emit lifecycle events
    this.emit({
      type: 'agent:start',
      timestamp: this.startTimestamp,
      sessionId: this.config.sessionId,
      data: { task, tier, maxIterations: effectiveMaxIterations, toolCount: this.toolRegistry.getDefinitions().length },
    });
    this.emitStatusChange('Starting task execution');

    if (this.memory) {
      await this.memory.add({ content: `Task started: ${task}`, type: 'task', metadata: { taskId: `task-${Date.now()}` } });
    }

    // Build messages
    const systemPrompt = await this.buildSystemPrompt();
    this.cachedSystemPrompt = systemPrompt;
    this.cachedTaskMessage = task;

    const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];
    await this.loadSessionHistory(messages);
    messages.push({ role: 'user', content: task });

    // Scope extraction
    this.transitionPhase('scoping', 'initial scope discovery');
    const suggestedScope = await this.extractScope(task);
    if (suggestedScope) {
      this.injectedUserContext.push(
        `Suggested initial scope from task/context: "${suggestedScope}". Start there first; widen scope only if local evidence is insufficient.`
      );
    }
    this.transitionPhase('planning_lite', 'scope/context prepared');

    const llm = useLLM({ tier });
    if (!llm?.chatWithTools) {
      return this.createFailureResult('LLM or chatWithTools not available', 0);
    }

    const smallLLM = useLLM({ tier: 'small' });
    if (smallLLM) {this.smartSummarizer.setLLM(smallLLM);}

    const tools = this.convertToolDefinitions();
    this.transitionPhase('executing', 'tool execution loop started');

    // Trace task:start
    if (this.tracer) {
      const taskStartEvent: TaskStartEvent = {
        seq: 0,
        type: 'task:start',
        timestamp: new Date().toISOString(),
        iteration: 0,
        task,
        tier,
        systemPrompt,
        availableTools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
      };
      this.tracer.trace(taskStartEvent);
    }

    // ── Closure state shared between LoopContext callbacks ──────────────────
    let iterationStartTimestamp = new Date().toISOString();
    let lastToolCalls: LLMToolCall[] = [];
    let pendingEarlyResult: TaskResult | undefined;

    // ── LoopContext ──────────────────────────────────────────────────────────
    const loopCtx: LoopContext<TaskResult> = {
      maxIterations: effectiveMaxIterations,

      isAborted: () => this.abortController.signal.aborted,

      checkHardTokenLimit: (_totalTokens) => undefined, // enforced inside callLLM

      callLLM: async (iterCtx) => {
        iterationStartTimestamp = new Date().toISOString();
        this.logIterationHeader(iterCtx.iteration, iterCtx.maxIterations);

        this.emit({
          type: 'iteration:start',
          timestamp: iterationStartTimestamp,
          sessionId: this.config.sessionId,
          data: { iteration: iterCtx.iteration, maxIterations: iterCtx.maxIterations },
        });

        // Hard token limit
        const hardLimitResult = await this.enforceTokenHardLimitIfNeeded({
          iteration: iterCtx.iteration, llm, messages,
          tokenBudget: effectiveTokenBudget, policy: tokenBudgetPolicy, iterationStartTimestamp,
        });
        if (hardLimitResult) {
          return { content: hardLimitResult.summary ?? '', toolCalls: [] };
        }

        // Todo discipline nudge
        if (shouldNudgeTodoDiscipline({
          nudgeSent: this.todoSyncCoordinator.state.nudgeSent,
          iteration: iterCtx.iteration,
          toolsUsedCount: this.state.execution.toolsUsedCount,
          task,
        })) {
          this.todoSyncCoordinator.ensureInitialized(task, this.config.sessionId);
          this.injectedUserContext.push(
            'This task appears multi-step. Create a short todo checklist now (3-7 items), keep it updated after each completed action block, and check it before final report.'
          );
          this.todoSyncCoordinator.markNudgeSent();
        }

        const availableTools = this.getCostAwareToolSet(tools, iterCtx.iteration, iterCtx.maxIterations, effectiveTokenBudget);

        if (this.tracer) {
          this.tracer.trace(createIterationDetailEvent({
            iteration: iterCtx.iteration,
            maxIterations: iterCtx.maxIterations,
            mode: 'auto',
            temperature: this.config.temperature,
            availableTools: availableTools.map((t) => t.name),
            messages,
            totalTokens: this.state.budget.totalTokensConsumed,
          }));
        }

        const response = await this.callLLMWithTools(
          llm, messages, availableTools, tier,
          iterCtx.iteration, this.cachedSystemPrompt, this.cachedTaskMessage
        );

        // Trace stopping analysis
        if (this.tracer) {
          const hasToolCalls = !!response.toolCalls?.length;
          const reachedMax = iterCtx.iteration >= iterCtx.maxIterations;
          this.tracer.trace(createStoppingAnalysisEvent({
            iteration: iterCtx.iteration,
            conditions: {
              maxIterationsReached: reachedMax,
              timeoutReached: false, foundTarget: false,
              sufficientContext: hasToolCalls, diminishingReturns: false,
              userInterrupt: false, error: false,
            },
            reasoning: !hasToolCalls || reachedMax
              ? (reachedMax ? 'Reached maximum iterations limit' : 'No tool calls, natural stop')
              : 'Continuing - LLM requested tool calls',
            iterationsUsed: iterCtx.iteration,
            iterationsRemaining: iterCtx.maxIterations - iterCtx.iteration,
            timeElapsedMs: Date.now() - this.startTime,
            toolCallsInLast3Iterations: response.toolCalls?.length || 0,
          }));
        }

        // Convergence nudges
        if (this.shouldNudgeConvergence(iterCtx.iteration, iterCtx.maxIterations, task)) {
          this.transitionPhase('converging', 'mid-run convergence checkpoint');
          this.injectedUserContext.push(
            'Convergence checkpoint: if enough evidence is already collected, stop exploring and provide a concrete answer now. Avoid broad directory scans.'
          );
        }
        if (
          !this.state.budget.convergenceNudgeSent
          && effectiveTokenBudget > 0
          && this.state.budget.totalTokensConsumed >= Math.floor(effectiveTokenBudget * tokenBudgetPolicy.softLimitRatio)
          && this.hasStrongEvidenceSignal(iterCtx.iteration)
        ) {
          this.transitionPhase('converging', 'token budget convergence checkpoint');
          this.injectedUserContext.push(
            `Token budget checkpoint (${this.state.budget.totalTokensConsumed}/${effectiveTokenBudget}). You already have meaningful evidence. Prefer synthesis/verification over additional broad searches.`
          );
          this.state.budget.markConvergenceNudgeSent();
        }

        // Force synthesis on last iteration with pending tool calls
        if (iterCtx.isLastIteration && response.toolCalls?.length) {
          this.transitionPhase('verifying', 'last iteration reached with pending tool calls');
          this.log(`🧩 Last iteration requested ${response.toolCalls.length} tool call(s); forcing synthesis.`);
          const synthesized = await this.forceSynthesisFromHistory({
            iteration: iterCtx.iteration, llm, messages,
            reason: 'Last iteration reached with pending tool calls',
            reasonCode: 'max_iterations', iterationStartTimestamp,
          });
          return { content: synthesized.summary ?? '', toolCalls: [] };
        }

        return {
          content: response.content ?? '',
          toolCalls: response.toolCalls?.map(tc => ({
            id: tc.id ?? '',
            name: tc.name,
            input: (tc.input as Record<string, unknown>) ?? {},
          })) ?? [],
          usage: response.usage ? {
            promptTokens: response.usage.promptTokens ?? 0,
            completionTokens: response.usage.completionTokens ?? 0,
          } : undefined,
        };
      },

      extractReportAnswer: (calls) => {
        const reportCall = calls.find(tc => tc.name === 'report');
        if (!reportCall) {return undefined;}
        return (reportCall.input?.answer as string) || 'No answer provided';
      },

      executeTools: async (calls, iterCtx) => {
        const llmCalls: LLMToolCall[] = calls.map(c => ({ id: c.id, name: c.name, input: c.input }));

        const evidenceBefore = this.getEvidenceProgressScore();
        const toolResults = await this.executeToolCalls(llmCalls, iterCtx.iteration);
        const evidenceDelta = Math.max(0, this.getEvidenceProgressScore() - evidenceBefore);

        lastToolCalls = llmCalls;
        toolResults.forEach(msg => messages.push(msg));

        const failedCount = this.countFailedToolResults(toolResults);
        await this.updateNoResultTracker(llmCalls, toolResults, iterCtx.iteration);

        if (llmCalls.length > 0) {
          const totalOutputSize = toolResults.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
          this.updateProgressTracker(llmCalls[0]!.name, totalOutputSize, {
            iteration: iterCtx.iteration, evidenceDelta, failedToolsThisIteration: failedCount,
            searchSignalHits: this.searchSignalTracker.state.searchSignalHits,
          });
        }

        await this.maybeRunOperationalReflection(
          { trigger: 'post_tools', iteration: iterCtx.iteration, toolCalls: llmCalls, toolResults, failedToolsThisIteration: failedCount, force: false },
          messages
        );

        // No-result early conclusion
        if (this.shouldConcludeNoResultEarly(iterCtx.iteration)) {
          await this.maybeRunOperationalReflection(
            { trigger: 'before_no_result', iteration: iterCtx.iteration, toolCalls: llmCalls, toolResults, failedToolsThisIteration: failedCount, force: true },
            messages
          );
          this.transitionPhase('reporting', 'no-result convergence');
          pendingEarlyResult = await this.createSuccessResult(
            { success: true, summary: this.buildNoResultConclusionSummary() }, iterCtx.iteration
          );
          return [{ toolCallId: '__early_exit__', output: pendingEarlyResult.summary ?? '', metadata: { _earlyResult: pendingEarlyResult } }];
        }

        // Async summarization
        if (iterCtx.iteration % AGENT_SUMMARIZER.summarizationInterval === 0) {
          const snapshot = this.contextFilter.getHistorySnapshot();
          this.smartSummarizer.triggerSummarization(snapshot, iterCtx.iteration)
            .catch((err: Error) => this.log(`⚠️  Background summarization failed: ${err.message}`));
        }

        // ask_parent
        const hasAskParent = llmCalls.some(tc => tc.name === 'ask_parent');
        if (hasAskParent && this.config.onAskParent) {
          const askCall = llmCalls.find(tc => tc.name === 'ask_parent');
          const inp = (askCall?.input ?? {}) as Record<string, unknown>;
          const parentResponse = await this.config.onAskParent({
            question: (inp.question as string) || 'No question provided',
            reason: (inp.reason as 'stuck' | 'uncertain' | 'blocker' | 'clarification') || 'uncertain',
            context: inp.context as Record<string, unknown> | undefined,
            iteration: iterCtx.iteration,
            subtask: this.currentTask,
          });
          messages.push({
            role: 'user',
            content: `📣 Parent agent response:\n\n${parentResponse.answer}${parentResponse.hint ? `\n\n💡 Hint: ${parentResponse.hint}` : ''}`,
          });
          if (parentResponse.action === 'skip') {
            pendingEarlyResult = await this.createSuccessResult(
              { success: true, summary: `Skipped on parent's guidance: ${parentResponse.answer}` }, iterCtx.iteration
            );
            return [{ toolCallId: '__skip__', output: pendingEarlyResult.summary ?? '', metadata: { _earlyResult: pendingEarlyResult } }];
          }
        }

        // Manual reflection auto-report
        const hasManualReflection = llmCalls.some(tc => tc.name === 'reflect_on_progress');
        if (hasManualReflection) {
          const reflectionCall = llmCalls.find(tc => tc.name === 'reflect_on_progress');
          const reflectionResult = toolResults.find(msg => msg.toolCallId === reflectionCall?.id);
          const meta = reflectionResult?.metadata as { shouldAutoReport?: boolean; reflection?: { findingsSummary: string; confidence: number } } | undefined;
          if (meta?.shouldAutoReport && meta?.reflection) {
            this.log(`\n🤔 Manual reflection triggered auto-report (confidence: ${meta.reflection.confidence.toFixed(2)})\n`);
            this.transitionPhase('reporting', 'reflect_on_progress auto-report');
            pendingEarlyResult = await this.createSuccessResult(
              { success: true, summary: meta.reflection.findingsSummary }, iterCtx.iteration
            );
            return [{ toolCallId: '__reflect_report__', output: pendingEarlyResult.summary ?? '', metadata: { _earlyResult: pendingEarlyResult } }];
          }
        }

        // Auto-detect stuck + ask_parent
        if (this.detectStuck() && this.config.onAskParent) {
          this.log(`\n🔄 Detected stuck pattern - asking parent for guidance...\n`);
          const stuckReason = this.progressTracker.state.lastToolCalls.length >= 3 &&
            new Set(this.progressTracker.state.lastToolCalls.slice(-3)).size === 1
            ? `Using same tool (${this.progressTracker.state.lastToolCalls[0]}) repeatedly`
            : `No progress for ${this.progressTracker.state.iterationsSinceProgress} iterations`;
          const parentResponse = await this.config.onAskParent({
            question: `I appear to be stuck. ${stuckReason}. What should I do?`,
            reason: 'stuck',
            context: { lastToolCalls: this.progressTracker.state.lastToolCalls, iterationsSinceProgress: this.progressTracker.state.iterationsSinceProgress },
            iteration: iterCtx.iteration, subtask: this.currentTask,
          });
          messages.push({
            role: 'user',
            content: `🤖 Auto-detected stuck pattern!\n\n📣 Parent guidance:\n\n${parentResponse.answer}${parentResponse.hint ? `\n\n💡 Hint: ${parentResponse.hint}` : ''}`,
          });
          this.progressTracker.state.iterationsSinceProgress = 0;
          this.progressTracker.state.lastToolCalls = [];
          this.progressTracker.state.lastOutputSizes = [];
          this.progressTracker.state.lastFailureCount = 0;
          this.progressTracker.state.lastSearchSignalHits = this.searchSignalTracker.state.searchSignalHits;
          this.progressTracker.state.lastProgressIteration = iterCtx.iteration;
          if (parentResponse.action === 'skip') {
            this.transitionPhase('reporting', 'parent requested skip');
            pendingEarlyResult = await this.createSuccessResult(
              { success: true, summary: `Skipped on parent's guidance (auto-stuck detection): ${parentResponse.answer}` },
              iterCtx.iteration
            );
            return [{ toolCallId: '__stuck_skip__', output: pendingEarlyResult.summary ?? '', metadata: { _earlyResult: pendingEarlyResult } }];
          }
        }

        return toolResults.map(msg => ({
          toolCallId: msg.toolCallId ?? '',
          output: msg.content ?? '',
          metadata: msg.metadata,
        }));
      },

      detectLoop: (calls) => {
        // Sentinel early-exit: stop immediately and return the pending result
        if (pendingEarlyResult) {
          return '__early_exit__';
        }
        const sigs = calls.map(tc => ({ name: tc.name, arguments: JSON.stringify(tc.input || {}) }));
        if (this.toolResultCache.detectLoop(sigs)) {
          this.transitionPhase('reporting', 'loop detected');
          this.log(`\n🔄 Loop detected — same tool calls repeated 3 times. Stopping.\n`);
          return 'Agent stuck in a loop — repeating the same actions. Report what was found so far.';
        }
        return undefined;
      },

      evaluateEscalation: (iterCtx) => {
        const result = this.evaluateTierEscalationNeed(iterCtx.iteration, iterCtx.maxIterations);
        if (result.shouldEscalate) {
          return { shouldEscalate: true, reason: result.reason };
        }
        return null;
      },

      extendBudget: (iterCtx) => {
        const extended = this.maybeExtendIterationBudget(iterCtx.iteration, iterCtx.maxIterations, task);
        if (extended > iterCtx.maxIterations) {
          this.state.budget.setIterationBudget(extended);
          this.emitStatusChange(
            `Progress detected, extending budget ${iterCtx.maxIterations} -> ${extended} (#${this.state.budget.iterationBudgetExtensions})`
          );
        }
        return extended;
      },

      buildResult: async (answer, iterCtx, reasonCode) => {
        // Sentinel early-exit from executeTools
        if (pendingEarlyResult) {return pendingEarlyResult;}

        if (reasonCode === 'abort_signal') {
          return this.createStoppedResult(iterCtx.iteration);
        }
        if (reasonCode === 'loop_detected') {
          return this.createFailureResult(answer, iterCtx.iteration, 'loop_detected');
        }
        if (reasonCode === 'no_tool_calls') {
          const validation = await this.validateTaskCompletion(task, answer, iterCtx.iteration);
          this.transitionPhase('reporting', 'validation completed');
          return this.createSuccessResult(validation, iterCtx.iteration);
        }
        if (reasonCode === 'max_iterations' || reasonCode === 'max_iterations_exhausted' || reasonCode === 'hard_token_limit') {
          this.transitionPhase('reporting', 'max iterations reached');
          return this.createFailureResult(
            `Max iterations (${iterCtx.maxIterations}) reached without completion`,
            iterCtx.maxIterations
          );
        }
        if (reasonCode === 'report_complete') {
          this.transitionPhase('reporting', 'report tool used');
          return this.createSuccessResult({ success: true, summary: answer }, iterCtx.iteration);
        }
        this.transitionPhase('reporting', 'error path');
        return this.createFailureResult(answer, iterCtx.iteration, reasonCode);
      },

      onIterationStart: (iterCtx) => {
        void iterCtx; // iteration:start emitted inside callLLM
      },

      onIterationEnd: (iterCtx, hadToolCalls) => {
        this.completedIterations.push(iterCtx.iteration);

        if (this.tracer) {
          this.tracer.trace(createMemorySnapshotEvent({
            iteration: iterCtx.iteration,
            conversationHistory: messages.length,
            userPreferences: {},
            facts: [],
            findings: [],
            filesRead: Array.from(this.state.files.filesRead),
            searchesMade: this.searchesMadeCount,
            toolsUsed: Object.fromEntries(this.state.execution.toolsUsedCount),
          }));
        }

        this.emit({
          type: 'iteration:end',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          startedAt: iterationStartTimestamp,
          data: {
            iteration: iterCtx.iteration,
            hadToolCalls,
            toolCallCount: hadToolCalls ? lastToolCalls.length : 0,
            cumulativeTokens: this.state.budget.totalTokensConsumed,
          },
        } as AgentEvent);
      },

      onTokensConsumed: (delta) => {
        this.state.budget.addTokens(delta);
      },
    };

    // ── Run the loop ─────────────────────────────────────────────────────────
    const loop = new ExecutionLoop<TaskResult>(loopCtx);
    const loopResult = await loop.run();

    if (loopResult.outcome === 'escalate') {
      throw new TierEscalationSignal(loopResult.reason ?? 'escalation', 0);
    }

    if (loopResult.outcome === 'complete') {
      return loopResult.result;
    }

    return this.createFailureResult('Unexpected loop outcome', 0);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers — emit / log / phase
  // ─────────────────────────────────────────────────────────────────────────

  private emit(event: AgentEvent): void {
    this.eventEmitter.emit({
      ...event,
      agentId: this.agentId,
      parentAgentId: this.config.parentAgentId,
    });
  }

  private emitStatusChange(message: string): void {
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: { status: 'thinking', message },
    });
  }

  private log(msg: string): void {
    if (this.config.verbose) {
      const logger = useLogger();
      if (logger) {
        logger.info(msg);
      } else {
        console.log(msg);
      }
    }
  }

  private transitionPhase(
    phase: string,
    reason: string,
  ): void {
    this.state.execution.stateMachine.transition(phase as Parameters<ExecutionStateMachine['transition']>[0], reason);
  }

  private consumeInjectedContext(): string | null {
    if (this.injectedUserContext.length === 0) {return null;}
    const context = this.injectedUserContext.map((msg, i) => `[User Feedback ${i + 1}]: ${msg}`).join('\n\n');
    this.injectedUserContext = [];
    return context;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization helpers
  // ─────────────────────────────────────────────────────────────────────────

  private initFileChangeTracker(config: AgentConfig, context: ReturnType<ToolRegistry['getContext']>): void {
    try {
      const logger = useLogger();
      const analytics = useAnalytics();
      const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const workingDir = context.workingDir;

      const storage = new SnapshotStorage(workingDir);
      this.fileChangeTracker = new FileChangeTracker(sessionId, this.agentId, workingDir, storage);

      analytics?.track('agent.file_history.initialized', { sessionId, agentId: this.agentId })
        .catch((err) => logger?.warn('[AgentRunner] Failed to track analytics event:', err));

      this.fileChangeTracker.cleanup()
        .catch((error) => logger?.warn('[AgentRunner] Failed to cleanup old sessions:', error));

      this.conflictDetector = new ConflictDetector(this.fileChangeTracker);
      this.conflictResolver = new ConflictResolver(DEFAULT_FILE_HISTORY_CONFIG.conflictResolution.escalationPolicy);

      context.fileChangeTracker = this.fileChangeTracker;
      context.agentId = this.agentId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      useLogger()?.warn('[AgentRunner] Failed to initialize FileChangeTracker:', { error: msg });
    }
  }

  private initSpawnAgent(config: AgentConfig, context: ReturnType<ToolRegistry['getContext']>): void {
    let subtaskCounter = 0;

    context.spawnAgent = async (request) => {
      const subtaskIndex = subtaskCounter++;
      const subtaskId = `subtask-${this.agentId}-${subtaskIndex}`;
      const childWorkingDir = request.workingDir
        ? path.resolve(config.workingDir, request.workingDir)
        : config.workingDir;

      this.emit({
        type: 'subtask:start',
        timestamp: new Date().toISOString(),
        sessionId: config.sessionId,
        data: { subtaskId, description: request.task, index: subtaskIndex, total: 0 },
      });

      const childConfig: AgentConfig = {
        workingDir: childWorkingDir,
        maxIterations: request.maxIterations || 10,
        temperature: config.temperature,
        verbose: config.verbose,
        sessionId: config.sessionId,
        tier: config.tier || DEFAULT_EXECUTION_TIER,
        parentAgentId: this.agentId,
        tracer: config.tracer,
        memory: config.memory,
        onEvent: config.onEvent,
        abortSignal: this.abortController.signal,
      };

      const childToolRegistry = createToolRegistry({
        workingDir: childWorkingDir,
        sessionId: config.sessionId,
        cache: useCache(),
      });
      const childAgent = new AgentRunner(childConfig, childToolRegistry);

      try {
        const result = await childAgent.execute(request.task);
        this.emit({
          type: 'subtask:end',
          timestamp: new Date().toISOString(),
          sessionId: config.sessionId,
          data: { subtaskId, success: result.success, summary: `${result.iterations} iterations, ${result.tokensUsed} tokens: ${result.summary || 'No result'}` },
        });
        return { success: result.success, result: result.summary || 'No result', iterations: result.iterations, tokensUsed: result.tokensUsed };
      } catch (error) {
        this.emit({
          type: 'subtask:end',
          timestamp: new Date().toISOString(),
          sessionId: config.sessionId,
          data: { subtaskId, success: false, summary: `Failed: ${error instanceof Error ? error.message : String(error)}` },
        });
        throw error;
      }
    };
  }

  private handleFactsExtracted(result: Parameters<ConstructorParameters<typeof SmartSummarizer>[0]['onFactsExtracted']>[0], memConfig: AgentConfig['twoTierMemory']): void {
    const beforeStats = this.factSheet.getStats();
    let newFacts = 0;
    let mergedFacts = 0;

    for (const extractedFact of result.facts) {
      const minConfidence = memConfig?.autoFactMinConfidence ?? AGENT_MEMORY.autoFactMinConfidence;
      if (extractedFact.confidence < minConfidence) {continue;}
      const { entry, merged } = this.factSheet.addFact({
        category: extractedFact.category,
        fact: extractedFact.fact,
        confidence: extractedFact.confidence,
        source: extractedFact.source,
        iteration: result.iterationRange[1],
      });
      if (merged) {mergedFacts++;} else {newFacts++;}

      if (this.tracer) {
        this.tracer.trace(createFactAddedEvent({
          iteration: result.iterationRange[1],
          fact: { id: entry.id, category: entry.category, fact: entry.fact, confidence: entry.confidence, source: entry.source, merged },
          factSheetStats: this.factSheet.getStats(),
        }));
      }
    }

    const afterStats = this.factSheet.getStats();
    if (this.tracer) {
      const factsExtracted = result.facts.length;
      const factsByCategory: Record<string, number> = {};
      for (const f of result.facts) {factsByCategory[f.category] = (factsByCategory[f.category] || 0) + 1;}

      this.tracer.trace(createSummarizationResultEvent({
        iteration: result.iterationRange[1],
        input: { iterationRange: result.iterationRange, messagesCount: result.messagesCount, inputChars: result.inputChars, inputTokens: result.inputTokens },
        output: { factsExtracted, factsByCategory, outputTokens: result.outputTokens, llmDurationMs: result.llmDurationMs },
        delta: {
          factSheetBefore: beforeStats.totalFacts,
          factSheetAfter: afterStats.totalFacts,
          tokensBefore: beforeStats.estimatedTokens,
          tokensAfter: afterStats.estimatedTokens,
          newFacts,
          mergedFacts,
          evictedFacts: Math.max(0, beforeStats.totalFacts + newFacts - afterStats.totalFacts),
        },
        efficiency: {
          compressionRatio: result.outputTokens > 0 ? result.inputTokens / result.outputTokens : 0,
          factDensity: result.messagesCount > 0 ? factsExtracted / result.messagesCount : 0,
          newFactRate: factsExtracted > 0 ? newFacts / factsExtracted : 0,
        },
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session history loading
  // ─────────────────────────────────────────────────────────────────────────

  private async loadSessionHistory(messages: LLMMessage[]): Promise<void> {
    if (!this.config.sessionId || (!this.sessionRootDir && !this.config.conversationHistory)) {return;}

    const history = this.config.conversationHistory
      ?? (this.sessionRootDir
        ? await new SessionManager(this.sessionRootDir).getConversationHistoryWithSummarization(this.config.sessionId)
        : { recent: [], midTerm: [], old: [] });
    const traceArtifactsContext = this.config.traceArtifactsContext
      ?? (this.sessionRootDir
        ? await new SessionManager(this.sessionRootDir).getTraceArtifactsContext(this.config.sessionId)
        : '');

    const totalTurns = history.recent.length + history.midTerm.length + history.old.length;
    if (totalTurns > 0) {
      this.log(`📜 Loaded ${totalTurns} previous turn(s) from session history`);
      for (const turns of [history.old, history.midTerm, history.recent]) {
        for (const turn of turns) {
          if (turn.userTask?.trim()) {messages.push({ role: 'user', content: turn.userTask });}
          if (turn.agentResponse?.trim()) {messages.push({ role: 'assistant', content: turn.agentResponse });}
        }
      }
    }

    if (traceArtifactsContext.trim()) {
      messages.push({ role: 'system', content: traceArtifactsContext });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Delegated to existing Agent methods (keep identical to Agent for parity)
  // These will be referenced by copy from agent.ts until full migration.
  // ─────────────────────────────────────────────────────────────────────────

  // The following methods are delegated implementations that exist in agent.ts.
  // They are declared here as abstract references and will be implemented in
  // a follow-up step by extracting them from agent.ts.

  private resetState(tier: LLMTier = DEFAULT_EXECUTION_TIER): void {
    this.state = new StateManager({
      maxIterations: this.config.maxIterations ?? 25,
      initialTier: tier,
    });
    this.completedIterations = [];
    this.searchesMadeCount = 0;
    this.lastLLMCall = undefined;
    this.lastToolCall = undefined;
    this.lastQualityGate = null;
    this.previousContextSnapshot = null;
    this.behaviorPolicy = createDefaultAgentBehaviorPolicy();
    this.progressTracker = new ProgressTrackerModule();
    this.injectedUserContext = [];
    this.lastSignalIteration = 0;
    this.contextFilter = new ContextFilter({
      maxOutputLength: AGENT_CONTEXT.maxToolOutputChars,
      slidingWindowSize: AGENT_CONTEXT.slidingWindowSize,
      enableDeduplication: true,
    });
  }

  private logTaskHeader(task: string, tier: LLMTier): void {
    this.log(`\n${'='.repeat(60)}`);
    this.log(`🤖 AgentRunner executing task (tier: ${tier})`);
    this.log(`${'='.repeat(60)}\n`);
    this.log(`📋 Task: ${task}\n`);
  }

  private logIterationHeader(iteration: number, maxIterations: number): void {
    this.log(`\n${'─'.repeat(50)}`);
    this.log(`🔄 Iteration ${iteration}/${maxIterations}`);
    this.log(`${'─'.repeat(50)}`);
  }

  private convertToolDefinitions(): LLMTool[] {
    return this.toolRegistry.getDefinitions().map((def) => ({
      name: def.function.name,
      description: def.function.description,
      inputSchema: def.function.parameters as Record<string, unknown>,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Delegation stubs — implemented by copying from Agent (next step)
  // ─────────────────────────────────────────────────────────────────────────
  // The methods below forward to agent.ts equivalents during migration.
  // Once all are extracted, agent.ts can be deleted.

   
  private async buildSystemPrompt(): Promise<string> { return (this as any).__buildSystemPrompt(); }
  private async extractScope(task: string): Promise<string | null> { return (this as any).__extractScope(task); }
  private async inferTaskIntent(task: string): Promise<'action' | 'discovery' | 'analysis'> { return (this as any).__inferTaskIntent(task); }
  private computeIterationBudget(task: string): number { return (this as any).__computeIterationBudget(task); }
  private async computeTokenBudget(task: string): Promise<number> { return (this as any).__computeTokenBudget(task); }
  private resolveTokenBudgetPolicy(): ResolvedTokenBudgetPolicy { return (this as any).__resolveTokenBudgetPolicy(); }
  private chooseSmartTier(node: string, context?: object): LLMTier { return (this as any).__chooseSmartTier(node, context); }
  private getCostAwareToolSet(tools: LLMTool[], iteration: number, maxIterations: number, tokenBudget: number): LLMTool[] { return (this as any).__getCostAwareToolSet(tools, iteration, maxIterations, tokenBudget); }
  private async callLLMWithTools(llm: ILLM, messages: LLMMessage[], tools: LLMTool[], tier: LLMTier, iteration: number, systemPrompt?: string, taskMessage?: string): Promise<LLMToolCallResponse> { return (this as any).__callLLMWithTools(llm, messages, tools, tier, iteration, systemPrompt, taskMessage); }
  private async executeToolCalls(toolCalls: LLMToolCall[], iteration: number): Promise<LLMMessage[]> { return (this as any).__executeToolCalls(toolCalls, iteration); }
  private async enforceTokenHardLimitIfNeeded(input: any): Promise<TaskResult | null> { return (this as any).__enforceTokenHardLimitIfNeeded(input); }
  private async forceSynthesisFromHistory(input: any): Promise<TaskResult> { return (this as any).__forceSynthesisFromHistory(input); }
  private shouldNudgeConvergence(iteration: number, maxIterations: number, task: string): boolean { return (this as any).__shouldNudgeConvergence(iteration, maxIterations, task); }
  private hasStrongEvidenceSignal(iterationsUsed: number): boolean { return (this as any).__hasStrongEvidenceSignal(iterationsUsed); }
  private getEvidenceProgressScore(): number { return (this as any).__getEvidenceProgressScore(); }
  private countFailedToolResults(results: LLMMessage[]): number { return countFailedToolResults(results); }
  private async updateNoResultTracker(calls: LLMToolCall[], results: LLMMessage[], iteration: number): Promise<void> { return (this as any).__updateNoResultTracker(calls, results, iteration); }
  private updateProgressTracker(firstToolName: string, totalOutputSize: number, ctx: any): void { return (this as any).__updateProgressTracker(firstToolName, totalOutputSize, ctx); }
  private async maybeRunOperationalReflection(ctx: any, messages: LLMMessage[]): Promise<void> { return (this as any).__maybeRunOperationalReflection(ctx, messages); }
  private shouldConcludeNoResultEarly(iteration: number): boolean { return (this as any).__shouldConcludeNoResultEarly(iteration); }
  private buildNoResultConclusionSummary(): string { return (this as any).__buildNoResultConclusionSummary(); }
  private detectStuck(): boolean { return (this as any).__detectStuck(); }
  private evaluateTierEscalationNeed(iteration: number, maxIterations: number): { shouldEscalate: boolean; reason: string } { return (this as any).__evaluateTierEscalationNeed(iteration, maxIterations); }
  private maybeExtendIterationBudget(iteration: number, maxIterations: number, task: string): number { return (this as any).__maybeExtendIterationBudget(iteration, maxIterations, task); }
  private async validateTaskCompletion(task: string, answer: string, iteration: number): Promise<any> { return (this as any).__validateTaskCompletion(task, answer, iteration); }
  private async createSuccessResult(validation: any, iteration: number): Promise<TaskResult> { return (this as any).__createSuccessResult(validation, iteration); }
  private async createFailureResult(msg: string, iteration: number, code?: string): Promise<TaskResult> { return (this as any).__createFailureResult(msg, iteration, code); }
  private async createStoppedResult(iteration: number): Promise<TaskResult> { return (this as any).__createStoppedResult(iteration); }
  private async recordTierEscalation(from: LLMTier, to: LLMTier, reason: string, iteration: number): Promise<void> { return (this as any).__recordTierEscalation(from, to, reason, iteration); }
  private async ensureWorkspaceDiscoveryLoaded(): Promise<void> { return (this as any).__ensureWorkspaceDiscoveryLoaded(); }
  private async callSearchSignalLLM(artifacts: SearchArtifact[]): Promise<{ signal: 'none' | 'partial' | 'strong'; snippets: string[] }> { return (this as any).__callSearchSignalLLM(artifacts); }
  private callReflectionLLM(input: any): Promise<any> { return (this as any).__callReflectionLLM(input); }
  private async executeTodoTool(toolName: string, input: Record<string, unknown>): Promise<any> { return (this as any).__executeTodoTool(toolName, input); }
   
}
