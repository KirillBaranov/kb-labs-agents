/**
 * Base agent implementation with LLM tool calling
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  TaskResult,
  TraceEntry,
  LLMTier,
  Tracer,
  AgentMemory,
  AgentEvent,
  TaskStartEvent,
  TaskEndEvent,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import { createToolRegistry } from '@kb-labs/agent-tools';
import {
  useLLM,
  useLogger,
  useAnalytics,
  useCache,
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
  isLikelyActionTask,
} from './budget/index.js';
import { SystemPromptBuilder } from '../prompt/index.js';
import {
  ToolInputNormalizer,
  isGuardRejectedToolCallError,
  isRiskyShellCommand,
} from './tool-input/index.js';
import {
  ProgressTracker as ProgressTrackerModule,
  countFailedToolResults,
} from './progress/index.js';
import {
  SearchSignalTracker,
  assessSearchSignalHeuristic,
  isLikelyDiscoveryTask,
} from './search-signal/index.js';
import type { SearchArtifact } from './search-signal/index.js';
import {
  RunMetricsEmitter,
  getKpiBaselineKey,
  extractToolErrorCode,
} from '../analytics/index.js';
import type { EmitContext } from '../analytics/index.js';
import { ReflectionEngine } from './reflection/index.js';
import { TodoSyncCoordinator, shouldNudgeTodoDiscipline } from './todo-sync/index.js';
import { TaskClassifier } from './task-classifier/index.js';
import {
  TaskCompletionEvaluator,
  getHistoricalChangesForSimilarTask,
} from './task-completion/index.js';
import type { CompletionEvaluationContext } from './task-completion/index.js';

/**
 * Event type constants
 */
const EVENT_TYPE_STATUS_CHANGE = 'status:change';
const DEFAULT_EXECUTION_TIER: LLMTier = 'medium';
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 90_000;
const SYNTHESIS_HEARTBEAT_INTERVAL_MS = 10_000;

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

/**
 * Tool execution result
 */
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
  /** Optional metadata from tool execution (e.g., reflection results, file counts, etc.) */
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

import { createEventEmitter } from './events/event-emitter.js';
import { SessionManager } from '../planning/session-manager.js';
import {
  createIterationDetailEvent,
  createLLMCallEvent,
  createToolExecutionEvent,
  createMemorySnapshotEvent,
  createSynthesisForcedEvent,
  createToolFilterEvent,
  createLLMValidationEvent,
  createStoppingAnalysisEvent,
  createContextTrimEvent,
  createFactAddedEvent,
  createArchiveStoreEvent,
  createSummarizationResultEvent,
  createSummarizationLLMCallEvent,
} from '@kb-labs/agent-tracing';
import { ContextFilter } from './context/context-filter.js';
import { SmartSummarizer, extractHeuristicFacts } from './context/smart-summarizer.js';
import { FactSheet } from './memory/fact-sheet.js';
import { ArchiveMemory } from './memory/archive-memory.js';
// context_retrieve tool removed — agents should re-read files instead
import { FileChangeTracker, SnapshotStorage, ConflictDetector, ConflictResolver } from '@kb-labs/agent-history';
import {
  AGENT_ANALYTICS_EVENTS,
  DEFAULT_FILE_HISTORY_CONFIG,
  DEFAULT_AGENT_TOKEN_BUDGET_CONFIG,
} from '@kb-labs/agent-contracts';
import { mapToolToCapability } from '../execution/task-ledger.js';
import { createDefaultAgentBehaviorPolicy, type AgentBehaviorPolicy } from '../execution/policy.js';
import { discoverWorkspace, type WorkspaceDiscoveryResult } from '../execution/workspace-discovery.js';
import { ToolResultCache } from '../execution/tool-result-cache.js';
import { ExecutionLoop } from '../execution/loop.js';
import type { LoopContext, LoopToolCall, IterationContext } from '../execution/loop.js';
import { StateManager } from './state/index.js';


/**
 * Generate unique agent ID
 */
function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Base Agent with LLM tool calling
 */
export class Agent {
   
  private config: any;
  private toolRegistry: ToolRegistry;
  private state: StateManager;
  private trace: TraceEntry[] = [];
  private tracer?: Tracer;

  private readonly toolResultCache = new ToolResultCache();
  private readonly iterationBudget = new IterationBudget();
  private readonly qualityGate = new QualityGate();
  private readonly tierSelector = new TierSelector();
  private readonly systemPromptBuilder = new SystemPromptBuilder();
  private readonly searchSignalTracker = new SearchSignalTracker(
    (artifacts) => this.callSearchSignalLLM(artifacts),
  );
  private readonly runMetricsEmitter = new RunMetricsEmitter();
  private readonly reflectionEngine = new ReflectionEngine(
    (input) => this.callReflectionLLM(input),
  );
  private readonly toolInputNormalizer = new ToolInputNormalizer(fs);
  private memory?: AgentMemory;
  private currentTask?: string;
  private eventEmitter = createEventEmitter();
  private startTime = 0;
  private startTimestamp = ''; // ISO string for startedAt in agent:end events

  /** Unique ID for this agent instance (for event correlation) */
  public readonly agentId: string;

  /** AbortController for graceful stop — signal is propagated to child agents */
  private readonly abortController: AbortController;

  /** Request graceful stop. Agent finishes current tool call then exits between iterations. */
  public requestStop(): void {
    this.abortController.abort();
  }

  /**
   * User context injected during execution (corrections, feedback)
   * Will be included in the next LLM call
   */
  private injectedUserContext: string[] = [];

  /**
   * Detailed tracing state for incremental trace events
   */
  private searchesMadeCount = 0;
  private lastLLMCall?: { request: unknown; response: unknown; durationMs: number };
  private lastToolCall?: { name: string; input: unknown; output?: unknown; error?: string };
  private completedIterations: number[] = [];
  private runStartTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private runFinalTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private behaviorPolicy: AgentBehaviorPolicy = createDefaultAgentBehaviorPolicy();
  private workspaceDiscovery: WorkspaceDiscoveryResult | null = null;
  private lastSignalIteration = 0;
  private taskIntent: 'action' | 'discovery' | 'analysis' | null = null;
  private lastQualityGate: {
    status: 'pass' | 'partial';
    score: number;
    reasons: string[];
    nextChecks?: string[];
  } | null = null;
  private readonly todoSyncCoordinator = new TodoSyncCoordinator(
    (toolName, input) => this.executeTodoTool(toolName, input),
    (name) => this.toolRegistry.getDefinitions().some((d) => d.function.name === name),
    (msg) => this.log(msg),
  );
  private readonly taskClassifier = new TaskClassifier(
    (tier) => useLLM({ tier: tier as LLMTier }) ?? null,
    (msg) => this.log(msg),
  );

  private readonly taskCompletionEvaluator: TaskCompletionEvaluator;

  /** Progress tracking to detect when agent is stuck */
  private progressTracker = new ProgressTrackerModule();

  /**
   * Context optimization components (Phase 4: Integration)
   */
  private contextFilter: ContextFilter;
  private smartSummarizer: SmartSummarizer;
  private factSheet: FactSheet;
  private archiveMemory: ArchiveMemory;
  private memPersistDir?: string;
  private factSheetConfig: { maxTokens: number; maxEntries: number } = { maxTokens: 0, maxEntries: 0 };
  private archiveMemoryConfig: { maxEntries: number; maxTotalChars: number } = { maxEntries: 0, maxTotalChars: 0 };
  private cachedSystemPrompt?: string;
  private cachedTaskMessage?: string;
  /** Stable root directory for session history/memory lookup (must not change with scope narrowing). */
  private sessionRootDir: string;

  /**
   * Previous context snapshot for diff tracking between iterations
   */
  private previousContextSnapshot: {
    iteration: number;
    messageCount: number;
    totalChars: number;
    systemPromptChars: number;
    messages: Array<{ role: string; chars: number }>;
  } | null = null;

  /**
   * File change tracking (Phase 1: File History)
   */
  private fileChangeTracker?: FileChangeTracker;
  private conflictDetector?: ConflictDetector;
  private conflictResolver?: ConflictResolver;

   
  constructor(config: any, toolRegistry: ToolRegistry) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.state = new StateManager({
      maxIterations: config.maxIterations ?? 25,
      initialTier: DEFAULT_EXECUTION_TIER,
    });
    this.tracer = config.tracer;
    this.memory = config.memory;
    this.sessionRootDir = config.workingDir;

    // Generate unique ID for this agent instance
    this.agentId = config.agentId || generateAgentId();

    // AbortController — new one per agent; if parent passes a signal, abort when it fires
    this.abortController = new AbortController();
    if (config.abortSignal) {
      config.abortSignal.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }

    // Use shared file tracking from tool context if available (for edit protection)
    const context = toolRegistry.getContext();
    this.state.files.importSharedContext(context.filesRead, context.filesReadHash);

    // Initialize file change tracker (Phase 1: File History)
    // Use sessionId from config for correlation, or generate if not provided
    const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const workingDir = context.workingDir;

    try {
      const logger = useLogger();
      const analytics = useAnalytics();

      const storage = new SnapshotStorage(workingDir);
      this.fileChangeTracker = new FileChangeTracker(
        sessionId,
        this.agentId,
        workingDir,
        storage
      );

      // Track file history initialization (fire and forget)
      analytics?.track('agent.file_history.initialized', {
        sessionId,
        agentId: this.agentId,
      }).catch((err) => {
        logger?.warn('[Agent] Failed to track analytics event:', err);
      });

      // Cleanup old sessions (async, non-blocking)
      this.fileChangeTracker.cleanup().catch((error) => {
        logger?.warn('[Agent] Failed to cleanup old sessions:', error);
      });

      // Initialize conflict detection and resolution (Phase 2.5)
      this.conflictDetector = new ConflictDetector(this.fileChangeTracker);

      // Get escalation policy from config or use default
      const escalationPolicy = DEFAULT_FILE_HISTORY_CONFIG.conflictResolution.escalationPolicy;
      this.conflictResolver = new ConflictResolver(escalationPolicy);

      // Inject tracker into tool context for fs_write and fs_patch
      context.fileChangeTracker = this.fileChangeTracker;
      context.agentId = this.agentId;

      // Inject spawnAgent callback for main agents (sub-agents don't get it → no recursion)
      if (!config.parentAgentId) {
        let subtaskCounter = 0;

        context.spawnAgent = async (request) => {
          const subtaskIndex = subtaskCounter++;
          const subtaskId = `subtask-${this.agentId}-${subtaskIndex}`;
          const childWorkingDir = request.workingDir
            ? path.resolve(config.workingDir, request.workingDir)
            : config.workingDir;

          // Emit subtask:start so UI/tracer can track sub-agent lifecycle
          this.emit({
            type: 'subtask:start',
            timestamp: new Date().toISOString(),
            sessionId: config.sessionId,
            data: {
              subtaskId,
              description: request.task,
              index: subtaskIndex,
              total: 0, // unknown upfront
            },
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

          // Create fresh toolRegistry WITHOUT spawnAgent → sub-agent can't spawn further
          const childToolContext = {
            workingDir: childWorkingDir,
            sessionId: config.sessionId,
            cache: useCache(),
          };
          const childToolRegistry = createToolRegistry(childToolContext);

          const childAgent = new Agent(childConfig, childToolRegistry);

          try {
            const result = await childAgent.execute(request.task);

            // Emit subtask:end with result
            this.emit({
              type: 'subtask:end',
              timestamp: new Date().toISOString(),
              sessionId: config.sessionId,
              data: {
                subtaskId,
                success: result.success,
                summary: `${result.iterations} iterations, ${result.tokensUsed} tokens: ${result.summary || 'No result'}`,
              },
            });

            return {
              success: result.success,
              result: result.summary || 'No result',
              iterations: result.iterations,
              tokensUsed: result.tokensUsed,
            };
          } catch (error) {
            // Emit subtask:end with failure
            this.emit({
              type: 'subtask:end',
              timestamp: new Date().toISOString(),
              sessionId: config.sessionId,
              data: {
                subtaskId,
                success: false,
                summary: `Failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
            throw error;
          }
        };
      }
    } catch (error) {
      const logger = useLogger();
      // Non-critical: if tracker initialization fails, agent still works
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.warn('[Agent] Failed to initialize FileChangeTracker:', { error: errorMessage });
    }

    // Initialize context optimization (Phase 4)
    this.contextFilter = new ContextFilter({
      maxOutputLength: AGENT_CONTEXT.maxToolOutputChars,
      slidingWindowSize: AGENT_CONTEXT.slidingWindowSize,
      enableDeduplication: true,
    });

    // Initialize two-tier memory (load from disk if session exists)
    const memConfig = config.twoTierMemory;
    this.memPersistDir = config.sessionId
      ? path.join(this.sessionRootDir, '.kb', 'memory', config.sessionId)
      : undefined;
    const factSheetConfig = {
      maxTokens: memConfig?.factSheetMaxTokens ?? AGENT_MEMORY.factSheetMaxTokens,
      maxEntries: memConfig?.factSheetMaxEntries ?? AGENT_MEMORY.factSheetMaxEntries,
    };
    // Store configs for use in run() when loading from disk
    this.factSheetConfig = factSheetConfig;
    this.archiveMemoryConfig = {
      maxEntries: memConfig?.archiveMaxEntries ?? AGENT_MEMORY.archiveMaxEntries,
      maxTotalChars: AGENT_MEMORY.archiveMaxTotalChars,
    };
    // Initialize with empty memory — will be loaded from disk at start of run()
    this.factSheet = new FactSheet(factSheetConfig);
    this.archiveMemory = new ArchiveMemory({
      ...this.archiveMemoryConfig,
      persistDir: this.memPersistDir,
    });

    // Inject archiveMemory into tool context so archive_recall tool can access it
    context.archiveMemory = this.archiveMemory;

    this.smartSummarizer = new SmartSummarizer({
      summarizationInterval: AGENT_SUMMARIZER.summarizationInterval,
      llmTier: 'small',
      maxSummaryTokens: AGENT_SUMMARIZER.maxSummaryTokens,
      onTrace: (event) => {
        if (this.tracer) {
          this.tracer.trace(createSummarizationLLMCallEvent({
            iteration: event.iteration,
            prompt: event.prompt,
            rawResponse: event.rawResponse,
            parseSuccess: event.parseSuccess,
            parseError: event.parseError,
            durationMs: event.durationMs,
            outputTokens: event.outputTokens,
          }));
        }
      },
      onFactsExtracted: (result) => {
        // Snapshot FactSheet before adding LLM-extracted facts
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

          if (merged) {
            mergedFacts++;
          } else {
            newFacts++;
          }

          // Trace each fact addition
          if (this.tracer) {
            this.tracer.trace(createFactAddedEvent({
              iteration: result.iterationRange[1],
              fact: {
                id: entry.id,
                category: entry.category,
                fact: entry.fact,
                confidence: entry.confidence,
                source: entry.source,
                merged,
              },
              factSheetStats: this.factSheet.getStats(),
            }));
          }
        }

        // Trace summarization result
        const afterStats = this.factSheet.getStats();
        if (this.tracer) {
          const factsExtracted = result.facts.length;
          const factsByCategory: Record<string, number> = {};
          for (const f of result.facts) {
            factsByCategory[f.category] = (factsByCategory[f.category] || 0) + 1;
          }

          this.tracer.trace(createSummarizationResultEvent({
            iteration: result.iterationRange[1],
            input: {
              iterationRange: result.iterationRange,
              messagesCount: result.messagesCount,
              inputChars: result.inputChars,
              inputTokens: result.inputTokens,
            },
            output: {
              factsExtracted,
              factsByCategory,
              outputTokens: result.outputTokens,
              llmDurationMs: result.llmDurationMs,
            },
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
      },
    });

    // Subscribe external callback if provided
    if (config.onEvent) {
      this.eventEmitter.on(config.onEvent);
    }

    // Initialize task completion evaluator
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
  }

  /**
   * Emit event to all listeners
   * Automatically adds agentId and parentAgentId for event correlation
   */
  private emit(event: AgentEvent): void {
    // Add hierarchical correlation IDs to all events
    const enrichedEvent = {
      ...event,
      agentId: this.agentId,
      parentAgentId: this.config.parentAgentId,
    };
    this.eventEmitter.emit(enrichedEvent);
  }

  /**
   * Inject user context (correction/feedback) into the running agent
   * This context will be included in the next LLM call as a system message
   *
   * @param message - User message to inject (correction, feedback, etc.)
   */
  injectUserContext(message: string): void {
    this.injectedUserContext.push(message);
    this.log(`💬 User context injected: ${message.slice(0, 100)}...`);

    // Emit event for UI
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: 'Processing user feedback...',
      },
    });
  }

  /**
   * Get and clear injected user context
   * Called before each LLM call to include user feedback
   */
  private consumeInjectedContext(): string | null {
    if (this.injectedUserContext.length === 0) {
      return null;
    }

    const context = this.injectedUserContext
      .map((msg, i) => `[User Feedback ${i + 1}]: ${msg}`)
      .join('\n\n');

    this.injectedUserContext = [];
    return context;
  }

  /**
   * Extract scope (subdirectory) from task using LLM tool calling.
   * If task mentions a specific repo/folder, narrows workingDir for faster search.
   * Only runs for main agents (not sub-agents).
   */
  private async extractScope(task: string): Promise<string | null> {
    return this.taskClassifier.extractScope(task, {
      maxIterations: this.config.maxIterations || 25,
      parentAgentId: this.config.parentAgentId,
      workingDir: this.config.workingDir,
    });
  }

  /**
   * Apply extracted scope by narrowing workingDir in config and tool context.
   */
  private applyScope(scope: string): void {
    const scopedDir = path.join(this.config.workingDir, scope);
    if (fs.existsSync(scopedDir) && fs.statSync(scopedDir).isDirectory()) {
      this.config = { ...this.config, workingDir: scopedDir };
      const context = this.toolRegistry.getContext();
      context.workingDir = scopedDir;
      this.log(`📁 Scoped workingDir: ${scopedDir}`);
    }
  }

  private async ensureWorkspaceDiscoveryLoaded(): Promise<void> {
    if (this.workspaceDiscovery) {
      return;
    }

    try {
      const discovery = await discoverWorkspace(this.sessionRootDir || this.config.workingDir);
      this.workspaceDiscovery = discovery;

      if (this.memory && discovery.repos.length > 0) {
        const summary = discovery.repos
          .slice(0, 20)
          .map((repo) => `${path.relative(discovery.rootDir, repo.path) || '.'} [${repo.reasons.join(',')}]`)
          .join('\n');
        await this.memory.add({
          content: `Workspace map:\n${summary}`,
          type: 'finding',
          metadata: {
            scope: 'project',
            source: 'agent',
            importance: 0.55,
          },
        });
      }
    } catch (error) {
      this.log(`[Agent] Workspace discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private chooseSmartTier(
    node: 'intentInference' | 'searchAssessment' | 'taskValidation',
    context?: {
      task?: string;
      hasDiscoveryCue?: boolean;
      hasActionCue?: boolean;
      artifactCount?: number;
      evidenceDensity?: number;
      iterationsUsed?: number;
      isInformationalTask?: boolean;
    }
  ): LLMTier {
    return this.tierSelector.chooseSmartTier(node, {
      smartTiering: this.config.smartTiering,
      currentIterationBudget: this.state.budget.iterationBudget,
      maxIterations: this.config.maxIterations || 25,
      progressIterationsSinceProgress: this.progressTracker.state.iterationsSinceProgress,
      currentTask: this.currentTask,
    }, context);
  }

  private async inferTaskIntent(task: string): Promise<'action' | 'discovery' | 'analysis'> {
    const result = await this.classifyTaskWithLLM(task);
    this.state.budget.setTaskBudget(result.budget);    return result.intent;
  }

  /**
   * LLM-based task classification. Returns intent + initial iteration budget.
   * Called once at execution start; replaces all regex-based heuristics.
   */
  private async classifyTaskWithLLM(
    task: string,
  ): Promise<{ intent: 'action' | 'discovery' | 'analysis'; budget: number }> {
    return this.taskClassifier.classifyTask(task, {
      maxIterations: this.config.maxIterations || 25,
      workingDir: this.config.workingDir,
    });
  }

  /** LLM bridge for SearchSignalTracker — tries LLM, falls back to heuristic */
  private async callSearchSignalLLM(
    artifacts: SearchArtifact[],
  ): Promise<{ signal: 'none' | 'partial' | 'strong'; snippets: string[] }> {
    const llm = useLLM({
      tier: this.chooseSmartTier('searchAssessment', {
        task: this.currentTask,
        artifactCount: artifacts.length,
      }),
    });
    if (llm?.chatWithTools) {
      try {
        const response = await llm.chatWithTools(
          [
            {
              role: 'user',
              content: `Assess whether search artifacts contain actionable evidence for the current task.
Task: ${this.currentTask || ''}
Artifacts:
${artifacts.map((a, i) => `#${i + 1} ${a.tool}\n${a.content}`).join('\n\n')}`,
            },
          ],
          {
            temperature: 0,
            tools: [
              {
                name: 'set_search_signal',
                description: 'Classify quality of search signal and provide concise evidence snippets.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    signal: {
                      type: 'string',
                      enum: ['none', 'partial', 'strong'],
                    },
                    snippets: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                  required: ['signal'],
                },
              },
            ],
          }
        );
        const call = response.toolCalls?.find((tc) => tc.name === 'set_search_signal');
        const input = (call?.input ?? {}) as { signal?: string; snippets?: string[] };
        if (input.signal === 'none' || input.signal === 'partial' || input.signal === 'strong') {
          return {
            signal: input.signal,
            snippets: Array.isArray(input.snippets)
              ? input.snippets.filter((s): s is string => typeof s === 'string').slice(0, 6)
              : [],
          }
        }
      } catch {
        // Fall through to heuristic fallback.
      }
    }
    return assessSearchSignalHeuristic(artifacts);
  }

  /**
   * Execute task with LLM tool calling
   */
  async execute(task: string): Promise<TaskResult> {
    // Check if mode-based execution is requested
    if (this.config.mode && this.config.mode.mode !== 'execute') {
      const { getModeHandler } = await import('../modes/mode-handler');
      const handler = await getModeHandler(this.config.mode);
      return handler.execute(task, this.config, this.toolRegistry);
    }

    // Standard execution
    const startTier = this.config.tier || DEFAULT_EXECUTION_TIER;

    // Load mid-term memory from disk if session has prior runs
    if (this.memPersistDir) {
      this.factSheet = await FactSheet.load(this.memPersistDir, this.factSheetConfig);
      this.archiveMemory = await ArchiveMemory.load({
        ...this.archiveMemoryConfig,
        persistDir: this.memPersistDir,
      });
      this.toolRegistry.getContext().archiveMemory = this.archiveMemory;
    }

    await this.ensureWorkspaceDiscoveryLoaded();
    this.taskIntent = await this.inferTaskIntent(task);
    this.runStartTier = startTier;
    this.runFinalTier = startTier;
    this.state.budget.setCurrentTier(startTier);
    this.runMetricsEmitter.reset();

    if (!this.config.enableEscalation) {
      return this.executeWithTier(task, startTier);
    }

    // Tier escalation enabled
    const tiers: LLMTier[] = ['small', 'medium', 'large'];
    const startTierIndex = Math.max(0, tiers.indexOf(startTier));

    for (let i = startTierIndex; i < tiers.length; i++) {
      const tier = tiers[i]!;
      this.log(`\n🎯 Trying with tier: ${tier}`);

      try {
         
        const result = await this.executeWithTier(task, tier);
        if (result.success) {
          if (tier !== startTier) {
            this.log(`✅ Succeeded after escalation to ${tier} tier`);
          }
          return result;
        }

        if (i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          await this.recordTierEscalation(
            tier,
            nextTier,
            'tier_result_unsuccessful',
            this.completedIterations[this.completedIterations.length - 1] ?? 0
          );
          this.emit({
            type: EVENT_TYPE_STATUS_CHANGE,
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            data: {
              status: 'thinking',
              message: `Tier escalation: ${tier} -> ${nextTier} (previous tier returned partial/failed result)`,
            },
          });
          this.log(
            `⚠️  Failed with ${tier} tier, escalating to ${nextTier}...`
          );
        }
      } catch (error) {
        if (isTierEscalationSignal(error) && i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          await this.recordTierEscalation(tier, nextTier, error.reason, error.iteration);
          this.emit({
            type: EVENT_TYPE_STATUS_CHANGE,
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            data: {
              status: 'thinking',
              message: `Tier escalation: ${tier} -> ${nextTier} (reason: ${error.reason})`,
            },
          });
          this.log(
            `⚡ Escalating from ${tier} to ${nextTier} after ${error.iteration} iterations (${error.reason})`
          );
          continue;
        }
        this.log(`❌ Error with ${tier} tier: ${error}`);
        if (i < tiers.length - 1) {
          const nextTier = tiers[i + 1]!;
          const message = error instanceof Error ? error.message : String(error);
          await this.recordTierEscalation(
            tier,
            nextTier,
            `tier_error:${message.slice(0, 120)}`,
            this.completedIterations[this.completedIterations.length - 1] ?? 0
          );
        }
        if (i === tiers.length - 1) {
          throw error;
        }
      }
    }

    return this.executeWithTier(task, 'large');
  }

  /**
   * Execute with specific tier
   */
  private async executeWithTier(
    task: string,
    tier: LLMTier
  ): Promise<TaskResult> {
    this.runFinalTier = tier;
    this.state.budget.setCurrentTier(tier);    this.logTaskHeader(task, tier);
    this.resetState();
    this.currentTask = task;
    this.startTime = Date.now();

    this.startTimestamp = new Date().toISOString();
    const effectiveMaxIterations = this.computeIterationBudget(task);
    this.state.budget.setIterationBudget(effectiveMaxIterations);    const effectiveTokenBudget = await this.computeTokenBudget(task);
    this.state.budget.setTokenBudget(effectiveTokenBudget);    const tokenBudgetPolicy = this.resolveTokenBudgetPolicy();

    // Emit agent:start event
    this.emit({
      type: 'agent:start',
      timestamp: this.startTimestamp,
      sessionId: this.config.sessionId,
      data: {
        task,
        tier,
        maxIterations: effectiveMaxIterations,
        toolCount: this.toolRegistry.getDefinitions().length,
      },
    });

    // Emit status change
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: 'Starting task execution',
      },
    });

    // Record task start in memory
    if (this.memory) {
      await this.memory.add({
        content: `Task started: ${task}`,
        type: 'task',
        metadata: {
          taskId: `task-${Date.now()}`,
        },
      });
    }

    const systemPrompt = await this.buildSystemPrompt();

    // Phase 4: Cache for lean context building
    this.cachedSystemPrompt = systemPrompt;
    this.cachedTaskMessage = task;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
    ];

    // Load conversation history from previous runs in this session
    // Uses progressive summarization: recent (full), mid-term (summarized), old (ultra-brief)
    // Prefer pre-loaded history from config to avoid race condition with async write queue.
    if (this.config.sessionId && (this.sessionRootDir || this.config.conversationHistory)) {
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
        this.log(`📜 Loaded ${totalTurns} previous turn(s) from session history (${history.recent.length} recent, ${history.midTerm.length} mid-term, ${history.old.length} old)`);

        // Add old turns first (ultra-brief, oldest to newest)
        for (const turn of history.old) {
          if (turn.userTask?.trim()) {
            messages.push({ role: 'user', content: turn.userTask });
          }
          if (turn.agentResponse?.trim()) {
            messages.push({ role: 'assistant', content: turn.agentResponse });
          }
        }

        // Add mid-term turns (summarized)
        for (const turn of history.midTerm) {
          if (turn.userTask?.trim()) {
            messages.push({ role: 'user', content: turn.userTask });
          }
          if (turn.agentResponse?.trim()) {
            messages.push({ role: 'assistant', content: turn.agentResponse });
          }
        }

        // Add recent turns (full detail)
        for (const turn of history.recent) {
          if (turn.userTask?.trim()) {
            messages.push({ role: 'user', content: turn.userTask });
          }
          if (turn.agentResponse?.trim()) {
            messages.push({ role: 'assistant', content: turn.agentResponse });
          }
        }
      }

      if (traceArtifactsContext.trim()) {
        messages.push({
          role: 'system',
          content: traceArtifactsContext,
        });
      }
    }

    // Add current task
    messages.push({
      role: 'user',
      content: task,
    });

    this.transitionPhase('scoping', 'initial scope discovery');
    const suggestedScope = await this.extractScope(task);
    if (suggestedScope) {
      this.injectedUserContext.push(
        `Suggested initial scope from task/context: "${suggestedScope}". Start there first; widen scope only if local evidence is insufficient.`
      );
    }
    this.transitionPhase('planning_lite', 'scope/context prepared');

    const llm = useLLM({ tier });
    if (!llm || !llm.chatWithTools) {
      return this.createFailureResult('LLM or chatWithTools not available', 0);
    }

    // Phase 4: Initialize SmartSummarizer with LLM (small tier for summarization)
    const smallLLM = useLLM({ tier: 'small' });
    if (smallLLM) {
      this.smartSummarizer.setLLM(smallLLM);
    }

    const tools = this.convertToolDefinitions();
    this.transitionPhase('executing', 'tool execution loop started');

    // Trace task start with system prompt and available tools
    if (this.tracer) {
      const taskStartEvent: TaskStartEvent = {
        seq: 0,
        type: 'task:start',
        timestamp: new Date().toISOString(),
        iteration: 0,
        task,
        tier,
        systemPrompt,
        availableTools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
        })),
      };
      this.tracer.trace(taskStartEvent);
    }

    // ── ExecutionLoop ─────────────────────────────────────────────────────
    // Closure state shared between LoopContext callbacks
    let iterationStartTimestamp = new Date().toISOString();
    let lastToolCalls: LLMToolCall[] = [];
    let lastToolResults: LLMMessage[] = [];
    // Early-exit result set by executeTools when sentinel (no-result, skip, reflect) fires
    let _pendingEarlyResult: TaskResult | undefined;

    const loopCtx: LoopContext<TaskResult> = {
      maxIterations: effectiveMaxIterations,

      isAborted: () => this.abortController.signal.aborted,

      checkHardTokenLimit: (_totalTokens) => {
        // Delegate to existing method — it handles synthesis internally when needed.
        // Return undefined here; enforceTokenHardLimitIfNeeded is called inside callLLM.
        return undefined;
      },

      callLLM: async (iterCtx: IterationContext) => {
        iterationStartTimestamp = new Date().toISOString();
        this.logIterationHeader(iterCtx.iteration, iterCtx.maxIterations);

        // Emit iteration:start
        this.emit({
          type: 'iteration:start',
          timestamp: iterationStartTimestamp,
          sessionId: this.config.sessionId,
          data: { iteration: iterCtx.iteration, maxIterations: iterCtx.maxIterations },
        });

        // Hard token limit check (may return early result)
        const hardLimitResult = await this.enforceTokenHardLimitIfNeeded({
          iteration: iterCtx.iteration,
          llm,
          messages,
          tokenBudget: effectiveTokenBudget,
          policy: tokenBudgetPolicy,
          iterationStartTimestamp,
        });
        if (hardLimitResult) {
          // Wrap as a "done" signal: no tool calls, content = summary
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

        const availableTools = this.getCostAwareToolSet(
          tools,
          iterCtx.iteration,
          iterCtx.maxIterations,
          effectiveTokenBudget
        );

        // Trace iteration:detail
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

        // Trace stopping:analysis
        if (this.tracer) {
          const hasToolCalls = !!response.toolCalls && response.toolCalls.length > 0;
          const reachedMax = iterCtx.iteration >= iterCtx.maxIterations;
          this.tracer.trace(createStoppingAnalysisEvent({
            iteration: iterCtx.iteration,
            conditions: {
              maxIterationsReached: reachedMax,
              timeoutReached: false,
              foundTarget: false,
              sufficientContext: hasToolCalls,
              diminishingReturns: false,
              userInterrupt: false,
              error: false,
            },
            reasoning: !hasToolCalls || reachedMax
              ? reachedMax ? 'Reached maximum iterations limit' : 'No tool calls in response, natural stop'
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
        if (iterCtx.isLastIteration && response.toolCalls && response.toolCalls.length > 0) {
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

      extractReportAnswer: (calls: LoopToolCall[]) => {
        const reportCall = calls.find(tc => tc.name === 'report');
        if (!reportCall) {return undefined;}
        return (reportCall.input?.answer as string) || 'No answer provided';
      },

      executeTools: async (calls: LoopToolCall[], iterCtx: IterationContext) => {
        // Reconstruct LLMToolCall[] from LoopToolCall[]
        const llmCalls: LLMToolCall[] = calls.map(c => ({
          id: c.id,
          name: c.name,
          input: c.input,
        }));

        const evidenceScoreBeforeTools = this.getEvidenceProgressScore();
        const toolResults = await this.executeToolCalls(llmCalls, iterCtx.iteration);
        const evidenceScoreAfterTools = this.getEvidenceProgressScore();
        const evidenceDelta = Math.max(0, evidenceScoreAfterTools - evidenceScoreBeforeTools);

        // We need the original LLM response to append to history correctly.
        // Store results so onIterationEnd can use them.
        lastToolCalls = llmCalls;
        lastToolResults = toolResults;

        // Append to conversation history requires the full assistant message.
        // We do a minimal append here: tool results only.
        toolResults.forEach(msg => messages.push(msg));

        const failedToolsThisIteration = this.countFailedToolResults(toolResults);

        await this.updateNoResultTracker(llmCalls, toolResults, iterCtx.iteration);

        if (llmCalls.length > 0) {
          const firstToolName = llmCalls[0]!.name;
          const totalOutputSize = toolResults.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
          this.updateProgressTracker(firstToolName, totalOutputSize, {
            iteration: iterCtx.iteration,
            evidenceDelta,
            failedToolsThisIteration,
            searchSignalHits: this.searchSignalTracker.state.searchSignalHits,
          });
        }

        await this.maybeRunOperationalReflection(
          { trigger: 'post_tools', iteration: iterCtx.iteration, toolCalls: llmCalls, toolResults, failedToolsThisIteration, force: false },
          messages
        );

        // No-result early conclusion
        if (this.shouldConcludeNoResultEarly(iterCtx.iteration)) {
          await this.maybeRunOperationalReflection(
            { trigger: 'before_no_result', iteration: iterCtx.iteration, toolCalls: llmCalls, toolResults, failedToolsThisIteration, force: true },
            messages
          );
          this.transitionPhase('reporting', 'no-result convergence');
          const earlyResult = await this.createSuccessResult(
            { success: true, summary: this.buildNoResultConclusionSummary() },
            iterCtx.iteration
          );
          return [{ toolCallId: '__early_exit__', output: earlyResult.summary ?? '', metadata: { _earlyResult: earlyResult } }];
        }

        // Async summarization
        if (iterCtx.iteration % AGENT_SUMMARIZER.summarizationInterval === 0) {
          const historySnapshot = this.contextFilter.getHistorySnapshot();
          this.smartSummarizer.triggerSummarization(historySnapshot, iterCtx.iteration)
            .catch((err: Error) => { this.log(`⚠️  Background summarization failed: ${err.message}`); });
        }

        // ask_parent handling
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
            const skipResult = await this.createSuccessResult(
              { success: true, summary: `Skipped on parent's guidance: ${parentResponse.answer}` },
              iterCtx.iteration
            );
            return [{ toolCallId: '__skip__', output: skipResult.summary ?? '', metadata: { _earlyResult: skipResult } }];
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
            const reflectResult = await this.createSuccessResult(
              { success: true, summary: meta.reflection.findingsSummary },
              iterCtx.iteration
            );
            return [{ toolCallId: '__reflect_report__', output: reflectResult.summary ?? '', metadata: { _earlyResult: reflectResult } }];
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
            const skipResult = await this.createSuccessResult(
              { success: true, summary: `Skipped on parent's guidance (auto-stuck detection): ${parentResponse.answer}` },
              iterCtx.iteration
            );
            return [{ toolCallId: '__stuck_skip__', output: skipResult.summary ?? '', metadata: { _earlyResult: skipResult } }];
          }
        }

        const loopResults = toolResults.map(msg => ({
          toolCallId: msg.toolCallId ?? '',
          output: msg.content ?? '',
          metadata: msg.metadata,
        }));

        // Detect sentinel early-exit results from executeTools
        const sentinelResult = loopResults.find(r =>
          r.toolCallId === '__early_exit__' ||
          r.toolCallId === '__skip__' ||
          r.toolCallId === '__reflect_report__' ||
          r.toolCallId === '__stuck_skip__'
        );
        if (sentinelResult?.metadata?.['_earlyResult']) {
          _pendingEarlyResult = sentinelResult.metadata['_earlyResult'] as TaskResult;
        }

        return loopResults;
      },

      detectLoop: (calls: LoopToolCall[]) => {
        // If executeTools set a pending early result (sentinel), stop the loop now
        if (_pendingEarlyResult) {
          return '__early_exit__';
        }
        const sigs = calls.map(tc => ({
          name: tc.name,
          arguments: JSON.stringify(tc.input || {}),
        }));
        if (this.toolResultCache.detectLoop(sigs)) {
          this.transitionPhase('reporting', 'loop detected');
          this.log(`\n🔄 Loop detected — same tool calls repeated 3 times. Stopping.\n`);
          return 'Agent stuck in a loop — repeating the same actions. Report what was found so far.';
        }
        return undefined;
      },

      evaluateEscalation: (iterCtx: IterationContext) => {
        return this.evaluateTierEscalationNeed({
          tier,
          iteration: iterCtx.iteration,
          maxIterations: iterCtx.maxIterations,
        });
      },

      extendBudget: (iterCtx: IterationContext) => {
        const extended = this.maybeExtendIterationBudget(iterCtx.iteration, iterCtx.maxIterations);
        if (extended > iterCtx.maxIterations) {
          this.log(`📈 Extending iteration budget ${iterCtx.maxIterations} -> ${extended}`);
          this.state.budget.extendIterationBudget(1);
          this.state.budget.setIterationBudget(extended);
          this.emit({
            type: EVENT_TYPE_STATUS_CHANGE,
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            data: {
              status: 'thinking',
              message: `Progress detected, extending budget ${iterCtx.maxIterations} -> ${extended} (#${this.state.budget.iterationBudgetExtensions})`,
            },
          });
        }
        return extended;
      },

      buildResult: async (answer: string, iterCtx: IterationContext, reasonCode: string) => {
        // Early-exit sentinel from executeTools (no-result, skip, reflect, stuck-skip)
        if (_pendingEarlyResult) {
          return _pendingEarlyResult;
        }
        if (reasonCode === 'abort_signal') {
          return this.createStoppedResult(iterCtx.iteration);
        }
        if (reasonCode === 'loop_detected') {
          return this.createFailureResult(answer, iterCtx.iteration, 'loop_detected');
        }
        if (reasonCode === 'no_tool_calls') {
          // Natural completion — validate and succeed
          const validation = await this.validateTaskCompletion(task, answer, iterCtx.iteration);
          this.transitionPhase('reporting', 'validation completed');
          return this.createSuccessResult(validation, iterCtx.iteration);
        }
        // max_iterations, hard_token_limit, iteration_error, max_iterations_exhausted
        if (reasonCode === 'max_iterations' || reasonCode === 'max_iterations_exhausted' || reasonCode === 'hard_token_limit') {
          this.transitionPhase('reporting', 'max iteration reached');
          return this.createFailureResult(
            `Max iterations (${iterCtx.maxIterations}) reached without completion`,
            iterCtx.maxIterations
          );
        }
        // report_complete
        if (reasonCode === 'report_complete') {
          this.transitionPhase('reporting', 'report tool used');
          const confidence = 0.8; // default confidence for report tool
          return this.createSuccessResult({ success: confidence >= 0.5, summary: answer }, iterCtx.iteration);
        }
        // iteration_error
        this.transitionPhase('reporting', 'error path');
        return this.createFailureResult(answer, iterCtx.iteration, reasonCode);
      },

      onIterationStart: (iterCtx: IterationContext) => {
        // iteration:start is emitted inside callLLM for correct timestamp
        void iterCtx;
      },

      onIterationEnd: (iterCtx: IterationContext, hadToolCalls: boolean) => {
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

      onTokensConsumed: (delta: number) => {
        this.state.budget.addTokens(delta);
      },
    };

    const loop = new ExecutionLoop<TaskResult>(loopCtx);
    const loopResult = await loop.run();

    if (loopResult.outcome === 'escalate') {
      throw new TierEscalationSignal(loopResult.reason ?? 'escalation', 0);
    }

    if (loopResult.outcome === 'complete') {
      return loopResult.result;
    }

    // handoff or other unexpected outcome
    return this.createFailureResult('Unexpected loop outcome', 0);
  }

  /**
   * Log task header
   */
  private logTaskHeader(task: string, tier: LLMTier): void {
    this.log(`\n${'='.repeat(60)}`);
    this.log(`🤖 Agent executing task (tier: ${tier})`);
    this.log(`${'='.repeat(60)}\n`);
    this.log(`📋 Task: ${task}\n`);
  }

  /**
   * Reset agent state — recreate StateManager so all sub-modules start fresh.
   */
  private resetState(tier: LLMTier = DEFAULT_EXECUTION_TIER): void {
    this.state = new StateManager({
      maxIterations: this.config.maxIterations ?? 25,
      initialTier: tier,
    });
    this.trace = [];
    this.toolResultCache.clear();
    this.completedIterations = [];
    this.searchSignalTracker.reset();
    this.lastSignalIteration = 0;
    this.reflectionEngine.reset();
    this.progressTracker.reset();
    this.lastQualityGate = null;
    this.todoSyncCoordinator.reset();
  }

  /**
   * Convert tool definitions to LLM format
   */
  private convertToolDefinitions(): LLMTool[] {
    const toolDefinitions = this.toolRegistry.getDefinitions();
    return toolDefinitions.map(td => ({
      name: td.function.name,
      description: td.function.description,
      inputSchema: td.function.parameters as Record<string, unknown>,
    }));
  }

  /**
   * Log iteration header
   */
  private logIterationHeader(iteration: number, maxIterations: number): void {
    this.log(`\n${'─'.repeat(60)}`);
    this.log(`📍 Iteration ${iteration}/${maxIterations}`);
    this.log(`${'─'.repeat(60)}\n`);
  }

  /**
   * Build lean context for LLM call using ContextFilter
   * Phase 4: Reduces token usage by truncating and using sliding window
   */
  private async buildLeanContext(
    systemPrompt: string,
    taskMessage: string,
    iteration: number
  ): Promise<LLMMessage[]> {
    // Get summaries if available
    const summaryData = this.smartSummarizer.getAllSummaries();
    const summaries = summaryData.map(s =>
      `Iterations ${s.startIteration}-${s.startIteration + 10}:\n${s.summary}`
    );

    // Inject two-tier memory into system prompt
    let enrichedSystemPrompt = systemPrompt;
    const factSheetContent = this.factSheet.render();
    if (factSheetContent) {
      enrichedSystemPrompt += `\n\n# Accumulated Knowledge (Fact Sheet)\n${factSheetContent}`;
    }
    const archiveHint = this.archiveMemory.getSummaryHint();
    if (archiveHint) {
      enrichedSystemPrompt += `\n\n${archiveHint}`;
    }

    // Build lean context with truncation + sliding window
    const systemMsg: LLMMessage = { role: 'system', content: enrichedSystemPrompt };
    const taskMsg: LLMMessage = { role: 'user', content: taskMessage };

    const leanContext = this.contextFilter.buildDefaultContext(
      systemMsg,
      taskMsg,
      iteration,
      summaries
    );

    // Check for injected user context
    const injectedContext = this.consumeInjectedContext();
    if (injectedContext) {
      leanContext.push({
        role: 'user',
        content: `⚠️ **Important User Feedback (received during execution):**\n\n${injectedContext}\n\nPlease take this feedback into account for your next actions.`,
      });
      this.log(`📨 Injected user context into LLM call`);
    }

    return leanContext;
  }

  /**
   * Call LLM with tools and track metrics
   * Phase 4: Uses lean context from ContextFilter
   */
  private async callLLMWithTools(
    llm: ILLM,
    messages: LLMMessage[],
    tools: LLMTool[],
    tier: LLMTier,
    iteration: number,
    systemPrompt?: string,
    taskMessage?: string
  ): Promise<LLMToolCallResponse> {
    const startTime = Date.now();

    // Phase 4: Use lean context if systemPrompt provided (optimization enabled)
    const contextToUse = systemPrompt && taskMessage
      ? await this.buildLeanContext(systemPrompt, taskMessage, iteration)
      : messages;

    const llmStartTimestamp = new Date().toISOString();

    // Trace context snapshot — what exactly the LLM sees
    if (this.tracer) {
      const contextMessages = contextToUse.map((msg, i) => {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const toolCallsArr = (msg as any).toolCalls || [];
        const truncated = content.includes('truncated)');
        const entry: Record<string, unknown> = {
          index: i,
          role: msg.role,
          chars: content.length,
        };
        if (truncated) {entry.truncated = true;}
        if (toolCallsArr.length > 0) {
          entry.toolCalls = toolCallsArr.map((tc: any) => tc.name || tc.function?.name);
        }
        if ((msg as any).toolCallId) {entry.toolCallId = (msg as any).toolCallId;}
        // Preview: first 200 chars for system/user, first 100 for tool results
        const previewLen = msg.role === 'tool' ? 100 : 200;
        if (content.length > 0) {entry.preview = content.slice(0, previewLen);}
        return entry;
      });

      const totalChars = contextToUse.reduce((sum, msg) =>
        sum + (typeof msg.content === 'string' ? msg.content.length : 0), 0);

      // Sliding window info — what was dropped
      const fullHistorySize = this.contextFilter.getHistorySnapshot().length;
      const windowedSize = contextToUse.length - 2; // minus system + task
      const droppedMessages = Math.max(0, fullHistorySize - windowedSize);

      this.tracer.trace({
        type: 'context:snapshot',
        seq: 0,
        timestamp: llmStartTimestamp,
        iteration,
        tier,
        messageCount: contextToUse.length,
        totalChars,
        estimatedTokens: Math.round(totalChars / 4),
        toolCount: tools.length,
        slidingWindow: {
          fullHistorySize,
          windowedSize,
          droppedMessages,
        },
        messages: contextMessages,
      } as any);

      // Emit context:diff — what changed since last iteration
      const firstMsg = contextToUse[0];
      const systemPromptChars = firstMsg && firstMsg.role === 'system'
        ? (typeof firstMsg.content === 'string' ? firstMsg.content.length : 0)
        : 0;

      const currentSnapshot = {
        iteration,
        messageCount: contextToUse.length,
        totalChars,
        systemPromptChars,
        messages: contextMessages.map(m => ({ role: m.role as string, chars: m.chars as number })),
      };

      if (this.previousContextSnapshot) {
        const prev = this.previousContextSnapshot;
        const messagesAdded = currentSnapshot.messageCount - prev.messageCount;
        const charsDelta = currentSnapshot.totalChars - prev.totalChars;
        const tokensDelta = Math.round(charsDelta / 4);

        // Detect system prompt changes
        const systemPromptChanged = currentSnapshot.systemPromptChars !== prev.systemPromptChars;
        const systemPromptCharsDelta = currentSnapshot.systemPromptChars - prev.systemPromptChars;

        // Find new messages (ones that didn't exist in previous snapshot)
        const newMessages = contextMessages.slice(prev.messageCount).map(m => ({
          role: m.role as string,
          chars: m.chars as number,
          preview: (m.preview as string) || '',
          toolCalls: m.toolCalls as string[] | undefined,
        }));

        this.tracer.trace({
          type: 'context:diff',
          seq: 0,
          timestamp: llmStartTimestamp,
          iteration,
          previousIteration: prev.iteration,
          diff: {
            messagesAdded,
            messagesBefore: prev.messageCount,
            messagesAfter: currentSnapshot.messageCount,
            charsBefore: prev.totalChars,
            charsAfter: currentSnapshot.totalChars,
            charsDelta,
            tokensDelta,
            droppedMessages,
            systemPromptChanged,
            systemPromptCharsDelta: systemPromptChanged ? systemPromptCharsDelta : undefined,
            newMessages,
          },
        } as any);
      }

      this.previousContextSnapshot = currentSnapshot;
    }

    // Emit llm:start
    this.emit({
      type: 'llm:start',
      timestamp: llmStartTimestamp,
      sessionId: this.config.sessionId,
      data: {
        tier,
        messageCount: contextToUse.length,
      },
    });

    // Emit status change
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: `Calling LLM (tier: ${tier})`,
      },
    });

    // Phase 4: Use lean context for LLM call (token optimization)
    const response = await llm.chatWithTools!(contextToUse, {
      tools,
      temperature: this.config.temperature,
    });

    const durationMs = Date.now() - startTime;

    // Track tokens
    const tokensUsed = response.usage
      ? (response.usage.promptTokens + response.usage.completionTokens) || 0
      : 0;

    if (response.usage) {
      this.state.budget.addTokens(tokensUsed);
    }

    // Emit llm:end with startedAt
    this.emit({
      type: 'llm:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: llmStartTimestamp,
      data: {
        tokensUsed,
        durationMs,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
        content: response.content || undefined,
      },
    } as AgentEvent);

    // Trace detailed llm:call event
    if (this.tracer) {
      const toolNames = tools.map((t) => t.name);

      this.tracer.trace(
        createLLMCallEvent({
          iteration,
          model: response.model, // ✅ Get actual model from response
          temperature: this.config.temperature,
          maxTokens: 4096, // Default max tokens
          tools: toolNames,
          response,
          startTime,
          endTime: startTime + durationMs,
        })
      );

      // Store last LLM call for error context
      this.lastLLMCall = {
        request: { model: response.model, tools: toolNames, temperature: this.config.temperature },
        response: {
          content: response.content,
          toolCalls: response.toolCalls?.length || 0,
          tokens: tokensUsed,
        },
        durationMs,
      };

      // Trace llm:validation event to debug LLM response quality
      const stopReason = response.toolCalls && response.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const hasContent = !!response.content;
      const hasToolCalls = !!response.toolCalls && response.toolCalls.length > 0;
      const isValid = hasContent || hasToolCalls;

      this.tracer.trace(
        createLLMValidationEvent({
          iteration,
          stopReason,
          isValid,
          hasContent,
          hasToolCalls,
          toolCallsValid: true,
          jsonParseable: true,
          schemaValid: true,
          issues: isValid ? [] : [
            {
              severity: 'warning',
              check: 'output_presence',
              message: 'No content and no tool calls in response',
            }
          ],
        })
      );
    }

    return response;
  }

  /**
   * Execute all tool calls sequentially
   */
  private async executeToolCalls(toolCalls: LLMToolCall[], iteration: number): Promise<LLMMessage[]> {
    const toolResults: LLMMessage[] = [];

    // Emit status change
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'executing',
        message: `Executing ${toolCalls.length} tool(s)`,
      },
    });

    for (const toolCall of toolCalls) {
      this.state.execution.recordToolUse(toolCall.name);
      const input = this.normalizeToolInput(toolCall.name, (toolCall.input as Record<string, unknown>) ?? {});
      this.trackDomainTouch(toolCall.name, input);
      const ledgerStepId = this.state.execution.taskLedger.startStep({
        goal: `Execute ${toolCall.name}`,
        capability: mapToolToCapability(toolCall.name),
        toolName: toolCall.name,
      });

      this.log(
        `🔧 ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}...)`
      );

      if (toolCall.name === 'shell_exec') {
        const command = typeof input.command === 'string' ? input.command : '';
        const resolvedCwd = this.toolInputNormalizer.resolveShellCwd(input, this.config.workingDir || process.cwd());
        this.emit({
          type: EVENT_TYPE_STATUS_CHANGE,
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          data: {
            status: 'executing',
            message: isRiskyShellCommand(command)
              ? `Shell preflight: cwd=${resolvedCwd}. Verify scope before running broad test/build commands.`
              : `Shell preflight: cwd=${resolvedCwd}`,
            toolName: toolCall.name,
          },
        });
      }

      const toolStartTime = Date.now();

      const toolStartTimestamp = new Date().toISOString();

      // Emit tool:start with input and toolCallId for correlation
      this.emit({
        type: 'tool:start',
        timestamp: toolStartTimestamp,
        sessionId: this.config.sessionId,
        toolCallId: toolCall.id, // For correlating start/end/error events
        data: {
          toolName: toolCall.name,
          input,
          metadata: this.buildToolStartMetadata(toolCall.name, input),
        },
      } as AgentEvent);

      // Emit status change for tool execution
      this.emit({
        type: EVENT_TYPE_STATUS_CHANGE,
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        data: {
          status: 'executing',
          message: `Executing ${toolCall.name}...`,
          toolName: toolCall.name,
        },
      });

      try {
        this.assertToolCallIsAllowed(toolCall.name, input);
        const result = await this.toolRegistry.execute(toolCall.name, input);
        if (result.success) {
          
          this.state.execution.taskLedger.completeStep(ledgerStepId, result.output?.slice(0, 500));
        } else {
          this.state.execution.recordToolError();
          this.state.execution.taskLedger.failStep(ledgerStepId, result.error || 'tool returned error');
        }

        // === DISABLED: Cache disabled (Phase 1, Step 1.4) ===
        // this.cacheResult(cacheKey, result);
        // === END DISABLED ===

        const toolDurationMs = Date.now() - toolStartTime;

        this.trackFileOperation(toolCall.name, input, result);
        if (toolCall.name === 'fs_read') {
          const filePath = typeof input.path === 'string' ? input.path : undefined;
          const meta = (result as { metadata?: Record<string, unknown> }).metadata;
          const totalLines = Number(meta?.totalLines);
          if (filePath && Number.isFinite(totalLines) && totalLines > 0) {
            this.state.files.setTotalLines(filePath, Math.floor(totalLines));
          }
        }
        this.logToolResult(result);
        this.trackToolOutcome(toolCall.name, result, toolDurationMs);

        // Trace detailed tool:execution event
        if (this.tracer) {
          this.tracer.trace(
            createToolExecutionEvent({
              iteration,
              toolName: toolCall.name,
              callId: toolCall.id,
              input,
              output: {
                success: result.success,
                result: result.output,
              },
              startTime: toolStartTime,
              endTime: toolStartTime + toolDurationMs,
              metadata: this.buildToolEndMetadata(toolCall.name, input, result),
            })
          );

          // Track last tool call for error context
          this.lastToolCall = {
            name: toolCall.name,
            input,
            output: result.output,
          };
        }

        // Two-tier memory: archive full output + extract heuristic facts
        this.processToolResult(toolCall.name, input, result, iteration);

        // Emit tool:end with output, metadata, and correlation IDs
        this.emit({
          type: 'tool:end',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          toolCallId: toolCall.id, // Correlates with tool:start
          startedAt: toolStartTimestamp, // When tool started (for duration calc in UI)
          data: {
            toolName: toolCall.name,
            success: result.success,
            output: result.output,
            durationMs: toolDurationMs,
            metadata: this.buildToolEndMetadata(toolCall.name, input, result),
          },
        } as AgentEvent);

        toolResults.push(this.createToolResultMessage(toolCall.id, toolCall.name, result, iteration));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const guardRejected = isGuardRejectedToolCallError(errorMsg);
        if (guardRejected) {
          this.state.execution.taskLedger.completeStep(ledgerStepId, `Guard rejected tool call: ${errorMsg.slice(0, 200)}`);
        } else {
          this.state.execution.recordToolError();
          this.state.execution.taskLedger.failStep(ledgerStepId, errorMsg);
        }
        const toolDurationMs = Date.now() - toolStartTime;
        this.log(`  ✗ Tool error: ${errorMsg}`);
        this.trackToolOutcome(toolCall.name, { success: false, error: errorMsg }, toolDurationMs);

        // Trace detailed tool:execution event (failed)
        if (this.tracer) {
          this.tracer.trace(
            createToolExecutionEvent({
              iteration,
              toolName: toolCall.name,
              callId: toolCall.id,
              input,
              output: {
                success: false,
                error: {
                  message: errorMsg,
                  stack: error instanceof Error ? error.stack : undefined,
                },
              },
              startTime: toolStartTime,
              endTime: toolStartTime + toolDurationMs,
            })
          );

          // Track last tool call for error context
          this.lastToolCall = {
            name: toolCall.name,
            input,
            error: errorMsg,
          };
        }

        // Emit tool:error with correlation IDs
        this.emit({
          type: 'tool:error',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          toolCallId: toolCall.id, // Correlates with tool:start
          startedAt: toolStartTimestamp, // When tool started
          data: {
            toolName: toolCall.name,
            error: errorMsg,
            metadata: {
              filePath: input.path as string | undefined,
            },
          },
        } as AgentEvent);

        toolResults.push(this.createToolResultMessage(toolCall.id, toolCall.name, { success: false, error: errorMsg }, iteration));
      }
    }

    return toolResults;
  }

  private normalizeToolInput(
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    return this.toolInputNormalizer.normalizeToolInput(toolName, input, this.buildNormalizerContext());
  }

  private buildNormalizerContext() {
    return {
      workingDir: this.config.workingDir || process.cwd(),
      currentTier: this.state.budget.currentTier,
      fileTotalLinesByPath: this.state.files.totalLinesByPath,
      fileReadAttemptsByPath: this.state.files.getMutableReadAttempts(),
      smallReadWindowByPath: this.state.files.getMutableSmallReadWindow(),
      behaviorPolicy: this.behaviorPolicy,
      currentTask: this.currentTask,
      toolDefinitions: this.toolRegistry.getDefinitions(),
    };
  }

  private assertToolCallIsAllowed(
    toolName: string,
    input: Record<string, unknown>
  ): void {
    this.toolInputNormalizer.assertToolCallIsAllowed(
      toolName,
      input,
      this.buildNormalizerContext(),
      this.taskExplicitlyRequestsSecondaryArtifacts(),
    );
  }

  private taskExplicitlyRequestsSecondaryArtifacts(): boolean {
    const task = (this.currentTask || '').toLowerCase();
    return (
      task.includes('dist')
      || task.includes('build')
      || task.includes('artifact')
      || task.includes('bundle')
      || task.includes('backup')
      || task.includes('map file')
      || task.includes('source map')
    );
  }

  private computeIterationBudget(_task: string): number {
    return this.iterationBudget.computeIterationBudget({
      maxIterations: this.config.maxIterations || 25,
      taskBudget: this.state.budget.taskBudget,
      lastSignalIteration: this.lastSignalIteration,
      progress: { ...this.progressTracker.state },
      tokenBudgetEnabled: !!this.config.tokenBudget?.enabled,
    });
  }

  private async computeTokenBudget(_task: string): Promise<number> {
    const learnedBudget = await this.iterationBudget.computeTokenBudget({
      maxIterations: this.config.maxIterations || 25,
      taskBudget: this.state.budget.taskBudget,
      sessionId: this.config.sessionId,
      sessionRootDir: this.sessionRootDir,
      lastSignalIteration: this.lastSignalIteration,
      progress: { ...this.progressTracker.state },
    });

    const policy = this.resolveTokenBudgetPolicy();
    if (!policy.active || policy.maxTokens <= 0) {
      return learnedBudget;
    }

    if (learnedBudget > 0) {
      return Math.min(learnedBudget, policy.maxTokens);
    }

    return policy.maxTokens;
  }

  private getCostAwareToolSet(
    baseTools: LLMTool[],
    iteration: number,
    maxIterations: number,
    tokenBudget: number
  ): LLMTool[] {
    if (!this.shouldRestrictBroadExploration(iteration, maxIterations, tokenBudget)) {
      return baseTools;
    }

    const blockedTools = new Set(['glob_search', 'grep_search', 'fs_list', 'find_definition', 'code_stats']);
    const restricted = baseTools.filter((tool) => !blockedTools.has(tool.name));

    if (restricted.length === baseTools.length) {
      return baseTools;
    }

    if (this.tracer) {
      this.tracer.trace(
        createToolFilterEvent({
          iteration,
          beforeTools: baseTools.map((t) => t.name),
          afterTools: restricted.map((t) => t.name),
          filtered: baseTools
            .filter((tool) => blockedTools.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              reason: 'custom',
              explanation: 'Cost-aware mode: broad discovery disabled at high token usage after strong evidence signal.',
            })),
        })
      );
    }

    return restricted;
  }

  private shouldRestrictBroadExploration(
    iteration: number,
    maxIterations: number,
    tokenBudget: number
  ): boolean {
    const policy = this.resolveTokenBudgetPolicy();
    if (!policy.restrictBroadExplorationAtSoftLimit) {
      return false;
    }
    if (tokenBudget <= 0 || this.state.budget.totalTokensConsumed < Math.floor(tokenBudget * policy.softLimitRatio)) {
      return false;
    }
    if (iteration < 4 || iteration < Math.floor(maxIterations * 0.4)) {
      return false;
    }
    if (this.isLikelyActionTask(this.currentTask || '')) {
      return false;
    }
    return this.hasStrongEvidenceSignal(iteration);
  }

  private hasStrongEvidenceSignal(iterationsUsed: number): boolean {
    return this.qualityGate.hasStrongEvidenceSignal({
      toolsUsedCount: this.state.execution.toolsUsedCount,
      filesRead: this.state.files.filesRead,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
      touchedDomains: this.state.execution.touchedDomains,
      toolErrorCount: this.state.execution.toolErrorCount,
      iterationsUsed,
    });
  }

  private isLikelyActionTask(task: string): boolean {
    return isLikelyActionTask(task, this.taskIntent);
  }

  private async forceSynthesisFromHistory(input: {
    iteration: number;
    llm: ILLM;
    messages: LLMMessage[];
    reason: string;
    reasonCode: 'max_iterations' | 'no_tool_call' | 'token_budget_hard';
    iterationStartTimestamp: string;
  }): Promise<TaskResult> {
    const { iteration, llm, messages, reason, reasonCode, iterationStartTimestamp } = input;
    if (!llm?.chatWithTools) {
      return this.createFailureResult('LLM unavailable for final synthesis', iteration);
    }
    this.emit({
      type: 'synthesis:forced',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        iteration,
        reason,
        messagesCount: messages.length,
      },
    } as AgentEvent);

    const synthesisPrompt = this.config.forcedSynthesisPrompt || `You are at the final synthesis step. Do not call tools.
Using only already collected evidence from prior tool results, produce the best final answer now.

Include:
1. Concrete file references and paths
2. Exact findings that are confirmed
3. Any uncertainty as explicit "unknown / not yet verified"
4. Clear conclusion for the original task

Do not continue exploration. Finalize with current evidence.`;

    messages.push({
      role: 'user',
      content: synthesisPrompt,
    });

    this.emit({
      type: 'synthesis:start',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        iteration,
        promptLength: synthesisPrompt.length,
      },
    } as AgentEvent);
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'finalizing',
        message: 'Synthesizing final answer from collected evidence. This can take up to ~1-2 minutes.',
      },
    } as AgentEvent);
    this.emit({
      type: 'progress:update',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        phase: 'finalizing',
        progress: 95,
        message: 'Synthesizing final answer...',
      },
    } as AgentEvent);

    const leanContext = await this.buildLeanContext(
      this.cachedSystemPrompt!,
      this.cachedTaskMessage!,
      iteration
    );

    const synthesisStartTime = Date.now();
    const synthesisTimeoutMs = this.resolveSynthesisTimeoutMs();
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - synthesisStartTime) / 1000);
      this.emit({
        type: EVENT_TYPE_STATUS_CHANGE,
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        data: {
          status: 'finalizing',
          message: `Synthesizing final answer... ${elapsedSec}s elapsed`,
        },
      } as AgentEvent);
      this.emit({
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        data: {
          phase: 'finalizing',
          progress: 95,
          message: `Synthesizing final answer... ${elapsedSec}s elapsed`,
        },
      } as AgentEvent);
    }, SYNTHESIS_HEARTBEAT_INTERVAL_MS);

    let synthesisResponse: LLMToolCallResponse;
    try {
      synthesisResponse = await this.withTimeout(
        llm.chatWithTools(leanContext, {
          tools: [],
          toolChoice: 'none',
          temperature: this.config.temperature || 0.1,
        }),
        synthesisTimeoutMs,
        `Final synthesis exceeded timeout (${synthesisTimeoutMs}ms)`,
      );
    } catch (error) {
      clearInterval(heartbeat);
      const fallbackSummary = this.buildSynthesisTimeoutFallback(reason, synthesisTimeoutMs);
      this.emit({
        type: EVENT_TYPE_STATUS_CHANGE,
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        data: {
          status: 'finalizing',
          message: 'Synthesis timed out, returning graceful fallback summary.',
        },
      } as AgentEvent);
      this.emit({
        type: 'synthesis:complete',
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        data: {
          iteration,
          contentLength: fallbackSummary.length,
          hasContent: true,
          tokensUsed: 0,
          previewFirst200: fallbackSummary.substring(0, 200),
        },
      } as AgentEvent);
      this.emit({
        type: 'iteration:end',
        timestamp: new Date().toISOString(),
        sessionId: this.config.sessionId,
        startedAt: iterationStartTimestamp,
        data: {
          iteration,
          hadToolCalls: false,
          toolCallCount: 0,
          cumulativeTokens: this.state.budget.totalTokensConsumed,
        },
      } as AgentEvent);
      this.transitionPhase('reporting', 'forced synthesis timeout fallback');
      return this.createSuccessResult(
        {
          success: true,
          summary: fallbackSummary,
        },
        iteration
      );
    } finally {
      clearInterval(heartbeat);
    }

    const synthesisDurationMs = Date.now() - synthesisStartTime;
    const synthesizedAnswer = synthesisResponse.content || 'Unable to synthesize findings';

    if (this.tracer) {
      const synthesisReason =
        reasonCode === 'token_budget_hard'
          ? 'max_iterations'
          : reasonCode;
      this.tracer.trace(
        createSynthesisForcedEvent({
          iteration,
          reason: synthesisReason,
          lastIteration: iteration,
          lastToolCall: this.lastToolCall?.name,
          synthesisPrompt,
          synthesisResponse: {
            content: synthesizedAnswer,
            tokens: synthesisResponse.usage?.completionTokens || 0,
            durationMs: synthesisDurationMs,
          },
        })
      );
    }

    this.emit({
      type: 'synthesis:complete',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        iteration,
        contentLength: synthesisResponse.content?.length ?? 0,
        hasContent: !!synthesisResponse.content,
        tokensUsed: synthesisResponse.usage?.completionTokens ?? 0,
        previewFirst200: synthesisResponse.content?.substring(0, 200) ?? '',
      },
    } as AgentEvent);

    this.emit({
      type: 'iteration:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: iterationStartTimestamp,
      data: {
        iteration,
        hadToolCalls: false,
        toolCallCount: 0,
        cumulativeTokens: this.state.budget.totalTokensConsumed,
      },
    } as AgentEvent);

    this.transitionPhase('reporting', 'forced synthesis result');
    return this.createSuccessResult({
      success: true,
      summary: synthesizedAnswer,
    }, iteration);
  }

  private resolveSynthesisTimeoutMs(): number {
    const raw = process.env.KB_AGENT_SYNTHESIS_TIMEOUT_MS;
    if (!raw) {
      return DEFAULT_SYNTHESIS_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 15_000) {
      return DEFAULT_SYNTHESIS_TIMEOUT_MS;
    }
    return Math.min(parsed, 300_000);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private buildSynthesisTimeoutFallback(reason: string, timeoutMs: number): string {
    const topFiles = Array.from(this.state.files.filesRead).slice(0, 12);
    const filesBlock = topFiles.length > 0
      ? topFiles.map((file) => `- \`${file}\``).join('\n')
      : '- (no files captured)';
    const ledgerSummary = this.state.execution.taskLedger.getSummary();
    const hints: string[] = [
      `- Completed steps: ${ledgerSummary.completedSteps}`,
      `- Failed steps: ${ledgerSummary.failedSteps}`,
      `- Pending steps: ${ledgerSummary.pendingSteps}`,
    ];
    if (this.lastToolCall?.name) {
      hints.push(`- Last tool call: ${this.lastToolCall.name}`);
    }
    const hintsBlock = hints.join('\n');

    return [
      '# Partial Result (Synthesis Timeout)',
      '',
      `Final synthesis timed out after ${Math.floor(timeoutMs / 1000)}s.`,
      `Reason: ${reason}`,
      '',
      '## What Was Collected',
      filesBlock,
      '',
      '## Recent Completed Steps',
      hintsBlock,
      '',
      '## Recommended Next Action',
      '- Re-run with a narrower scope or higher synthesis timeout (`KB_AGENT_SYNTHESIS_TIMEOUT_MS`).',
      '- Use current evidence to continue from this point.',
    ].join('\n');
  }

  private shouldNudgeConvergence(iteration: number, maxIterations: number, task: string): boolean {
    return this.qualityGate.shouldNudgeConvergence({
      iteration,
      maxIterations,
      task,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
      toolsUsedCount: this.state.execution.toolsUsedCount,
    });
  }

  private evaluateQualityGate(iterationsUsed: number) {
    return this.qualityGate.evaluate({
      toolsUsedCount: this.state.execution.toolsUsedCount,
      filesRead: this.state.files.filesRead,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
      toolErrorCount: this.state.execution.toolErrorCount,
      touchedDomains: this.state.execution.touchedDomains,
      searchSignalHits: this.searchSignalTracker.state.searchSignalHits,
      taskLedger: this.state.execution.taskLedger,
      currentTask: this.currentTask,
      iterationsUsed,
    });
  }

  private buildNeedsClarificationSummary(
    originalSummary: string,
    gate: { reasons: string[]; nextChecks?: string[] }
  ): string {
    return this.qualityGate.buildNeedsClarificationSummary(originalSummary, gate);
  }

  private transitionPhase(
    next: 'scoping' | 'planning_lite' | 'executing' | 'converging' | 'verifying' | 'reporting',
    reason?: string
  ): void {
    try {
      this.state.execution.stateMachine.transition(next, reason);
      this.todoSyncCoordinator.syncWithPhase(next, this.config.sessionId);
    } catch {
      // Phase transitions are observability metadata and must never break execution.
    }
  }

  /** Bridge for TodoSyncCoordinator — keeps ledger/counter bookkeeping in agent. */
  private async executeTodoTool(
    toolName: 'todo_create' | 'todo_update' | 'todo_get',
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string; errorDetails?: { code?: string } }> {
    const ledgerStepId = this.state.execution.taskLedger.startStep({
      goal: `Todo sync: ${toolName}`,
      capability: mapToolToCapability(toolName),
      toolName,
    });
    this.state.execution.recordToolUse(toolName);
    try {
      const result = await this.toolRegistry.execute(toolName, input);
      if (result.success) {
        
        this.state.execution.taskLedger.completeStep(ledgerStepId, result.output?.slice(0, 300));
      } else {
        this.state.execution.recordToolError();
        this.state.execution.taskLedger.failStep(ledgerStepId, result.error || 'todo tool returned error');
      }
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        errorDetails: result.errorDetails,
      };
    } catch (err) {
      this.state.execution.recordToolError();
      this.state.execution.taskLedger.failStep(ledgerStepId, err instanceof Error ? err.message : String(err));
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private trackDomainTouch(toolName: string, input: Record<string, unknown>): void {
    const baseDir = this.sessionRootDir || this.config.workingDir || process.cwd();
    this.progressTracker.trackDomainTouch(toolName, input, this.state.execution.getMutableTouchedDomains(), baseDir);
  }

  /**
   * Build metadata for tool:start event
   */
  private buildToolStartMetadata(
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    // File operations
    if (toolName === 'fs_read' || toolName === 'fs_edit' || toolName === 'fs_write') {
      return {
        filePath: input.path as string,
        uiHint: toolName === 'fs_edit' ? 'diff' : 'code',
      };
    }

    // Search operations
    if (toolName === 'grep_search' || toolName === 'glob_search') {
      return {
        query: input.pattern as string || input.query as string,
        uiHint: 'table',
      };
    }

    // Shell
    if (toolName === 'shell_exec') {
      const resolvedCwd = this.toolInputNormalizer.resolveShellCwd(input, this.config.workingDir || process.cwd());
      return {
        command: input.command as string,
        cwd: resolvedCwd,
        uiHint: 'code',
      };
    }

    // Memory
    if (toolName.startsWith('memory_')) {
      return {
        memoryType: toolName.replace('memory_', ''),
        memoryScope: toolName === 'memory_preference' || toolName === 'memory_constraint' ? 'shared' : 'session',
      };
    }

    return undefined;
  }

  /**
   * Build metadata for tool:end event with result data
   */
  private buildToolEndMetadata(
    toolName: string,
    input: Record<string, unknown>,
    result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }
  ): Record<string, unknown> | undefined {
    // Start with tool-specific metadata
    let toolMetadata: Record<string, unknown> | undefined;

    // File read - include content
    if (toolName === 'fs_read' && result.success) {
      toolMetadata = {
        filePath: input.path as string,
        fileContent: result.output,
        uiHint: 'code',
      };
    }

    // File edit - include diff info
    else if (toolName === 'fs_edit' && result.success) {
      toolMetadata = {
        filePath: input.path as string,
        oldContent: input.oldText as string,
        newContent: input.newText as string,
        summary: result.output,
        uiHint: 'diff',
      };
    }

    // File write
    else if (toolName === 'fs_write' && result.success) {
      toolMetadata = {
        filePath: input.path as string,
        newContent: input.content as string,
        uiHint: 'code',
      };
    }

    // Search results
    else if ((toolName === 'grep_search' || toolName === 'glob_search') && result.success) {
      toolMetadata = {
        query: input.pattern as string || input.query as string,
        summary: result.output?.slice(0, 500),
        uiHint: 'table',
      };
    }

    // Shell execution
    else if (toolName === 'shell_exec') {
      const resolvedCwd = this.toolInputNormalizer.resolveShellCwd(input, this.config.workingDir || process.cwd());
      toolMetadata = {
        command: input.command as string,
        cwd: resolvedCwd,
        exitCode: result.success ? 0 : 1,
        stdout: result.success ? result.output : undefined,
        stderr: result.success ? undefined : result.error,
        uiHint: 'code',
      };
    }

    // Merge tool-specific metadata with result.metadata (result.metadata takes precedence)
    if (result.metadata) {
      return toolMetadata ? { ...toolMetadata, ...result.metadata } : result.metadata;
    }

    return toolMetadata;
  }

  /**
   * Log tool execution result
   */
  private logToolResult(result: ToolResult): void {
    this.log(
      result.success
        ? `  ✓ ${result.output?.slice(0, 200) || 'Success'}`
        : `  ✗ ${result.error}`
    );
  }

  // trackToolOutcome and extractToolErrorCode delegated to RunMetricsEmitter (below)

  /**
   * Create tool result message for LLM
   * Truncates long outputs to prevent token overflow
   *
   * Uses proper OpenAI tool response format:
   * - role: 'tool' (not 'user')
   * - toolCallId: matches the id from the tool_call
   */
  private createToolResultMessage(toolCallId: string, _toolName: string, result: ToolResult, iteration?: number): LLMMessage {
    let output = result.success
      ? result.output || 'Success'
      : `Error${result.errorDetails?.code ? ` [${result.errorDetails.code}]` : ''}: ${result.error}`;

    const originalLength = output.length;
    const wasTruncated = originalLength > AGENT_CONTEXT.maxToolOutputChars;

    // Truncate if too long
    if (wasTruncated) {
      output = output.slice(0, AGENT_CONTEXT.maxToolOutputChars) + `\n\n[...output truncated, showing first ${AGENT_CONTEXT.maxToolOutputChars} chars...]`;

      // Trace context:trim event to debug context window management
      if (this.tracer && iteration !== undefined) {
        this.tracer.trace(
          createContextTrimEvent({
            iteration,
            trigger: 'max_tokens',
            messageCountBefore: 0,
            messageCountAfter: 0,
            tokensBefore: Math.ceil(originalLength / 4),
            tokensAfter: Math.ceil(output.length / 4),
            messagesRemoved: 0,
            tokensRemoved: Math.ceil((originalLength - output.length) / 4),
            contentPreview: output.slice(0, 200),
            strategy: 'sliding_window',
          })
        );
      }
    }

    return {
      role: 'tool',
      content: output,
      toolCallId,
      metadata: result.metadata, // Pass through metadata from tool executor (e.g., reflection results)
    };
  }

  /**
   * Append tool calls and results to message history
   * Phase 4: Update to use ContextFilter and add iteration metadata
   */
  private async appendToolMessagesToHistory(
    messages: LLMMessage[],
    response: LLMToolCallResponse,
    toolResults: LLMMessage[],
    iteration: number
  ): Promise<void> {
    // For tool-call assistant messages, keep only public rationale text (if any).
    // Avoid technical placeholders that can leak into chat history/UI.
    const content = response.content?.trim() || '';

    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content,
      toolCalls: response.toolCalls,
      iteration, // Phase 4: Add iteration metadata
    } as LLMMessage;

    // Add iteration metadata to tool results
    const toolResultsWithIteration = toolResults.map(msg => ({
      ...msg,
      iteration,
    }));

    // Append to full history (preserved for tracing)
    await this.contextFilter.appendToHistory([assistantMessage, ...toolResultsWithIteration]);

    // Also push to messages array (backward compatibility)
    messages.push(assistantMessage);
    messages.push(...toolResultsWithIteration);
  }

  /**
   * Create success result
   */
  private async createSuccessResult(
    validation: { success: boolean; summary: string },
    iteration: number
  ): Promise<TaskResult> {
    try {
      this.state.execution.stateMachine.transition('completed', 'success result finalized');
    } catch {
      // No-op: telemetry state should not break completion path.
    }
    const durationMs = Date.now() - this.startTime;
    const qualityGate = this.evaluateQualityGate(iteration);
    this.lastQualityGate = qualityGate;
    const finalSummary = qualityGate.status === 'partial'
      ? this.buildNeedsClarificationSummary(validation.summary, qualityGate)
      : validation.summary;
    const finalSuccess = validation.success && qualityGate.score >= 0.35;

    // Record in memory
    if (this.memory && this.currentTask) {
      await this.memory.add({
        content: `Task completed: ${this.currentTask}\nResult: ${finalSummary}`,
        type: 'result',
        metadata: {
          taskId: `task-${Date.now()}`,
          importance: 0.8,
        },
      });

      // Save full answer to memory (NEVER summarized, always available for follow-ups)
      if (typeof (this.memory as any).saveLastAnswer === 'function') {
        try {
          await (this.memory as any).saveLastAnswer(
            finalSummary,
            this.currentTask,
            {
              confidence: finalSuccess ? 0.8 : 0.3,
              filesCreated: Array.from(this.state.files.filesCreated),
              filesModified: Array.from(this.state.files.filesModified),
            }
          );
        } catch {
          // Don't fail task if memory save fails
        }
      }
    }

    // Emit agent:end with startedAt for duration calculation in UI
    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp, // When agent started
      data: {
        success: finalSuccess,
        summary: finalSummary,
        iterations: iteration,
        tokensUsed: this.state.budget.totalTokensConsumed,
        durationMs,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
      },
    } as AgentEvent);

    // Emit status change
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'done',
        message: finalSummary,
      },
    });

    // Trace task end
    if (this.tracer) {
      const taskEndEvent: TaskEndEvent = {
        seq: 0,
        type: 'task:end',
        timestamp: new Date().toISOString(),
        iteration,
        success: finalSuccess,
        summary: finalSummary,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
        filesRead: Array.from(this.state.files.filesRead),
        totalIterations: iteration,
        totalTokens: this.state.budget.totalTokensConsumed,
      };
      this.tracer.trace(taskEndEvent);
    }

    await this.todoSyncCoordinator.finalize(true, finalSummary, this.config.sessionId);
    await this.emitRunKpis(finalSuccess, finalSummary, iteration, durationMs);

    // Persist mid-term memory (non-critical)
    if (this.memPersistDir) {
      try { await this.factSheet.persist(this.memPersistDir); } catch { /* ignore */ }
    }
    try { await this.archiveMemory.persist(); } catch { /* ignore */ }

    return {
      success: finalSuccess,
      summary: finalSummary,
      filesCreated: Array.from(this.state.files.filesCreated),
      filesModified: Array.from(this.state.files.filesModified),
      filesRead: Array.from(this.state.files.filesRead),
      iterations: iteration,
      tokensUsed: this.state.budget.totalTokensConsumed,
      trace: this.trace,
    };
  }

  /**
   * Create failure result
   */
  private async createFailureResult(
    summary: string,
    iteration: number,
    error?: string
  ): Promise<TaskResult> {
    try {
      this.state.execution.stateMachine.transition('failed', 'failure result finalized');
    } catch {
      // No-op: telemetry state should not break failure path.
    }
    const durationMs = Date.now() - this.startTime;
    this.lastQualityGate = {
      status: 'partial',
      score: 0,
      reasons: [error || summary],
    };

    // Record in memory
    if (this.memory && this.currentTask) {
      await this.memory.add({
        content: `Task failed: ${this.currentTask}\nError: ${error || summary}`,
        type: 'result',
        metadata: {
          taskId: `task-${Date.now()}`,
          importance: 0.9,
        },
      });
    }

    // Emit agent:end (failure) with startedAt for duration calculation in UI
    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp, // When agent started
      data: {
        success: false,
        summary,
        iterations: iteration,
        tokensUsed: this.state.budget.totalTokensConsumed,
        durationMs,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
      },
    } as AgentEvent);

    // Emit status change
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'error',
        message: error || summary,
      },
    });

    // Trace task end
    if (this.tracer) {
      const taskEndEvent: TaskEndEvent = {
        seq: 0,
        type: 'task:end',
        timestamp: new Date().toISOString(),
        iteration,
        success: false,
        summary,
        error,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
        filesRead: Array.from(this.state.files.filesRead),
        totalIterations: iteration,
        totalTokens: this.state.budget.totalTokensConsumed,
      };
      this.tracer.trace(taskEndEvent);
    }

    await this.todoSyncCoordinator.finalize(false, error || summary, this.config.sessionId);
    await this.emitRunKpis(false, summary, iteration, durationMs, error || summary);

    // Persist mid-term memory (non-critical)
    if (this.memPersistDir) {
      try { await this.factSheet.persist(this.memPersistDir); } catch { /* ignore */ }
    }
    try { await this.archiveMemory.persist(); } catch { /* ignore */ }

    return {
      success: false,
      summary,
      filesCreated: Array.from(this.state.files.filesCreated),
      filesModified: Array.from(this.state.files.filesModified),
      filesRead: Array.from(this.state.files.filesRead),
      iterations: iteration,
      tokensUsed: this.state.budget.totalTokensConsumed,
      error: error || summary,
      trace: this.trace,
    };
  }

  /**
   * Create result when agent is stopped by user via requestStop().
   * Waits for the current tool call to finish (never interrupts mid-flight),
   * then saves partial trace and emits agent:end with stopped=true.
   */
  private async createStoppedResult(iteration: number): Promise<TaskResult> {
    try {
      this.state.execution.stateMachine.transition('failed', 'stopped by user');
    } catch {
      // ignore state machine errors
    }
    const durationMs = Date.now() - this.startTime;
    const summary = `Stopped by user after ${iteration - 1} iteration(s)`;

    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp,
      data: {
        success: false,
        stopped: true,
        summary,
        iterations: iteration - 1,
        tokensUsed: this.state.budget.totalTokensConsumed,
        durationMs,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
      },
    } as AgentEvent);

    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: { status: 'done', message: summary },
    });

    if (this.tracer) {
      const taskEndEvent: TaskEndEvent = {
        seq: 0,
        type: 'task:end',
        timestamp: new Date().toISOString(),
        iteration,
        success: false,
        stopped: true,
        summary,
        filesCreated: Array.from(this.state.files.filesCreated),
        filesModified: Array.from(this.state.files.filesModified),
        filesRead: Array.from(this.state.files.filesRead),
        totalIterations: iteration - 1,
        totalTokens: this.state.budget.totalTokensConsumed,
      };
      this.tracer.trace(taskEndEvent);
    }

    await this.todoSyncCoordinator.finalize(false, summary, this.config.sessionId);
    await this.emitRunKpis(false, summary, iteration - 1, durationMs, summary);

    // Persist mid-term memory (non-critical)
    if (this.memPersistDir) {
      try { await this.factSheet.persist(this.memPersistDir); } catch { /* ignore */ }
    }
    try { await this.archiveMemory.persist(); } catch { /* ignore */ }

    return {
      success: false,
      summary,
      filesCreated: Array.from(this.state.files.filesCreated),
      filesModified: Array.from(this.state.files.filesModified),
      filesRead: Array.from(this.state.files.filesRead),
      iterations: iteration - 1,
      tokensUsed: this.state.budget.totalTokensConsumed,
      error: summary,
      trace: this.trace,
    };
  }

  private makeEmitContext(): EmitContext {
    const sessionId = this.config.sessionId;
    return {
      analytics: useAnalytics() ?? null,
      sessionId,
      persister: (sessionId && this.sessionRootDir) ? new SessionManager(this.sessionRootDir) : undefined,
      baselineKey: getKpiBaselineKey(this.sessionRootDir, this.config.workingDir || ''),
      log: (msg: string) => this.log(msg),
    };
  }

  private async emitRunKpis(
    success: boolean,
    summary: string,
    iterationsUsed: number,
    durationMs: number,
    errorMessage?: string
  ): Promise<void> {
    const toolCallsTotal = Array.from(this.state.execution.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    const todoToolCalls = (this.state.execution.toolsUsedCount.get('todo_create') ?? 0)
      + (this.state.execution.toolsUsedCount.get('todo_update') ?? 0)
      + (this.state.execution.toolsUsedCount.get('todo_get') ?? 0);
    const iterationBudget = this.state.budget.iterationBudget || this.config.maxIterations || iterationsUsed;
    const phaseTransitions = this.state.execution.stateMachine.getTransitions();

    await this.runMetricsEmitter.emitRunKpis({
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task: this.currentTask || '',
      success,
      error: errorMessage,
      summaryPreview: summary.slice(0, 300),
      iterationsUsed,
      iterationBudget,
      tokenBudget: this.state.budget.tokenBudget > 0 ? this.state.budget.tokenBudget : undefined,
      tokenUtilization: this.state.budget.tokenBudget > 0 ? this.state.budget.totalTokensConsumed / this.state.budget.tokenBudget : undefined,
      startTier: this.runStartTier,
      finalTier: this.runFinalTier,
      durationMs,
      tokensUsed: this.state.budget.totalTokensConsumed,
      toolCallsTotal,
      toolSuccessCount: this.state.execution.totalToolCalls - this.state.execution.toolErrorCount,
      toolErrorCount: this.state.execution.toolErrorCount,
      todoToolCalls,
      filesReadCount: this.state.files.filesRead.size,
      filesModifiedCount: this.state.files.filesModified.size,
      filesCreatedCount: this.state.files.filesCreated.size,
      driftDomainCount: this.state.execution.touchedDomains.size,
      driftDomains: Array.from(this.state.execution.touchedDomains),
      executionPhase: this.state.execution.stateMachine.getCurrent(),
      phaseDurationsMs: this.state.execution.stateMachine.getPhaseDurationsMs(),
      phaseTransitionCount: phaseTransitions.length,
      phaseTransitions: phaseTransitions.slice(-20),
      ledger: this.state.execution.taskLedger.getSummary(),
      qualityGate: this.lastQualityGate,
    }, this.makeEmitContext());
  }

  private async recordTierEscalation(
    from: LLMTier,
    to: LLMTier,
    reason: string,
    iteration: number
  ): Promise<void> {
    await this.runMetricsEmitter.recordTierEscalation(from, to, reason, iteration, {
      analytics: useAnalytics() ?? null,
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task: this.currentTask || '',
      tierEscalatedEvent: AGENT_ANALYTICS_EVENTS.TIER_ESCALATED,
      log: (msg: string) => this.log(msg),
    });
  }

  private trackToolOutcome(toolName: string, result: ToolResult, durationMs: number): void {
    const errorCode = result.success ? null : extractToolErrorCode(result);
    this.runMetricsEmitter.trackToolOutcome(
      {
        toolName,
        success: result.success,
        durationMs,
        errorCode: errorCode ?? undefined,
        retryable: result.errorDetails?.retryable ?? (result.metadata?.retryable as boolean | undefined) ?? undefined,
      },
      {
        analytics: useAnalytics() ?? null,
        toolCalledEvent: AGENT_ANALYTICS_EVENTS.TOOL_CALLED,
        log: (msg: string) => this.log(msg),
      },
    );
  }

  /**
   * Process tool result for two-tier memory: archive full output + extract heuristic facts.
   * Called after every successful tool execution, BEFORE output truncation.
   */
  private processToolResult(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    iteration: number
  ): void {
    try {
      const fullOutput = result.output || '';

      // Determine file path for indexing (if applicable)
      const filePath = toolName === 'fs_read'
        ? (input.path as string | undefined)
        : undefined;

      // 1. Archive full output (Tier 2: Cold Storage)
      const { entry: archiveEntry, evicted } = this.archiveMemory.store({
        iteration,
        toolName,
        toolInput: input,
        fullOutput,
        filePath,
      });

      // 2. Extract heuristic facts (no LLM, instant)
      const heuristicFacts = extractHeuristicFacts(
        toolName,
        input,
        fullOutput,
        result.success !== false
      );

      const minConfidence = this.config.twoTierMemory?.autoFactMinConfidence
        ?? AGENT_MEMORY.autoFactMinConfidence;

      for (const hFact of heuristicFacts) {
        if (hFact.confidence < minConfidence) {continue;}

        const { entry: factEntry, merged } = this.factSheet.addFact({
          category: hFact.category,
          fact: hFact.fact,
          confidence: hFact.confidence,
          source: hFact.source,
          iteration,
        });

        // Trace fact addition
        if (this.tracer) {
          this.tracer.trace(createFactAddedEvent({
            iteration,
            fact: {
              id: factEntry.id,
              category: factEntry.category,
              fact: factEntry.fact,
              confidence: factEntry.confidence,
              source: factEntry.source,
              merged,
            },
            factSheetStats: this.factSheet.getStats(),
          }));
        }
      }

      // 3. Trace archive store
      if (this.tracer) {
        this.tracer.trace(createArchiveStoreEvent({
          iteration,
          entry: {
            id: archiveEntry.id,
            toolName: archiveEntry.toolName,
            filePath: archiveEntry.filePath,
            outputLength: archiveEntry.outputLength,
            estimatedTokens: archiveEntry.estimatedTokens,
            keyFactsExtracted: heuristicFacts.length,
          },
          archiveStats: {
            ...this.archiveMemory.getStats(),
            evicted,
          },
        }));
      }
    } catch (err) {
      // Two-tier memory errors must not break agent execution
      this.log(`[TwoTierMemory] processToolResult error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Track file operations
   */
  private trackFileOperation(toolName: string, input: Record<string, unknown>, _result?: unknown): void {
    this.progressTracker.trackFileOperation(toolName, input, {
      filesRead: this.state.files.getMutableFilesRead(),
      filesModified: this.state.files.getMutableFilesModified(),
      filesCreated: this.state.files.getMutableFilesCreated(),
    });
  }

  private updateProgressTracker(
    toolName: string,
    outputSize: number,
    input: {
      iteration: number;
      evidenceDelta: number;
      failedToolsThisIteration: number;
      searchSignalHits: number;
    }
  ): void {
    this.progressTracker.updateProgress({
      toolName,
      outputSize,
      ...input,
    });
  }

  private getEvidenceProgressScore(): number {
    return this.progressTracker.getEvidenceProgressScore({
      filesRead: this.state.files.filesRead,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
      searchSignalHits: this.searchSignalTracker.state.searchSignalHits,
      recentSearchEvidenceCount: this.searchSignalTracker.state.recentSearchEvidence.length,
    });
  }

  private countFailedToolResults(toolResults: LLMMessage[]): number {
    return countFailedToolResults(toolResults);
  }

  private async maybeRunOperationalReflection(
    input: {
      trigger: 'post_tools' | 'before_escalation' | 'before_no_result';
      iteration: number;
      toolCalls: LLMToolCall[];
      toolResults: LLMMessage[];
      failedToolsThisIteration: number;
      force: boolean;
      escalationReason?: string;
    },
    messages: LLMMessage[]
  ): Promise<void> {
    const result = await this.reflectionEngine.maybeRunReflection({
      trigger: input.trigger,
      iteration: input.iteration,
      toolCalls: input.toolCalls.map((tc) => ({ id: tc.id, name: tc.name })),
      toolResults: input.toolResults.map((tr) => ({ toolCallId: tr.toolCallId, content: tr.content })),
      failedToolsThisIteration: input.failedToolsThisIteration,
      force: input.force,
      escalationReason: input.escalationReason,
      lastToolCalls: this.progressTracker.state.lastToolCalls,
      iterationsSinceProgress: this.progressTracker.state.iterationsSinceProgress,
      stuckThreshold: this.progressTracker.state.stuckThreshold,
      task: this.currentTask || '',
    });

    if (!result) {
      return;
    }

    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: `Reflection checkpoint: ${result.hypothesis} (conf ${result.confidence.toFixed(2)})`,
      },
    });

    messages.push({
      role: 'assistant',
      content: result.summaryMessage,
    });
  }

  /**
   * LLM bridge for ReflectionEngine — keeps LLM call in agent.ts
   */
  private async callReflectionLLM(input: {
    trigger: string;
    iteration: number;
    task: string;
    toolRows: string;
    failedToolsThisIteration: number;
    escalationReason?: string;
  }): Promise<{
    hypothesis: string;
    confidence: number;
    evidenceFor: string;
    evidenceAgainst: string;
    nextBestCheck: string;
    whyThisCheck: string;
  } | null> {
    const llm = useLLM({
      tier: this.chooseSmartTier('taskValidation', {
        task: this.currentTask,
        evidenceDensity: input.iteration > 0
          ? (this.state.files.filesRead.size + this.state.files.filesModified.size + this.state.files.filesCreated.size) / input.iteration
          : 0,
        iterationsUsed: input.iteration,
        isInformationalTask: this.taskIntent !== 'action',
      }),
    });
    if (!llm?.chatWithTools) {
      return null;
    }

    const prompt = `Create a short operational reflection checkpoint for an autonomous agent.
Task: ${input.task}
Trigger: ${input.trigger}
Iteration: ${input.iteration}
Failed tools this iteration: ${input.failedToolsThisIteration}
Escalation reason candidate: ${input.escalationReason || 'n/a'}
Recent tool outcomes:
${input.toolRows || '(none)'}`;

    try {
      const response = await llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        {
          temperature: 0,
          tools: [
            {
              name: 'set_reflection',
              description: 'Set concise reflection state and next best check.',
              inputSchema: {
                type: 'object',
                properties: {
                  hypothesis: { type: 'string' },
                  confidence: { type: 'number' },
                  evidenceFor: { type: 'string' },
                  evidenceAgainst: { type: 'string' },
                  nextBestCheck: { type: 'string' },
                  whyThisCheck: { type: 'string' },
                },
                required: ['hypothesis', 'confidence', 'evidenceFor', 'evidenceAgainst', 'nextBestCheck', 'whyThisCheck'],
              },
            },
          ],
        }
      );
      const call = response.toolCalls?.find((tc) => tc.name === 'set_reflection');
      const payload = (call?.input ?? {}) as {
        hypothesis?: string;
        confidence?: number;
        evidenceFor?: string;
        evidenceAgainst?: string;
        nextBestCheck?: string;
        whyThisCheck?: string;
      };
      if (
        typeof payload.hypothesis === 'string'
        && typeof payload.confidence === 'number'
        && typeof payload.evidenceFor === 'string'
        && typeof payload.evidenceAgainst === 'string'
        && typeof payload.nextBestCheck === 'string'
        && typeof payload.whyThisCheck === 'string'
      ) {
        return {
          hypothesis: payload.hypothesis.slice(0, 180),
          confidence: Math.max(0, Math.min(1, payload.confidence)),
          evidenceFor: payload.evidenceFor.slice(0, 220),
          evidenceAgainst: payload.evidenceAgainst.slice(0, 220),
          nextBestCheck: payload.nextBestCheck.slice(0, 220),
          whyThisCheck: payload.whyThisCheck.slice(0, 220),
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  private async updateNoResultTracker(
    toolCalls: LLMToolCall[],
    toolResults: LLMMessage[],
    iteration: number
  ): Promise<void> {
    await this.searchSignalTracker.updateNoResultTracker(toolCalls, toolResults, iteration);
    this.lastSignalIteration = this.searchSignalTracker.state.lastSignalIteration;
  }

  private shouldConcludeNoResultEarly(iteration: number): boolean {
    return this.searchSignalTracker.shouldConcludeNoResultEarly(
      iteration,
      {
        task: this.currentTask || '',
        taskIntent: this.taskIntent,
        behaviorPolicy: this.behaviorPolicy,
        currentTier: this.state.budget.currentTier,
        filesRead: this.state.files.filesRead,
        filesModified: this.state.files.filesModified,
        filesCreated: this.state.files.filesCreated,
      },
      this.isLikelyActionTask(this.currentTask || ''),
    );
  }

  private isLikelyDiscoveryTask(task: string): boolean {
    return isLikelyDiscoveryTask(task, this.taskIntent);
  }

  private maybeExtendIterationBudget(currentIteration: number, currentBudget: number): number {
    const policy = this.resolveTokenBudgetPolicy();
    if (!policy.allowIterationBudgetExtension) {
      return currentBudget;
    }
    return this.iterationBudget.maybeExtend(currentIteration, currentBudget, {
      maxIterations: this.config.maxIterations || 25,
      taskBudget: this.state.budget.taskBudget,
      lastSignalIteration: this.lastSignalIteration,
      progress: { ...this.progressTracker.state },
      tokenBudgetEnabled: !!this.config.tokenBudget?.enabled,
    });
  }

  private buildNoResultConclusionSummary(): string {
    return this.searchSignalTracker.buildNoResultConclusionSummary(this.state.execution.toolsUsedCount);
  }

  private resolveTokenBudgetPolicy(): ResolvedTokenBudgetPolicy {
    const defaults = DEFAULT_AGENT_TOKEN_BUDGET_CONFIG;
    const configured = this.config.tokenBudget;
    if (configured?.enabled === false) {
      return {
        active: false,
        maxTokens: 0,
        softLimitRatio: defaults.softLimitRatio,
        hardLimitRatio: defaults.hardLimitRatio,
        hardStop: false,
        forceSynthesisOnHardLimit: defaults.forceSynthesisOnHardLimit,
        restrictBroadExplorationAtSoftLimit: false,
        allowIterationBudgetExtension: true,
      };
    }
    const active = !!configured;

    const clampRatio = (value: number | undefined, fallback: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
      }
      return Math.max(0.1, Math.min(1.0, value));
    };

    const softLimitRatio = clampRatio(configured?.softLimitRatio, defaults.softLimitRatio);
    const hardLimitRatio = Math.max(
      softLimitRatio,
      clampRatio(configured?.hardLimitRatio, defaults.hardLimitRatio)
    );
    const maxTokens =
      typeof configured?.maxTokens === 'number' && Number.isFinite(configured.maxTokens) && configured.maxTokens > 0
        ? Math.floor(configured.maxTokens)
        : 0;

    return {
      active,
      maxTokens,
      softLimitRatio,
      hardLimitRatio,
      hardStop: configured?.hardStop ?? defaults.hardStop,
      forceSynthesisOnHardLimit:
        configured?.forceSynthesisOnHardLimit ?? defaults.forceSynthesisOnHardLimit,
      restrictBroadExplorationAtSoftLimit:
        configured?.restrictBroadExplorationAtSoftLimit ?? defaults.restrictBroadExplorationAtSoftLimit,
      allowIterationBudgetExtension:
        configured?.allowIterationBudgetExtension ?? defaults.allowIterationBudgetExtension,
    };
  }

  private async enforceTokenHardLimitIfNeeded(input: {
    iteration: number;
    llm: ILLM;
    messages: LLMMessage[];
    tokenBudget: number;
    policy: ResolvedTokenBudgetPolicy;
    iterationStartTimestamp: string;
  }): Promise<TaskResult | null> {
    const { iteration, llm, messages, tokenBudget, policy, iterationStartTimestamp } = input;
    if (!policy.active || !policy.hardStop || tokenBudget <= 0) {
      return null;
    }

    const hardLimit = Math.floor(tokenBudget * policy.hardLimitRatio);
    if (hardLimit <= 0 || this.state.budget.totalTokensConsumed < hardLimit) {
      return null;
    }

    this.transitionPhase('verifying', 'token budget hard limit reached');
    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: `Token hard limit reached (${this.state.budget.totalTokensConsumed}/${hardLimit}), forcing synthesis`,
      },
    });

    if (policy.forceSynthesisOnHardLimit) {
      return this.forceSynthesisFromHistory({
        iteration,
        llm,
        messages,
        reason: `Token hard limit reached (${this.state.budget.totalTokensConsumed}/${hardLimit})`,
        reasonCode: 'token_budget_hard',
        iterationStartTimestamp,
      });
    }

    return this.createFailureResult(
      `Token hard limit reached (${this.state.budget.totalTokensConsumed}/${hardLimit})`,
      iteration,
      'token_budget_hard'
    );
  }

  private detectStuck(): boolean {
    return this.qualityGate.detectStuck({
      lastToolCalls: this.progressTracker.state.lastToolCalls,
      iterationsSinceProgress: this.progressTracker.state.iterationsSinceProgress,
      stuckThreshold: this.progressTracker.state.stuckThreshold,
    });
  }

  private evaluateTierEscalationNeed(input: {
    tier: LLMTier;
    iteration: number;
    maxIterations: number;
  }): { shouldEscalate: boolean; reason: string } {
    return this.tierSelector.evaluateEscalationNeed({
      ...input,
      enableEscalation: !!this.config.enableEscalation,
      hasOnAskParent: !!this.config.onAskParent,
      progressIterationsSinceProgress: this.progressTracker.state.iterationsSinceProgress,
      progressStuckThreshold: this.progressTracker.state.stuckThreshold,
      lastSignalIteration: this.lastSignalIteration,
      lastProgressIteration: this.progressTracker.state.lastProgressIteration,
      lastToolCalls: this.progressTracker.state.lastToolCalls,
      filesRead: this.state.files.filesRead,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
    });
  }

  /**
   * Validate task completion using LLM
   */
  private async validateTaskCompletion(
    task: string,
    agentResponse?: string,
    iterationsUsed = 0
  ): Promise<{ success: boolean; summary: string }> {
    const ctx: CompletionEvaluationContext = {
      task,
      agentResponse,
      iterationsUsed,
      taskIntent: this.taskIntent,
      filesRead: this.state.files.filesRead,
      filesModified: this.state.files.filesModified,
      filesCreated: this.state.files.filesCreated,
      toolsUsedCount: this.state.execution.toolsUsedCount,
      searchSignalHits: this.searchSignalTracker.state.searchSignalHits,
      recentSearchEvidence: this.searchSignalTracker.state.recentSearchEvidence,
      behaviorPolicy: this.behaviorPolicy,
    };
    return this.taskCompletionEvaluator.evaluate(ctx);
  }

  private async buildSystemPrompt(): Promise<string> {
    const responseMode = (
      this.config as unknown as { responseMode?: 'auto' | 'brief' | 'deep' }
    ).responseMode ?? 'auto';
    return this.systemPromptBuilder.build({
      workingDir: this.config.workingDir || process.cwd(),
      responseMode,
      isSubAgent: !!this.config.parentAgentId,
      sessionId: this.config.sessionId,
      sessionRootDir: this.sessionRootDir,
      currentTask: this.currentTask,
      memory: this.memory,
      workspaceDiscovery: this.workspaceDiscovery,
    });
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }


  /**
   * Set the run ID on the FileChangeTracker so all subsequent file changes
   * are tagged with this runId (enabling per-run filtering and rollback).
   * Call this immediately after the Agent is created, before execute().
   */
  setRunId(runId: string): void {
    this.fileChangeTracker?.setRunId(runId);
  }

  /**
   * Get file change history for this agent session
   * Returns all file modifications tracked by FileChangeTracker
   */
  getFileHistory() {
    return this.fileChangeTracker?.getHistory() || [];
  }

  /**
   * Get list of files changed by this agent
   */
  getChangedFiles(): string[] {
    return this.fileChangeTracker?.getChangedFiles() || [];
  }

  /**
   * Get change history for specific file
   */
  getFileChangeHistory(filePath: string) {
    return this.fileChangeTracker?.getFileHistory(filePath) || [];
  }

  /**
   * Rollback latest change to a file
   * @returns true if rolled back, false if file has no changes
   */
  async rollbackFile(filePath: string): Promise<boolean> {
    if (!this.fileChangeTracker) {
      throw new Error('FileChangeTracker not initialized');
    }
    return this.fileChangeTracker.rollbackFile(filePath);
  }

  /**
   * Rollback all changes made by this agent
   * Optionally skip files with conflicts
   */
  async rollbackAllChanges(options?: { skipConflicts?: boolean }) {
    if (!this.fileChangeTracker) {
      throw new Error('FileChangeTracker not initialized');
    }
    return this.fileChangeTracker.rollbackAgent(this.agentId, options);
  }

  /**
   * Detect conflicts before a write operation
   * Returns null if no conflict, or DetectedConflict with type and resolution confidence
   */
  async detectConflict(
    filePath: string,
    operation: 'write' | 'patch' | 'delete',
    metadata?: {
      startLine?: number;
      endLine?: number;
      content?: string;
    }
  ) {
    if (!this.conflictDetector) {
      return null; // Conflict detection not available
    }
    return this.conflictDetector.detectConflict(filePath, this.agentId, operation, metadata);
  }

  /**
   * Resolve a detected conflict using adaptive escalation
   * Returns ResolutionResult with success status, level used, and resolved content
   */
  async resolveConflict(
    conflict: any, // DetectedConflict from conflict-detector
    contentA: string,
    contentB: string
  ) {
    if (!this.conflictResolver) {
      throw new Error('ConflictResolver not initialized');
    }
    return this.conflictResolver.resolve(conflict, contentA, contentB);
  }
}
