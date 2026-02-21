/**
 * Base agent implementation with LLM tool calling
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  AgentSmartTieringConfig,
  TaskResult,
  TraceEntry,
  LLMTier,
  Tracer,
  AgentMemory,
  AgentEvent,
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

/**
 * Event type constants
 */
const EVENT_TYPE_STATUS_CHANGE = 'status:change';
const DEFAULT_EXECUTION_TIER: LLMTier = 'medium';
const DEFAULT_SMART_TIERING_CONFIG: Required<AgentSmartTieringConfig> = {
  enabled: true,
  nodes: {
    intentInference: false,
    searchAssessment: true,
    taskValidation: true,
  },
  auditTasksPreferMedium: true,
  minEvidenceDensityForSmallValidation: 0.9,
  maxIterationsWithoutProgressForMediumSearch: 2,
  intentInferenceMinTaskCharsForMedium: 180,
};

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
import { createEventEmitter } from './events/event-emitter.js';
import { SessionManager } from './planning/session-manager.js';
import {
  createIterationDetailEvent,
  createLLMCallEvent,
  createToolExecutionEvent,
  createMemorySnapshotEvent,
  createSynthesisForcedEvent,
  createErrorCapturedEvent,
  createToolFilterEvent,
  createLLMValidationEvent,
  createStoppingAnalysisEvent,
  createPromptDiffEvent,
  createContextTrimEvent,
} from './tracer/trace-helpers.js';
import { ContextFilter } from './context/context-filter.js';
import { SmartSummarizer } from './context/smart-summarizer.js';
// context_retrieve tool removed — agents should re-read files instead
import { FileChangeTracker } from './history/file-change-tracker.js';
import { SnapshotStorage } from './history/snapshot-storage.js';
import { ConflictDetector } from './history/conflict-detector.js';
import { ConflictResolver } from './history/conflict-resolver.js';
import { AGENT_ANALYTICS_EVENTS, DEFAULT_FILE_HISTORY_CONFIG } from '@kb-labs/agent-contracts';
import { ExecutionStateMachine } from './execution/state-machine.js';
import { TaskLedger, mapToolToCapability } from './execution/task-ledger.js';
import { createDefaultAgentBehaviorPolicy, type AgentBehaviorPolicy } from './execution/policy.js';
import { discoverWorkspace, type WorkspaceDiscoveryResult } from './execution/workspace-discovery.js';

/**
 * Default instruction file names to scan (in order of priority)
 */
const INSTRUCTION_FILE_NAMES = ['AGENT.md', 'KB_AGENT.md', '.agent.md', 'CLAUDE.md'];

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
  private static readonly PROCESS_KPI_BASELINES = new Map<string, {
    driftRateEma: number;
    evidenceDensityEma: number;
    toolErrorRateEma: number;
    samples: number;
    tokenHistory: number[];
    iterationUtilizationHistory: number[];
    qualityScoreHistory: number[];
  }>();
  private config: AgentConfig;
  private toolRegistry: ToolRegistry;
  private filesCreated: Set<string> = new Set();
  private filesModified: Set<string> = new Set();
  private filesRead: Set<string> = new Set();
  private filesReadHash: Map<string, string> = new Map(); // path → content hash (for edit protection)
  private trace: TraceEntry[] = [];
  private totalTokens = 0;
  private tracer?: Tracer;

  /**
   * Tool result cache to prevent duplicate calls within same execution
   * Key: JSON.stringify({ name: toolName, input: normalizedInput })
   * Value: { result: ToolResult, timestamp: number }
   */
  private toolResultCache: Map<string, { result: ToolResult; timestamp: number }> = new Map();

  /**
   * Cache TTL in milliseconds (60 seconds - within single execution)
   */
  private static readonly CACHE_TTL_MS = 60_000;
  private memory?: AgentMemory;
  private currentTask?: string;
  private eventEmitter = createEventEmitter();
  private startTime = 0;
  /** Recent tool call signatures for loop detection */
  private recentToolCalls: string[] = [];
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
  private toolsUsedCount: Map<string, number> = new Map();
  private searchesMadeCount = 0;
  private lastLLMCall?: { request: unknown; response: unknown; durationMs: number };
  private lastToolCall?: { name: string; input: unknown; output?: unknown; error?: string };
  private completedIterations: number[] = [];
  private todoNudgeSent = false;
  private toolSuccessCount = 0;
  private toolErrorCount = 0;
  private touchedDomains = new Set<string>();
  private currentIterationBudget = 0;
  private currentTokenBudget = 0;
  private tokenConvergenceNudgeSent = false;
  private runStartTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private runFinalTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private currentTier: LLMTier = DEFAULT_EXECUTION_TIER;
  private tierEscalations: Array<{
    from: LLMTier;
    to: LLMTier;
    reason: string;
    iteration: number;
  }> = [];
  private behaviorPolicy: AgentBehaviorPolicy = createDefaultAgentBehaviorPolicy();
  private workspaceDiscovery: WorkspaceDiscoveryResult | null = null;
  private consecutiveNoSignalSearchIterations = 0;
  private smallReadWindowByPath = new Map<string, number>();
  private fileTotalLinesByPath = new Map<string, number>();
  private fileReadAttemptsByPath = new Map<string, number>();
  private searchSignalHits = 0;
  private recentSearchEvidence: string[] = [];
  private lastSignalIteration = 0;
  private iterationBudgetExtensions = 0;
  private taskIntent: 'action' | 'discovery' | 'analysis' | null = null;
  private taskBudget: number | null = null;
  private lastReflectionIteration = 0;
  private reflectionCount = 0;
  private hypothesisSwitches = 0;
  private lastReflectionHypothesis = '';
  private executionStateMachine = new ExecutionStateMachine();
  private taskLedger = new TaskLedger();
  private lastQualityGate: {
    status: 'pass' | 'partial';
    score: number;
    reasons: string[];
    nextChecks?: string[];
  } | null = null;
  private todoSyncEnabled = false;
  private todoSyncInitialized = false;
  private todoSyncQueue: Promise<void> = Promise.resolve();
  private todoPhaseItemIds: Record<'scoping' | 'executing' | 'verifying' | 'reporting', string | null> = {
    scoping: null,
    executing: null,
    verifying: null,
    reporting: null,
  };
  private todoPhaseStatus: Record<'scoping' | 'executing' | 'verifying' | 'reporting', 'pending' | 'in-progress' | 'completed' | 'blocked'> = {
    scoping: 'pending',
    executing: 'pending',
    verifying: 'pending',
    reporting: 'pending',
  };

  /**
   * Phase 2: Progress tracking to detect when agent is stuck
   * Automatically triggers ask_parent when stuck patterns are detected
   */
  private progressTracker = {
    lastToolCalls: [] as string[], // Last 3 tool calls
    lastOutputSizes: [] as number[], // Output sizes to detect if gaining information
    iterationsSinceProgress: 0,
    stuckThreshold: 3, // Iterations before considering stuck
    lastFailureCount: 0,
    lastProgressIteration: 0,
    lastSearchSignalHits: 0,
  };

  /**
   * Context optimization components (Phase 4: Integration)
   */
  private contextFilter: ContextFilter;
  private smartSummarizer: SmartSummarizer;
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

  constructor(config: AgentConfig, toolRegistry: ToolRegistry) {
    this.config = config;
    this.toolRegistry = toolRegistry;
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
    if (context.filesRead) {
      this.filesRead = context.filesRead;
    }
    if (context.filesReadHash) {
      this.filesReadHash = context.filesReadHash;
    }

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
      maxOutputLength: 8000,   // 8K chars — enough for most file reads without exploding context
      slidingWindowSize: 20,
      enableDeduplication: true,
    });

    this.smartSummarizer = new SmartSummarizer({
      summarizationInterval: 10,
      llmTier: 'small',
      maxSummaryTokens: 500,
    });

    // Subscribe external callback if provided
    if (config.onEvent) {
      this.eventEmitter.on(config.onEvent);
    }
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
    // Sub-agents already have scoped workingDir from parent
    if (this.config.parentAgentId) { return null; }

    const llm = useLLM({ tier: 'small' });
    if (!llm || !llm.chatWithTools) { return null; }

    const workingDir = this.config.workingDir;
    let availableDirs: string[] = [];
    try {
      const entries = fs.readdirSync(workingDir, { withFileTypes: true });
      availableDirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => e.name);
    } catch {
      return null;
    }

    if (availableDirs.length === 0) { return null; }

    const scopeTool: LLMTool = {
      name: 'select_scope',
      description: 'Select the specific subdirectory/repository that this task is about, or indicate no specific scope',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: [...availableDirs, 'none'],
            description: 'The directory name if task is about a specific one, or "none" if task is general',
          },
        },
        required: ['scope'],
      },
    };

    const prompt = `Analyze this task and determine if it refers to a specific subdirectory/repository.

**Task:** ${task}

**Available directories:**
${availableDirs.map(d => `- ${d}`).join('\n')}

If the task explicitly mentions or is clearly about ONE of these directories, select it.
If the task is general or mentions multiple directories, select "none".

Call select_scope with your choice.`;

    try {
      const response = await llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        { tools: [scopeTool], temperature: 0 }
      );

      const toolCall = response.toolCalls?.[0];
      if (toolCall && toolCall.name === 'select_scope') {
        const input = toolCall.input as { scope: string };
        const scope = input.scope;
        if (scope && scope !== 'none' && availableDirs.includes(scope)) {
          this.log(`🎯 Extracted scope: ${scope}`);
          return scope;
        }
      }
    } catch (error) {
      this.log(`⚠️ Scope extraction error: ${error}`);
    }

    return null;
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

  private buildWorkspaceDiscoveryPrompt(): string | null {
    if (!this.workspaceDiscovery || this.workspaceDiscovery.repos.length === 0) {
      return null;
    }

    const root = this.workspaceDiscovery.rootDir;
    const lines = this.workspaceDiscovery.repos
      .slice(0, 16)
      .map((repo) => {
        const rel = path.relative(root, repo.path) || '.';
        return `- ${rel} (${repo.reasons.join(', ')})`;
      });

    return `# Workspace topology (auto-discovered)\nUse this map to pick initial scope quickly and avoid cross-repo drift.\n${lines.join('\n')}`;
  }

  private getSmartTieringConfig(): Required<AgentSmartTieringConfig> {
    const raw = this.config.smartTiering ?? {};
    return {
      enabled: raw.enabled ?? DEFAULT_SMART_TIERING_CONFIG.enabled,
      nodes: {
        intentInference: raw.nodes?.intentInference ?? DEFAULT_SMART_TIERING_CONFIG.nodes.intentInference,
        searchAssessment: raw.nodes?.searchAssessment ?? DEFAULT_SMART_TIERING_CONFIG.nodes.searchAssessment,
        taskValidation: raw.nodes?.taskValidation ?? DEFAULT_SMART_TIERING_CONFIG.nodes.taskValidation,
      },
      auditTasksPreferMedium: raw.auditTasksPreferMedium ?? DEFAULT_SMART_TIERING_CONFIG.auditTasksPreferMedium,
      minEvidenceDensityForSmallValidation:
        raw.minEvidenceDensityForSmallValidation ?? DEFAULT_SMART_TIERING_CONFIG.minEvidenceDensityForSmallValidation,
      maxIterationsWithoutProgressForMediumSearch:
        raw.maxIterationsWithoutProgressForMediumSearch
          ?? DEFAULT_SMART_TIERING_CONFIG.maxIterationsWithoutProgressForMediumSearch,
      intentInferenceMinTaskCharsForMedium:
        raw.intentInferenceMinTaskCharsForMedium ?? DEFAULT_SMART_TIERING_CONFIG.intentInferenceMinTaskCharsForMedium,
    };
  }

  private isAuditOrAnalysisTask(task: string): boolean {
    return /(audit|architecture|error handling|failure|reliability|resilience|retry|rate.?limit|timeout|anthropic|openai|llm|анализ|аудит|архитектур|ошибк|надежн|ретра|таймаут|лимит)/i.test(task);
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
    const config = this.getSmartTieringConfig();
    if (!config.enabled || !config.nodes[node]) {
      return 'small';
    }

    const task = context?.task ?? this.currentTask ?? '';
    if (config.auditTasksPreferMedium && this.isAuditOrAnalysisTask(task)) {
      return 'medium';
    }

    if (node === 'intentInference') {
      const taskLength = task.trim().length;
      const mixedIntent = Boolean(context?.hasDiscoveryCue && context?.hasActionCue);
      if (mixedIntent && taskLength >= config.intentInferenceMinTaskCharsForMedium) {
        return 'medium';
      }
      return 'small';
    }

    if (node === 'searchAssessment') {
      const noProgressIterations = this.progressTracker.iterationsSinceProgress;
      if (noProgressIterations >= config.maxIterationsWithoutProgressForMediumSearch) {
        return 'medium';
      }
      if ((context?.artifactCount ?? 0) >= 3) {
        return 'medium';
      }
      return 'small';
    }

    const evidenceDensity = context?.evidenceDensity ?? 0;
    const iterationsUsed = context?.iterationsUsed ?? 0;
    const isInformationalTask = context?.isInformationalTask ?? false;
    if (isInformationalTask && evidenceDensity < config.minEvidenceDensityForSmallValidation) {
      return 'medium';
    }
    if (iterationsUsed >= Math.max(6, Math.floor((this.currentIterationBudget || this.config.maxIterations || 8) * 0.7))) {
      return 'medium';
    }
    return 'small';
  }

  private async inferTaskIntent(task: string): Promise<'action' | 'discovery' | 'analysis'> {
    const result = await this.classifyTaskWithLLM(task);
    this.taskBudget = result.budget;
    return result.intent;
  }

  /**
   * LLM-based task classification. Returns intent + initial iteration budget.
   * Called once at execution start; replaces all regex-based heuristics.
   */
  private async classifyTaskWithLLM(
    task: string,
  ): Promise<{ intent: 'action' | 'discovery' | 'analysis'; budget: number }> {
    const configured = this.config.maxIterations || 25;
    const cap = Math.min(configured, 20);

    const llm = useLLM({ tier: 'small' });

    if (llm?.chatWithTools) {
      try {
        const response = await llm.chatWithTools(
          [
            {
              role: 'user',
              content: `You are a task planner. Analyze the user task and return:
1. intent — what kind of task it is
2. budget — how many agent iterations (tool calls) are needed to complete it

Intent options:
- "action": task requires making changes (implement, fix, add, refactor, delete, write)
- "discovery": task requires finding/locating something (where is X, what is Y, show me Z)
- "analysis": task requires understanding/explaining/analyzing

Budget guidelines (these are starting values; more may be granted if progress is made):
- discovery (simple lookup): 6–8
- analysis (explain/summarize): 8–12
- action (small change, 1-2 files): 10–14
- action (medium feature/fix, 3-10 files): 14–18
- action (large refactor/architecture, many files): 18–${cap}

User task:
${task}`,
            },
          ],
          {
            temperature: 0,
            tools: [
              {
                name: 'classify_task',
                description: 'Classify the task and set initial iteration budget.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    intent: {
                      type: 'string',
                      enum: ['action', 'discovery', 'analysis'],
                      description: 'Task intent category',
                    },
                    budget: {
                      type: 'number',
                      description: 'Initial iteration budget (number of steps)',
                    },
                    reasoning: {
                      type: 'string',
                      description: 'One sentence explaining the classification',
                    },
                  },
                  required: ['intent', 'budget'],
                },
              },
            ],
          },
        );

        const call = response.toolCalls?.find((tc) => tc.name === 'classify_task');
        const input = (call?.input ?? {}) as { intent?: string; budget?: number; reasoning?: string };
        const intent = input.intent === 'action' || input.intent === 'discovery' || input.intent === 'analysis'
          ? input.intent
          : null;
        const budget = typeof input.budget === 'number' && input.budget > 0
          ? Math.min(Math.max(input.budget, 4), cap)
          : null;

        if (intent && budget) {
          this.log(`🧠 Task classified: intent=${intent} budget=${budget} — ${input.reasoning ?? ''}`);
          return { intent, budget };
        }
      } catch {
        // Fall through to defaults.
      }
    }

    // Fallback: sensible defaults without regex
    this.log('⚠️ LLM classification failed, using default budget');
    return { intent: 'action', budget: Math.min(configured, 12) };
  }

  private async assessSearchSignalWithLLM(
    artifacts: Array<{ tool: string; content: string }>
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

    const snippets = artifacts.flatMap((a) => this.extractSearchEvidenceSnippets(a.content)).slice(0, 6);
    if (snippets.length > 0) {
      return { signal: 'partial', snippets };
    }
    const hasNegative = artifacts.every((a) => {
      const content = a.content.toLowerCase();
      return content.includes('no result')
        || content.includes('no matches')
        || content.includes('not found')
        || content.includes('не найден')
        || content.includes('нет совпад');
    });
    return {
      signal: hasNegative ? 'none' : 'partial',
      snippets: [],
    };
  }

  /**
   * Execute task with LLM tool calling
   */
  async execute(task: string): Promise<TaskResult> {
    // Check if mode-based execution is requested
    if (this.config.mode && this.config.mode.mode !== 'execute') {
      const { getModeHandler } = await import('./modes/mode-handler');
      const handler = await getModeHandler(this.config.mode);
      return handler.execute(task, this.config, this.toolRegistry);
    }

    // Standard execution
    const startTier = this.config.tier || DEFAULT_EXECUTION_TIER;
    await this.ensureWorkspaceDiscoveryLoaded();
    this.taskIntent = await this.inferTaskIntent(task);
    this.iterationBudgetExtensions = 0;
    this.runStartTier = startTier;
    this.runFinalTier = startTier;
    this.currentTier = startTier;
    this.tierEscalations = [];

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
    this.currentTier = tier;
    this.logTaskHeader(task, tier);
    this.resetState();
    this.currentTask = task;
    this.startTime = Date.now();
    this.startTimestamp = new Date().toISOString();
    let effectiveMaxIterations = this.computeIterationBudget(task);
    this.currentIterationBudget = effectiveMaxIterations;
    const effectiveTokenBudget = await this.computeTokenBudget(task);
    this.currentTokenBudget = effectiveTokenBudget;

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
    if (this.config.sessionId && this.sessionRootDir) {
      const sessionManager = new SessionManager(this.sessionRootDir);
      const history = await sessionManager.getConversationHistoryWithSummarization(this.config.sessionId);
      const traceArtifactsContext = await sessionManager.getTraceArtifactsContext(this.config.sessionId);

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
    this.recordTrace({
      iteration: 0,
      timestamp: new Date().toISOString(),
      type: 'task_start',
      data: {
        task,
        tier,
        systemPrompt,
        availableTools: tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      },
      durationMs: 0,
    });

    for (let iteration = 1; iteration <= effectiveMaxIterations; iteration++) {
      // Check stop signal between iterations — never interrupts a running tool call
      if (this.abortController.signal.aborted) {
        return this.createStoppedResult(iteration, effectiveMaxIterations);
      }

      this.logIterationHeader(iteration, effectiveMaxIterations);

      const iterationStartTimestamp = new Date().toISOString();

      // Emit iteration:start
      this.emit({
        type: 'iteration:start',
        timestamp: iterationStartTimestamp,
        sessionId: this.config.sessionId,
        data: {
          iteration,
          maxIterations: effectiveMaxIterations,
        },
      });

      try {
        if (this.shouldNudgeTodoDiscipline(iteration, task)) {
          this.ensureTodoSyncInitialized(task);
          this.injectedUserContext.push(
            'This task appears multi-step. Create a short todo checklist now (3-7 items), keep it updated after each completed action block, and check it before final report.'
          );
          this.todoNudgeSent = true;
        }

        const isLastIteration = iteration === effectiveMaxIterations;
        const availableTools = this.getCostAwareToolSet(
          tools,
          iteration,
          effectiveMaxIterations,
          effectiveTokenBudget
        );

        // Trace iteration:detail event
        if (this.tracer) {
          const toolNames = availableTools.map((t) => t.name);
          this.tracer.trace(
            createIterationDetailEvent({
              iteration,
              maxIterations: effectiveMaxIterations,
              mode: 'auto', // TODO: extract from config
              temperature: this.config.temperature,
              availableTools: toolNames,
              messages,
              totalTokens: this.totalTokens,
            })
          );
        }

        // Phase 4: Use lean context optimization
         
        const response = await this.callLLMWithTools(
          llm,
          messages,
          availableTools,
          tier,
          iteration,
          this.cachedSystemPrompt,
          this.cachedTaskMessage
        );

        // Trace stopping:analysis event to debug loop termination logic
        if (this.tracer) {
          const hasToolCalls = !!response.toolCalls && response.toolCalls.length > 0;
          const reachedMaxIterations = iteration >= effectiveMaxIterations;
          const noMoreTools = !hasToolCalls;
          const shouldStop = noMoreTools || reachedMaxIterations;

          this.tracer.trace(
            createStoppingAnalysisEvent({
              iteration,
              conditions: {
                maxIterationsReached: reachedMaxIterations,
                timeoutReached: false,
                foundTarget: false,
                sufficientContext: !noMoreTools,
                diminishingReturns: false,
                userInterrupt: false,
                error: false,
              },
              reasoning: shouldStop
                ? reachedMaxIterations
                  ? 'Reached maximum iterations limit'
                  : 'No tool calls in response, natural stop'
                : 'Continuing - LLM requested tool calls',
              iterationsUsed: iteration,
              iterationsRemaining: effectiveMaxIterations - iteration,
              timeElapsedMs: Date.now() - this.startTime,
              toolCallsInLast3Iterations: response.toolCalls?.length || 0,
            })
          );
        }

        if (this.shouldNudgeConvergence(iteration, effectiveMaxIterations, task)) {
          this.transitionPhase('converging', 'mid-run convergence checkpoint');
          this.injectedUserContext.push(
            'Convergence checkpoint: if enough evidence is already collected, stop exploring and provide a concrete answer now. Avoid broad directory scans.'
          );
        }

        if (
          !this.tokenConvergenceNudgeSent
          && this.totalTokens >= Math.floor(effectiveTokenBudget * 0.7)
          && this.hasStrongEvidenceSignal(iteration)
        ) {
          this.transitionPhase('converging', 'token budget convergence checkpoint');
          this.injectedUserContext.push(
            `Token budget checkpoint (${this.totalTokens}/${effectiveTokenBudget}). You already have meaningful evidence. Prefer synthesis/verification over additional broad searches.`
          );
          this.tokenConvergenceNudgeSent = true;
        }

        if (isLastIteration && response.toolCalls && response.toolCalls.length > 0) {
          this.transitionPhase('verifying', 'last iteration reached with pending tool calls');
          this.log(`🧩 Last iteration requested ${response.toolCalls.length} tool call(s); forcing synthesis from collected evidence.`);
          return await this.forceSynthesisFromHistory({
            iteration,
            llm,
            messages,
            reason: 'Last iteration reached with pending tool calls',
            reasonCode: 'max_iterations',
            iterationStartTimestamp,
          });
        }

        // Check if done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          this.transitionPhase('verifying', 'no more tool calls from model');
          // On last iteration, FORCE synthesis if LLM didn't call report
          if (isLastIteration) {
            return await this.forceSynthesisFromHistory({
              iteration,
              llm,
              messages,
              reason: 'Last iteration reached without tool call',
              reasonCode: 'no_tool_call',
              iterationStartTimestamp,
            });
          }

          // Emit iteration:end (no tool calls = done) with startedAt
          this.emit({
            type: 'iteration:end',
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            startedAt: iterationStartTimestamp,
            data: {
              iteration,
              hadToolCalls: false,
              toolCallCount: 0,
              cumulativeTokens: this.totalTokens,
            },
          } as AgentEvent);


          const validation = await this.validateTaskCompletion(task, response.content, iteration);
          this.transitionPhase('reporting', 'validation completed');
          return await this.createSuccessResult(validation, iteration);
        }

        // Execute tools and update messages

        const evidenceScoreBeforeTools = this.getEvidenceProgressScore();
        const toolResults = await this.executeToolCalls(response.toolCalls, iteration);
        const evidenceScoreAfterTools = this.getEvidenceProgressScore();
        const evidenceDelta = Math.max(0, evidenceScoreAfterTools - evidenceScoreBeforeTools);

        await this.appendToolMessagesToHistory(messages, response, toolResults, iteration);
        const failedToolsThisIteration = this.countFailedToolResults(toolResults);

        // Loop detection: if same tool calls repeat 3 iterations in a row, stop
        const toolCallSigs = response.toolCalls.map(tc => ({
          name: tc.name,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}),
        }));
        if (this.detectLoop(toolCallSigs)) {
          this.transitionPhase('reporting', 'loop detected');
          this.log(`\n🔄 Loop detected — same tool calls repeated 3 times. Stopping.\n`);
          return this.createFailureResult(
            'Agent stuck in a loop — repeating the same actions. Report what was found so far.',
            iteration,
            'loop_detected'
          );
        }

        await this.updateNoResultTracker(response.toolCalls, toolResults, iteration);
        // Phase 2: Update progress tracker after tool execution
        if (response.toolCalls.length > 0) {
          const firstToolName = response.toolCalls[0]!.name;
          const totalOutputSize = toolResults.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
          this.updateProgressTracker(firstToolName, totalOutputSize, {
            iteration,
            evidenceDelta,
            failedToolsThisIteration,
            searchSignalHits: this.searchSignalHits,
          });
        }

        await this.maybeRunOperationalReflection(
          {
            trigger: 'post_tools',
            iteration,
            toolCalls: response.toolCalls,
            toolResults,
            failedToolsThisIteration,
            force: false,
          },
          messages
        );
        if (this.shouldConcludeNoResultEarly(iteration)) {
          await this.maybeRunOperationalReflection(
            {
              trigger: 'before_no_result',
              iteration,
              toolCalls: response.toolCalls,
              toolResults,
              failedToolsThisIteration,
              force: true,
            },
            messages
          );
          this.transitionPhase('reporting', 'no-result convergence');
          return await this.createSuccessResult(
            {
              success: true,
              summary: this.buildNoResultConclusionSummary(),
            },
            iteration
          );
        }

        const extendedBudget = this.maybeExtendIterationBudget(iteration, effectiveMaxIterations);
        if (extendedBudget > effectiveMaxIterations) {
          this.log(`📈 Extending iteration budget ${effectiveMaxIterations} -> ${extendedBudget} (progress signal retained)`);
          this.iterationBudgetExtensions += 1;
          this.emit({
            type: EVENT_TYPE_STATUS_CHANGE,
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            data: {
              status: 'thinking',
              message: `Progress detected, extending budget ${effectiveMaxIterations} -> ${extendedBudget} (#${this.iterationBudgetExtensions})`,
            },
          });
          effectiveMaxIterations = extendedBudget;
          this.currentIterationBudget = extendedBudget;
        }

        const escalationCheck = this.evaluateTierEscalationNeed({
          tier,
          iteration,
          maxIterations: effectiveMaxIterations,
        });
        if (escalationCheck.shouldEscalate) {
          await this.maybeRunOperationalReflection(
            {
              trigger: 'before_escalation',
              iteration,
              toolCalls: response.toolCalls,
              toolResults,
              failedToolsThisIteration,
              force: true,
              escalationReason: escalationCheck.reason,
            },
            messages
          );
          this.emit({
            type: EVENT_TYPE_STATUS_CHANGE,
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            data: {
              status: 'thinking',
              message: `Escalating to higher tier: ${escalationCheck.reason}`,
            },
          });
          throw new TierEscalationSignal(escalationCheck.reason, iteration);
        }

        // Phase 4: Trigger async summarization every 10 iterations (non-blocking)
        if (iteration % 10 === 0) {
          const historySnapshot = this.contextFilter.getHistorySnapshot();
          this.smartSummarizer.triggerSummarization(historySnapshot, iteration)
            .catch((err: Error) => {
              this.log(`⚠️  Background summarization failed: ${err.message}`);
            });
        }

        // Phase 1: Check for ask_parent tool call
        const hasAskParent = response.toolCalls.some(tc => tc.name === 'ask_parent');
        if (hasAskParent && this.config.onAskParent) {
          // Extract question from tool call
          const askCall = response.toolCalls.find(tc => tc.name === 'ask_parent');
          const input = askCall?.input as Record<string, unknown> | undefined;
          const question = (input?.question as string) || 'No question provided';
          const reason = (input?.reason as 'stuck' | 'uncertain' | 'blocker' | 'clarification') || 'uncertain';
          const context = input?.context as Record<string, unknown> | undefined;

          // Call parent agent callback
           
          const parentResponse = await this.config.onAskParent({
            question,
            reason,
            context,
            iteration,
            subtask: this.currentTask,
          });

          // Add parent's answer to conversation history
          messages.push({
            role: 'user',
            content: `📣 Parent agent response:\n\n${parentResponse.answer}${parentResponse.hint ? `\n\n💡 Hint: ${parentResponse.hint}` : ''}`,
          });

          // Handle parent action
          if (parentResponse.action === 'skip') {
            // Parent says skip this subtask
             
            return await this.createSuccessResult({
              success: true,
              summary: `Skipped on parent's guidance: ${parentResponse.answer}`,
            }, iteration);
          }

          // Continue with next iteration (parent's answer is in history)
          continue;
        }

        // Check for early exit via report
        const hasReportTool = response.toolCalls.some(tc => tc.name === 'report');
        if (hasReportTool) {
          // Extract answer from tool call
          const reportCall = response.toolCalls.find(tc => tc.name === 'report');
          const input = reportCall?.input as Record<string, unknown> | undefined;
          const answer = (input?.answer as string) || 'No answer provided';
          const confidence = (input?.confidence as number) || 0.5;

          // Emit iteration:end
          this.emit({
            type: 'iteration:end',
            timestamp: new Date().toISOString(),
            sessionId: this.config.sessionId,
            startedAt: iterationStartTimestamp,
            data: {
              iteration,
              hadToolCalls: true,
              toolCallCount: response.toolCalls.length,
              cumulativeTokens: this.totalTokens,
            },
          } as AgentEvent);

          // Return early with synthesized answer
          this.transitionPhase('reporting', 'report tool used');
          return await this.createSuccessResult({
            success: confidence >= 0.5,
            summary: answer,
          }, iteration);
        }

        // MANUAL REFLECTION: Check if agent manually called reflect_on_progress
        const hasManualReflection = response.toolCalls.some(tc => tc.name === 'reflect_on_progress');
        if (hasManualReflection) {
          // Find reflection result from tool execution
          const reflectionCall = response.toolCalls.find(tc => tc.name === 'reflect_on_progress');
          const reflectionResult = toolResults.find(
            msg => msg.toolCallId === reflectionCall?.id
          );

          // Check if metadata indicates auto-report
          const metadata = reflectionResult?.metadata as { shouldAutoReport?: boolean; reflection?: { findingsSummary: string; confidence: number } } | undefined;

          if (metadata?.shouldAutoReport && metadata?.reflection) {
            this.log(`\n🤔 Manual reflection triggered auto-report (confidence: ${metadata.reflection.confidence.toFixed(2)})\n`);

            // Auto-trigger report
            this.transitionPhase('reporting', 'reflect_on_progress auto-report');
            return await this.createSuccessResult({
              success: true,
              summary: metadata.reflection.findingsSummary,
            }, iteration);
          }
        }

        // Auto-detect stuck and ask parent for help
        if (this.detectStuck() && this.config.onAskParent) {
          this.log(`\n🔄 Detected stuck pattern - asking parent for guidance...\n`);

          const stuckReason = this.progressTracker.lastToolCalls.length >= 3 &&
                             new Set(this.progressTracker.lastToolCalls.slice(-3)).size === 1
            ? `Using same tool (${this.progressTracker.lastToolCalls[0]}) repeatedly`
            : `No progress for ${this.progressTracker.iterationsSinceProgress} iterations`;

           
          const parentResponse = await this.config.onAskParent({
            question: `I appear to be stuck. ${stuckReason}. What should I do?`,
            reason: 'stuck',
            context: {
              lastToolCalls: this.progressTracker.lastToolCalls,
              iterationsSinceProgress: this.progressTracker.iterationsSinceProgress,
            },
            iteration,
            subtask: this.currentTask,
          });

          // Add parent's guidance to conversation
          messages.push({
            role: 'user',
            content: `🤖 Auto-detected stuck pattern!\n\n📣 Parent guidance:\n\n${parentResponse.answer}${parentResponse.hint ? `\n\n💡 Hint: ${parentResponse.hint}` : ''}`,
          });

          // Reset progress tracker after getting help
          this.progressTracker.iterationsSinceProgress = 0;
          this.progressTracker.lastToolCalls = [];
          this.progressTracker.lastOutputSizes = [];
          this.progressTracker.lastFailureCount = 0;
          this.progressTracker.lastSearchSignalHits = this.searchSignalHits;
          this.progressTracker.lastProgressIteration = iteration;

          // Handle parent action
          if (parentResponse.action === 'skip') {
            this.transitionPhase('reporting', 'parent requested skip');
            return await this.createSuccessResult({
              success: true,
              summary: `Skipped on parent's guidance (auto-stuck detection): ${parentResponse.answer}`,
            }, iteration);
          }

          // Continue with parent's guidance
          continue;
        }

        // Track completed iteration
        this.completedIterations.push(iteration);

        // Trace memory:snapshot event
        if (this.tracer) {
          this.tracer.trace(
            createMemorySnapshotEvent({
              iteration,
              conversationHistory: messages.length,
              userPreferences: {}, // TODO: extract from memory if available
              facts: [], // TODO: extract from memory if available
              findings: [], // TODO: extract from memory if available
              filesRead: Array.from(this.filesRead),
              searchesMade: this.searchesMadeCount,
              toolsUsed: Object.fromEntries(this.toolsUsedCount),
            })
          );
        }

        // Emit iteration:end (with tool calls) with startedAt
        this.emit({
          type: 'iteration:end',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          startedAt: iterationStartTimestamp,
          data: {
            iteration,
            hadToolCalls: true,
            toolCallCount: response.toolCalls.length,
            cumulativeTokens: this.totalTokens,
          },
        } as AgentEvent);
      } catch (error) {
        if (isTierEscalationSignal(error)) {
          throw error;
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`\n❌ Error in iteration ${iteration}: ${errorMsg}\n`);

        // Trace detailed error:captured event
        if (this.tracer && error instanceof Error) {
          const availableTools = this.toolRegistry.getDefinitions().map((td) => td.function.name);

          this.tracer.trace(
            createErrorCapturedEvent({
              iteration,
              error,
              lastLLMCall: this.lastLLMCall,
              lastToolCall: this.lastToolCall,
              currentMessages: messages,
              memoryState: {
                filesRead: Array.from(this.filesRead),
                searchesMade: this.searchesMadeCount,
              },
              availableTools,
              agentStack: {
                currentPhase: 'execution',
                iterationHistory: this.completedIterations,
              },
            })
          );
        }

        // Emit agent:error
        this.emit({
          type: 'agent:error',
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          data: {
            error: errorMsg,
            iteration,
            recoverable: false,
          },
        });

        this.transitionPhase('reporting', 'error path');
        return this.createFailureResult(`Failed: ${errorMsg}`, iteration, errorMsg);
      }
    }

    this.transitionPhase('reporting', 'max iteration reached');
    return this.createFailureResult(
      `Max iterations (${effectiveMaxIterations}) reached without completion`,
      effectiveMaxIterations
    );
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
   * Reset agent state
   */
  private resetState(): void {
    this.filesCreated.clear();
    this.filesModified.clear();
    this.filesRead.clear();
    this.filesReadHash.clear();
    this.trace = [];
    this.totalTokens = 0;
    this.toolResultCache.clear(); // Clear cache on new execution (Phase 1, Step 1.4)
    this.toolsUsedCount.clear();
    this.recentToolCalls = [];
    this.completedIterations = [];
    this.todoNudgeSent = false;
    this.toolSuccessCount = 0;
    this.toolErrorCount = 0;
    this.touchedDomains.clear();
    this.currentIterationBudget = 0;
    this.currentTokenBudget = 0;
    this.taskBudget = null;
    this.tokenConvergenceNudgeSent = false;
    this.consecutiveNoSignalSearchIterations = 0;
    this.smallReadWindowByPath.clear();
    this.fileTotalLinesByPath.clear();
    this.fileReadAttemptsByPath.clear();
    this.searchSignalHits = 0;
    this.recentSearchEvidence = [];
    this.lastSignalIteration = 0;
    this.lastReflectionIteration = 0;
    this.reflectionCount = 0;
    this.hypothesisSwitches = 0;
    this.lastReflectionHypothesis = '';
    this.iterationBudgetExtensions = 0;
    this.progressTracker.lastToolCalls = [];
    this.progressTracker.lastOutputSizes = [];
    this.progressTracker.iterationsSinceProgress = 0;
    this.progressTracker.lastFailureCount = 0;
    this.progressTracker.lastProgressIteration = 0;
    this.progressTracker.lastSearchSignalHits = 0;
    this.executionStateMachine = new ExecutionStateMachine();
    this.taskLedger = new TaskLedger();
    this.lastQualityGate = null;
    this.todoSyncEnabled = false;
    this.todoSyncInitialized = false;
    this.todoSyncQueue = Promise.resolve();
    this.todoPhaseItemIds = {
      scoping: null,
      executing: null,
      verifying: null,
      reporting: null,
    };
    this.todoPhaseStatus = {
      scoping: 'pending',
      executing: 'pending',
      verifying: 'pending',
      reporting: 'pending',
    };
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

    // Build lean context with truncation + sliding window
    const systemMsg: LLMMessage = { role: 'system', content: systemPrompt };
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
        if (truncated) entry.truncated = true;
        if (toolCallsArr.length > 0) {
          entry.toolCalls = toolCallsArr.map((tc: any) => tc.name || tc.function?.name);
        }
        if ((msg as any).toolCallId) entry.toolCallId = (msg as any).toolCallId;
        // Preview: first 200 chars for system/user, first 100 for tool results
        const previewLen = msg.role === 'tool' ? 100 : 200;
        if (content.length > 0) entry.preview = content.slice(0, previewLen);
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
      this.totalTokens += tokensUsed;
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

    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'llm_call',
      data: {
        tier,
        tokensUsed,
      },
      durationMs,
    });

    // Record LLM response with FULL reasoning text and tool calls
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'llm_response',
      data: {
        // Full reasoning text — critical for debugging agent decisions
        content: response.content || '',
        contentLength: (response.content || '').length,
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
        toolCallsCount: response.toolCalls?.length || 0,
        toolCalls: response.toolCalls?.map(tc => ({
          name: tc.name,
          // Full args for debugging — not truncated
          args: typeof tc.input === 'string'
            ? tc.input
            : JSON.stringify(tc.input || {}),
        })),
        // Stop reason helps understand why LLM chose tools vs text
        stopReason: response.toolCalls && response.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      },
      durationMs,
    });

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
      this.toolsUsedCount.set(toolCall.name, (this.toolsUsedCount.get(toolCall.name) ?? 0) + 1);
      const input = this.normalizeToolInput(toolCall.name, (toolCall.input as Record<string, unknown>) ?? {});
      this.trackDomainTouch(toolCall.name, input);
      const ledgerStepId = this.taskLedger.startStep({
        goal: `Execute ${toolCall.name}`,
        capability: mapToolToCapability(toolCall.name),
        toolName: toolCall.name,
      });

      // === DISABLED: Cache has bug with tool_use_id format (Phase 1, Step 1.4) ===
      // TODO: Fix cache to work within single LLM request, not across iterations
      // const cacheKey = this.buildCacheKey(toolCall.name, input);
      // const cached = this.getCachedResult(cacheKey);
      // ... cache logic disabled for now
      // === END DISABLED ===

      this.log(
        `🔧 ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}...)`
      );

      if (toolCall.name === 'shell_exec') {
        const command = typeof input.command === 'string' ? input.command : '';
        const resolvedCwd = this.resolveShellCwd(input);
        this.emit({
          type: EVENT_TYPE_STATUS_CHANGE,
          timestamp: new Date().toISOString(),
          sessionId: this.config.sessionId,
          data: {
            status: 'executing',
            message: this.isRiskyShellCommand(command)
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
          this.toolSuccessCount++;
          this.taskLedger.completeStep(ledgerStepId, result.output?.slice(0, 500));
        } else {
          this.toolErrorCount++;
          this.taskLedger.failStep(ledgerStepId, result.error || 'tool returned error');
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
            this.fileTotalLinesByPath.set(filePath, Math.floor(totalLines));
          }
        }
        this.logToolResult(result);
        this.recordToolTrace(toolCall, result, iteration, toolDurationMs);
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
        const guardRejected = this.isGuardRejectedToolCallError(errorMsg);
        if (guardRejected) {
          this.taskLedger.completeStep(ledgerStepId, `Guard rejected tool call: ${errorMsg.slice(0, 200)}`);
        } else {
          this.toolErrorCount++;
          this.taskLedger.failStep(ledgerStepId, errorMsg);
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
    const normalized = { ...input };
    if (toolName === 'glob_search' || toolName === 'grep_search' || toolName === 'find_definition' || toolName === 'code_stats') {
      this.normalizeDirectoryField(normalized);
    }

    if (toolName === 'glob_search') {
      const pattern = typeof normalized.pattern === 'string'
        ? normalized.pattern
        : typeof normalized.query === 'string'
          ? normalized.query
          : '';
      if (pattern && typeof normalized.pattern !== 'string') {
        normalized.pattern = pattern;
      }

      if (typeof normalized.pattern === 'string') {
        const trimmed = normalized.pattern.trim();
        const hasGlobMeta = /[*?[\]{}]/.test(trimmed);
        if (trimmed && !hasGlobMeta) {
          normalized.pattern = `**/*${trimmed}*`;
        }
      }
    }

    if (toolName === 'fs_read' && typeof normalized.path === 'string') {
      const trimmedPath = normalized.path.trim();
      const fallbackPath = this.tryResolvePrimarySourcePath(trimmedPath);
      if (fallbackPath) {
        normalized.path = fallbackPath;
      } else {
        const tsPath = this.tryResolveTsSourcePath(trimmedPath);
        if (tsPath) {
          normalized.path = tsPath;
        }
      }

      const resolvedPath = String(normalized.path);
      const currentOffset = Number(normalized.offset);
      const safeOffset = Number.isFinite(currentOffset) && currentOffset > 0 ? Math.floor(currentOffset) : 1;
      normalized.offset = safeOffset;

      const requestedLimit = Number(normalized.limit);
      const adaptiveLimit = this.computeAdaptiveReadLimit(
        resolvedPath,
        Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : undefined,
        safeOffset
      );
      if (adaptiveLimit > 0) {
        normalized.limit = adaptiveLimit;
      }
    }

    if (toolName === 'shell_exec') {
      const rawCwd = typeof normalized.cwd === 'string' ? normalized.cwd.trim() : '';
      if (!rawCwd) {
        normalized.cwd = '.';
      }
    }
    return normalized;
  }

  private normalizeDirectoryField(input: Record<string, unknown>): void {
    if (typeof input.directory !== 'string') {
      return;
    }

    const rawDirectory = input.directory.trim();
    if (!rawDirectory || rawDirectory === '.') {
      return;
    }

    const workingDir = this.config.workingDir || process.cwd();
    const absolutePath = path.isAbsolute(rawDirectory)
      ? rawDirectory
      : path.resolve(workingDir, rawDirectory);

    const setDirectoryFromAbs = (absDir: string): void => {
      const relativeDir = path.relative(workingDir, absDir);
      if (!relativeDir || relativeDir === '.') {
        input.directory = '.';
        return;
      }
      input.directory = relativeDir.startsWith('..') ? '.' : relativeDir;
    };

    if (fs.existsSync(absolutePath)) {
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.isFile()) {
          setDirectoryFromAbs(path.dirname(absolutePath));
        }
      } catch {
        // Keep original value on stat error.
      }
      return;
    }

    // If the path looks like a file reference, try its parent directory.
    if (/\.[a-z0-9]+$/i.test(rawDirectory)) {
      const parentDir = path.dirname(absolutePath);
      if (fs.existsSync(parentDir)) {
        try {
          if (fs.statSync(parentDir).isDirectory()) {
            setDirectoryFromAbs(parentDir);
          }
        } catch {
          // Keep original value on stat error.
        }
      }
    }
  }

  private assertToolCallIsAllowed(
    toolName: string,
    input: Record<string, unknown>
  ): void {
    const missingRequired = this.findMissingRequiredToolParams(toolName, input);
    if (missingRequired.length > 0) {
      throw new Error(
        `${toolName} is missing required input field(s): ${missingRequired.join(', ')}.`
      );
    }

    if (toolName === 'glob_search') {
      const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
      if (!pattern) {
        throw new Error('glob_search requires a non-empty glob pattern (e.g. "*.ts", "src/**/*.ts").');
      }
    }

    if (toolName === 'fs_read') {
      const filePath = typeof input.path === 'string' ? input.path.trim() : '';
      if (!filePath) {
        throw new Error('fs_read requires a non-empty file path.');
      }

      const span = this.getRequestedReadSpan(input);
      if (span !== null && span < this.behaviorPolicy.retrieval.minReadWindowLines) {
        const smallReadCount = this.registerSmallReadWindow(filePath, span);
        if (smallReadCount > this.behaviorPolicy.retrieval.maxConsecutiveSmallWindowReadsPerFile) {
          throw new Error(
            `fs_read window too narrow repeatedly for "${filePath}" (${span} lines). Broaden read window or read full file before further micro-slices.`
          );
        }
      } else if (span === null || span >= this.behaviorPolicy.retrieval.minReadWindowLines) {
        this.smallReadWindowByPath.set(filePath, 0);
      }

      if (this.isSecondaryArtifactPath(filePath) && !this.taskExplicitlyRequestsSecondaryArtifacts()) {
        throw new Error(
          `Blocked low-signal file "${filePath}". Read primary source files first (avoid backup/dist/build artifacts unless user explicitly asked).`
        );
      }
    }
  }

  private isSecondaryArtifactPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return (
      normalized.includes('/dist/')
      || normalized.includes('/build/')
      || normalized.endsWith('.map')
      || normalized.endsWith('.min.js')
      || normalized.includes('.backup')
      || normalized.endsWith('.bak')
      || normalized.endsWith('.orig')
      || normalized.endsWith('.tmp')
    );
  }

  private isGuardRejectedToolCallError(errorMessage: string): boolean {
    return (
      errorMessage.startsWith('Blocked low-signal file')
      || errorMessage.includes('missing required input field')
      || errorMessage.includes('requires a non-empty glob pattern')
      || errorMessage.includes('requires a non-empty file path')
    );
  }

  private findMissingRequiredToolParams(
    toolName: string,
    input: Record<string, unknown>
  ): string[] {
    const definition = this.toolRegistry.getDefinitions().find((d) => d.function.name === toolName);
    const params = definition?.function.parameters as { required?: unknown } | undefined;
    const required = Array.isArray(params?.required)
      ? params.required.filter((value): value is string => typeof value === 'string')
      : [];

    if (required.length === 0) {
      return [];
    }

    return required.filter((field) => {
      const value = input[field];
      if (value === undefined || value === null) {
        return true;
      }
      if (typeof value === 'string' && value.trim().length === 0) {
        return true;
      }
      return false;
    });
  }

  private tryResolvePrimarySourcePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const removableSuffixes = ['.backup', '.bak', '.orig', '.tmp'];
    const matched = removableSuffixes.find((suffix) => lower.endsWith(suffix));
    if (!matched) {
      return null;
    }

    const candidate = normalized.slice(0, normalized.length - matched.length);
    const absCandidate = path.isAbsolute(candidate)
      ? candidate
      : path.join(this.config.workingDir, candidate);

    if (!fs.existsSync(absCandidate)) {
      return null;
    }

    return path.isAbsolute(filePath) ? absCandidate : candidate;
  }

  private tryResolveTsSourcePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.endsWith('.js')) {
      return null;
    }

    const base = normalized.slice(0, -3);
    const candidates = [`${base}.ts`, `${base}.tsx`];
    for (const candidate of candidates) {
      const absCandidate = path.isAbsolute(candidate)
        ? candidate
        : path.join(this.config.workingDir, candidate);
      if (fs.existsSync(absCandidate)) {
        return path.isAbsolute(filePath) ? absCandidate : candidate;
      }
    }
    return null;
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

  private shouldNudgeTodoDiscipline(iteration: number, task: string): boolean {
    if (this.todoNudgeSent || iteration < 2) {
      return false;
    }

    const hasTodo = ['todo_create', 'todo_update', 'todo_get']
      .some((name) => (this.toolsUsedCount.get(name) ?? 0) > 0);
    if (hasTodo) {
      return false;
    }

    const totalToolCalls = Array.from(this.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    if (totalToolCalls < 2) {
      return false;
    }

    const likelyMultiStep = /(fix|refactor|implement|add|change|update|investigate|analyze|проанализ|исправ|добав|обнов|сделай|проверь)/i.test(task);
    return likelyMultiStep;
  }

  private computeIterationBudget(_task: string): number {
    const configured = this.config.maxIterations || 25;
    // Budget is set by LLM classification in inferTaskIntent (called before this).
    if (this.taskBudget !== null) {
      return Math.min(this.taskBudget, configured);
    }
    return Math.min(configured, 12);
  }

  private async computeTokenBudget(_task: string): Promise<number> {
    const sessionId = this.config.sessionId;
    if (!sessionId || !this.sessionRootDir) {
      return 0;
    }

    try {
      const sessionManager = new SessionManager(this.sessionRootDir);
      const baseline = await sessionManager.getKpiBaseline(sessionId);
      if (!baseline || baseline.samples < 5 || baseline.tokenHistory.length < 5) {
        return 0;
      }

      const tokenPool = baseline.tokenHistory.filter((value) => Number.isFinite(value) && value > 0);
      if (tokenPool.length < 5) {
        return 0;
      }

      const qualityAwarePool: number[] = [];
      for (let i = 0; i < tokenPool.length; i++) {
        const quality = baseline.qualityScoreHistory[i] ?? 0;
        if (quality >= 0.75) {
          qualityAwarePool.push(tokenPool[i]!);
        }
      }

      const source = qualityAwarePool.length >= 5 ? qualityAwarePool : tokenPool;
      const p75 = this.percentile(source, 0.75);
      const p90 = this.percentile(source, 0.9);
      if (p75 <= 0 || p90 <= 0) {
        return 0;
      }

      return Math.max(Math.round(p75), Math.round(p90 * 0.8));
    } catch {
      return 0;
    }
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
    if (tokenBudget <= 0 || this.totalTokens < Math.floor(tokenBudget * 0.9)) {
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
    const toolCallsTotal = Array.from(this.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    const evidenceDensity = iterationsUsed > 0 ? evidenceCount / iterationsUsed : 0;
    const driftRate = toolCallsTotal > 0 ? Math.max(0, this.touchedDomains.size - 1) / toolCallsTotal : 0;
    const toolErrorRate = toolCallsTotal > 0 ? this.toolErrorCount / toolCallsTotal : 0;

    return (
      evidenceCount >= 3
      && evidenceDensity >= 0.55
      && driftRate <= 0.08
      && toolErrorRate <= 0.1
    );
  }

  private isLikelyActionTask(task: string): boolean {
    if (this.taskIntent) {
      return this.taskIntent === 'action';
    }
    return /(create|implement|fix|patch|write|edit|add|remove|rename|refactor|удали|создай|исправ|добав|переимен|рефактор)/i.test(task);
  }

  private percentile(values: number[], percentile: number): number {
    if (values.length === 0) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1));
    return sorted[index] || 0;
  }

  private async forceSynthesisFromHistory(input: {
    iteration: number;
    llm: ILLM;
    messages: LLMMessage[];
    reason: string;
    reasonCode: 'max_iterations' | 'no_tool_call';
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

    const synthesisPrompt = `You are at the final synthesis step. Do not call tools.
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

    const leanContext = await this.buildLeanContext(
      this.cachedSystemPrompt!,
      this.cachedTaskMessage!,
      iteration
    );

    const synthesisStartTime = Date.now();
    const synthesisResponse = await llm.chatWithTools(leanContext, {
      tools: [],
      toolChoice: 'none',
      temperature: this.config.temperature || 0.1,
    });
    const synthesisDurationMs = Date.now() - synthesisStartTime;
    const synthesizedAnswer = synthesisResponse.content || 'Unable to synthesize findings';

    if (this.tracer) {
      this.tracer.trace(
        createSynthesisForcedEvent({
          iteration,
          reason: reasonCode,
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
        cumulativeTokens: this.totalTokens,
      },
    } as AgentEvent);

    this.transitionPhase('reporting', 'forced synthesis result');
    return await this.createSuccessResult({
      success: true,
      summary: synthesizedAnswer,
    }, iteration);
  }

  private shouldNudgeConvergence(iteration: number, maxIterations: number, task: string): boolean {
    if (maxIterations <= 6 || iteration < 4) {
      return false;
    }
    const taskLooksActionHeavy = /(create|implement|fix|patch|write|edit|add|удали|создай|исправ|добав)/i.test(task);
    if (taskLooksActionHeavy && this.filesModified.size === 0 && this.filesCreated.size === 0) {
      return false;
    }
    const totalToolCalls = Array.from(this.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    return totalToolCalls >= 4;
  }

  private evaluateQualityGate(iterationsUsed: number): {
    status: 'pass' | 'partial';
    score: number;
    reasons: string[];
    nextChecks?: string[];
  } {
    const reasons: string[] = [];
    let score = 1;

    const toolCallsTotal = Array.from(this.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    const todoToolCalls = (this.toolsUsedCount.get('todo_create') ?? 0)
      + (this.toolsUsedCount.get('todo_update') ?? 0)
      + (this.toolsUsedCount.get('todo_get') ?? 0);
    const driftDomainCount = this.touchedDomains.size;
    const driftRate = toolCallsTotal > 0 ? Math.max(0, driftDomainCount - 1) / toolCallsTotal : 0;
    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    const evidenceDensity = iterationsUsed > 0 ? evidenceCount / iterationsUsed : 0;
    const toolErrorRate = toolCallsTotal > 0 ? this.toolErrorCount / toolCallsTotal : 0;
    const ledgerSummary = this.taskLedger.getSummary();

    if (toolErrorRate >= 0.3) {
      reasons.push(`high tool error rate (${(toolErrorRate * 100).toFixed(0)}%)`);
      score -= 0.35;
    }
    if (driftRate >= 0.2 && driftDomainCount >= 2) {
      reasons.push(`scope drift detected (${driftDomainCount} domains)`);
      score -= 0.25;
    }
    if (evidenceDensity < 0.2 && toolCallsTotal >= 5) {
      if (this.searchSignalHits === 0) {
        reasons.push('low evidence density');
        score -= 0.2;
      } else {
        reasons.push('evidence mostly from search matches; direct verification remains limited');
        score -= 0.08;
      }
    }
    if (this.currentTask && this.isLikelyMultiStepTask(this.currentTask) && iterationsUsed >= 5 && todoToolCalls === 0) {
      reasons.push('missing progress tracking on multi-step task');
      score -= 0.15;
    }
    if (ledgerSummary.failedSteps > 0) {
      reasons.push(`${ledgerSummary.failedSteps} failed execution step(s)`);
      score -= 0.2;
    }
    if (ledgerSummary.pendingSteps > 0) {
      reasons.push(`${ledgerSummary.pendingSteps} pending step(s) at completion`);
      score -= 0.1;
    }

    if (score < 0) {
      score = 0;
    }

    const result: {
      status: 'pass' | 'partial';
      score: number;
      reasons: string[];
      nextChecks?: string[];
    } = {
      status: score >= 0.55 ? 'pass' : 'partial',
      score,
      reasons,
    };
    if (result.status === 'partial') {
      result.nextChecks = this.suggestQualityNextChecks(reasons);
    }
    return result;
  }

  private isLikelyMultiStepTask(task: string): boolean {
    return /(пошаг|step-by-step|steps|checklist|проверь|investigate|analyze|refactor|implement|migration|audit)/i.test(task);
  }

  private suggestQualityNextChecks(reasons: string[]): string[] {
    const checks: string[] = [];
    for (const reason of reasons) {
      const normalized = reason.toLowerCase();
      if (normalized.includes('drift')) {
        checks.push('Restrict scope to the primary target and rerun focused discovery.');
      } else if (normalized.includes('evidence')) {
        checks.push('Collect concrete evidence from relevant resources before final response.');
      } else if (normalized.includes('tool error')) {
        checks.push('Retry failed tool steps or use alternate capabilities for the same goal.');
      } else if (normalized.includes('progress tracking')) {
        checks.push('Create/update progress checklist and confirm completion before reporting.');
      } else if (normalized.includes('failed execution') || normalized.includes('pending step')) {
        checks.push('Resolve failed or pending execution steps before finalizing.');
      }
    }
    return Array.from(new Set(checks)).slice(0, 4);
  }

  private buildNeedsClarificationSummary(
    originalSummary: string,
    gate: { reasons: string[]; nextChecks?: string[] }
  ): string {
    const nextChecks = gate.nextChecks && gate.nextChecks.length > 0
      ? gate.nextChecks
      : ['Run one focused verification pass and provide evidence-backed findings.'];
    const reasons = gate.reasons.length > 0 ? gate.reasons : ['insufficient confidence'];
    return `${originalSummary}

[Needs Clarification]
- Confidence: partial
- Reasons: ${reasons.join('; ')}
- Next checks:
${nextChecks.map((item) => `  - ${item}`).join('\n')}`;
  }

  private transitionPhase(
    next: 'scoping' | 'planning_lite' | 'executing' | 'converging' | 'verifying' | 'reporting',
    reason?: string
  ): void {
    try {
      this.executionStateMachine.transition(next, reason);
      this.syncTodoWithPhase(next);
    } catch {
      // Phase transitions are observability metadata and must never break execution.
    }
  }

  private ensureTodoSyncInitialized(task: string): void {
    if (this.todoSyncInitialized) {
      return;
    }
    this.todoSyncInitialized = true;
    this.queueTodoSync(async () => {
      if (!this.config.sessionId || !this.hasTool('todo_create')) {
        return;
      }

      const sessionKey = this.config.sessionId;
      const items = [
        { description: `Scope task: ${task.slice(0, 80)}`, priority: 'high' as const },
        { description: 'Collect evidence and execute relevant actions', priority: 'high' as const },
        { description: 'Verify findings and convergence', priority: 'medium' as const },
        { description: 'Prepare final response', priority: 'medium' as const },
      ];

      const result = await this.executeTodoTool('todo_create', {
        sessionId: sessionKey,
        items,
      });
      if (!result.success) {
        return;
      }

      this.todoSyncEnabled = true;
      this.todoPhaseItemIds = {
        scoping: `${sessionKey}-1`,
        executing: `${sessionKey}-2`,
        verifying: `${sessionKey}-3`,
        reporting: `${sessionKey}-4`,
      };
    });
  }

  private syncTodoWithPhase(
    phase: 'scoping' | 'planning_lite' | 'executing' | 'converging' | 'verifying' | 'reporting'
  ): void {
    if (!this.todoSyncEnabled || !this.config.sessionId || !this.hasTool('todo_update')) {
      return;
    }

    this.queueTodoSync(async () => {
      if (phase === 'scoping') {
        await this.updateTodoPhaseStatus('scoping', 'in-progress', 'Identifying task scope');
        return;
      }

      if (phase === 'executing' || phase === 'converging') {
        await this.updateTodoPhaseStatus('scoping', 'completed', 'Scope identified');
        await this.updateTodoPhaseStatus('executing', 'in-progress', 'Executing task steps');
        return;
      }

      if (phase === 'verifying') {
        await this.updateTodoPhaseStatus('executing', 'completed', 'Execution done');
        await this.updateTodoPhaseStatus('verifying', 'in-progress', 'Verifying evidence');
        return;
      }

      if (phase === 'reporting') {
        await this.updateTodoPhaseStatus('verifying', 'completed', 'Verification done');
        await this.updateTodoPhaseStatus('reporting', 'in-progress', 'Preparing final response');
      }
    });
  }

  private queueTodoSync(job: () => Promise<void>): void {
    this.todoSyncQueue = this.todoSyncQueue.then(job).catch((err) => {
      this.log(`[Agent] TODO sync failed: ${err}`);
    });
  }

  private hasTool(toolName: string): boolean {
    return this.toolRegistry.getDefinitions().some((d) => d.function.name === toolName);
  }

  private async executeTodoTool(
    toolName: 'todo_create' | 'todo_update' | 'todo_get',
    input: Record<string, unknown>
  ): Promise<{ success: boolean; output?: string; error?: string; errorDetails?: ToolResult['errorDetails'] }> {
    const ledgerStepId = this.taskLedger.startStep({
      goal: `Todo sync: ${toolName}`,
      capability: mapToolToCapability(toolName),
      toolName,
    });
    this.toolsUsedCount.set(toolName, (this.toolsUsedCount.get(toolName) ?? 0) + 1);
    try {
      const result = await this.toolRegistry.execute(toolName, input);
      if (result.success) {
        this.toolSuccessCount++;
        this.taskLedger.completeStep(ledgerStepId, result.output?.slice(0, 300));
      } else {
        this.toolErrorCount++;
        this.taskLedger.failStep(ledgerStepId, result.error || 'todo tool returned error');
      }
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        errorDetails: result.errorDetails,
      };
    } catch (err) {
      this.toolErrorCount++;
      this.taskLedger.failStep(ledgerStepId, err instanceof Error ? err.message : String(err));
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async updateTodoPhaseStatus(
    phase: 'scoping' | 'executing' | 'verifying' | 'reporting',
    status: 'pending' | 'in-progress' | 'completed' | 'blocked',
    notes?: string
  ): Promise<void> {
    const itemId = this.todoPhaseItemIds[phase];
    if (!itemId || !this.config.sessionId) {
      return;
    }
    if (this.todoPhaseStatus[phase] === status) {
      return;
    }

    const result = await this.executeTodoTool('todo_update', {
      sessionId: this.config.sessionId,
      itemId,
      status,
      notes,
    });
    if (result.success) {
      this.todoPhaseStatus[phase] = status;
      return;
    }

    const code = result.errorDetails?.code || '';
    if (code === 'TODO_LIST_NOT_FOUND' || code === 'TODO_ITEM_NOT_FOUND') {
      this.todoSyncEnabled = false;
      this.log(`[Agent] TODO sync disabled after ${code} to avoid repeated failed updates.`);
    }
  }

  private async finalizeTodoSyncOnCompletion(success: boolean, notes: string): Promise<void> {
    await this.todoSyncQueue.catch(() => {});

    if (!this.todoSyncEnabled) {
      return;
    }

    if (success) {
      await this.updateTodoPhaseStatus('reporting', 'completed', notes.slice(0, 180));
    } else {
      await this.updateTodoPhaseStatus('reporting', 'blocked', notes.slice(0, 180));
    }

    if (this.hasTool('todo_get') && this.config.sessionId) {
      await this.executeTodoTool('todo_get', { sessionId: this.config.sessionId });
    }
  }

  private trackDomainTouch(toolName: string, input: Record<string, unknown>): void {
    if (!this.shouldTrackDomainForTool(toolName)) {
      return;
    }

    const candidates = [input.path, input.directory, input.cwd]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    for (const value of candidates) {
      const domain = this.extractTopLevelDomain(value);
      if (domain) {
        this.touchedDomains.add(domain);
      }
    }
  }

  private shouldTrackDomainForTool(toolName: string): boolean {
    return toolName.startsWith('fs_') || toolName.includes('search') || toolName === 'shell_exec';
  }

  private extractTopLevelDomain(pathLike: string): string | null {
    const baseDir = this.sessionRootDir || this.config.workingDir || process.cwd();
    const absolutePath = path.isAbsolute(pathLike)
      ? path.normalize(pathLike)
      : path.normalize(path.resolve(baseDir, pathLike));
    const relative = path.relative(baseDir, absolutePath);

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    const [topLevel] = relative.split(path.sep);
    if (!topLevel || topLevel === '.') {
      return null;
    }

    return topLevel;
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
      const resolvedCwd = this.resolveShellCwd(input);
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
      const resolvedCwd = this.resolveShellCwd(input);
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

  private extractToolErrorCode(result: ToolResult): string | null {
    if (result.errorDetails?.code) {
      return result.errorDetails.code;
    }
    if (result.metadata && typeof result.metadata.errorCode === 'string' && result.metadata.errorCode.trim()) {
      return result.metadata.errorCode;
    }
    const errorText = result.error || '';
    const prefixed = errorText.match(/^([A-Z0-9_]{3,}):/);
    return prefixed?.[1] || null;
  }

  private trackToolOutcome(toolName: string, result: ToolResult, durationMs: number): void {
    const analytics = useAnalytics();
    if (!analytics) {
      return;
    }

    const errorCode = result.success ? null : this.extractToolErrorCode(result);
    void analytics.track(AGENT_ANALYTICS_EVENTS.TOOL_CALLED, {
      toolName,
      success: result.success,
      durationMs,
      errorCode: errorCode ?? undefined,
      retryable: result.errorDetails?.retryable ?? result.metadata?.retryable ?? undefined,
    }).catch((err) => {
      this.log(`[Agent] Failed to emit tool analytics: ${String(err)}`);
    });
  }

  private resolveShellCwd(input: Record<string, unknown>): string {
    const baseDir = this.config.workingDir || process.cwd();
    const requested = typeof input.cwd === 'string' ? input.cwd.trim() : '.';
    if (!requested || requested === '.') {
      return baseDir;
    }
    return path.resolve(baseDir, requested);
  }

  private isRiskyShellCommand(command: string): boolean {
    return /\b(pnpm|npm|yarn)\s+(test|lint|build|qa)\b/i.test(command);
  }

  /**
   * Record tool execution in trace
   */
  private recordToolTrace(
    toolCall: LLMToolCall,
    result: ToolResult,
    iteration: number,
    durationMs: number
  ): void {
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'tool_call',
      data: {
        toolName: toolCall.name,
        input: toolCall.input,
      },
      durationMs,
    });

    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      data: {
        toolName: toolCall.name,
        success: result.success,
        output: result.output,
        error: result.error,
      },
      durationMs: 0,
    });
  }

  /**
   * Create tool result message for LLM
   * Truncates long outputs to prevent token overflow
   *
   * Uses proper OpenAI tool response format:
   * - role: 'tool' (not 'user')
   * - toolCallId: matches the id from the tool_call
   */
  private createToolResultMessage(toolCallId: string, _toolName: string, result: ToolResult, iteration?: number): LLMMessage {
    const MAX_TOOL_OUTPUT_CHARS = 8000; // ~2000 tokens per tool result

    let output = result.success
      ? result.output || 'Success'
      : `Error${result.errorDetails?.code ? ` [${result.errorDetails.code}]` : ''}: ${result.error}`;

    const originalLength = output.length;
    const wasTruncated = originalLength > MAX_TOOL_OUTPUT_CHARS;

    // Truncate if too long
    if (wasTruncated) {
      output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n\n[...output truncated, showing first 8000 chars...]';

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
      this.executionStateMachine.transition('completed', 'success result finalized');
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
              filesCreated: Array.from(this.filesCreated),
              filesModified: Array.from(this.filesModified),
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
        tokensUsed: this.totalTokens,
        durationMs,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
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
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: finalSuccess,
        summary: finalSummary,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration,
        totalTokens: this.totalTokens,
        reflectionCount: this.reflectionCount,
        hypothesisSwitches: this.hypothesisSwitches,
      },
      durationMs: 0,
    });

    await this.finalizeTodoSyncOnCompletion(true, finalSummary);
    await this.emitRunKpis(finalSuccess, finalSummary, iteration, durationMs);

    return {
      success: finalSuccess,
      summary: finalSummary,
      filesCreated: Array.from(this.filesCreated),
      filesModified: Array.from(this.filesModified),
      filesRead: Array.from(this.filesRead),
      iterations: iteration,
      tokensUsed: this.totalTokens,
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
      this.executionStateMachine.transition('failed', 'failure result finalized');
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
        tokensUsed: this.totalTokens,
        durationMs,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
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
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: false,
        summary,
        error,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration,
        totalTokens: this.totalTokens,
        reflectionCount: this.reflectionCount,
        hypothesisSwitches: this.hypothesisSwitches,
      },
      durationMs: 0,
    });

    await this.finalizeTodoSyncOnCompletion(false, error || summary);
    await this.emitRunKpis(false, summary, iteration, durationMs, error || summary);

    return {
      success: false,
      summary,
      filesCreated: Array.from(this.filesCreated),
      filesModified: Array.from(this.filesModified),
      filesRead: Array.from(this.filesRead),
      iterations: iteration,
      tokensUsed: this.totalTokens,
      error: error || summary,
      trace: this.trace,
    };
  }

  /**
   * Create result when agent is stopped by user via requestStop().
   * Waits for the current tool call to finish (never interrupts mid-flight),
   * then saves partial trace and emits agent:end with stopped=true.
   */
  private async createStoppedResult(iteration: number, maxIterations: number): Promise<TaskResult> {
    try {
      this.executionStateMachine.transition('failed', 'stopped by user');
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
        tokensUsed: this.totalTokens,
        durationMs,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
      },
    } as AgentEvent);

    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: { status: 'done', message: summary },
    });

    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: false,
        stopped: true,
        summary,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration - 1,
        totalTokens: this.totalTokens,
        maxIterations,
      },
      durationMs,
    });

    await this.finalizeTodoSyncOnCompletion(false, summary);
    await this.emitRunKpis(false, summary, iteration - 1, durationMs, summary);

    return {
      success: false,
      summary,
      filesCreated: Array.from(this.filesCreated),
      filesModified: Array.from(this.filesModified),
      filesRead: Array.from(this.filesRead),
      iterations: iteration - 1,
      tokensUsed: this.totalTokens,
      error: summary,
      trace: this.trace,
    };
  }

  private async emitRunKpis(
    success: boolean,
    summary: string,
    iterationsUsed: number,
    durationMs: number,
    errorMessage?: string
  ): Promise<void> {
    const analytics = useAnalytics();
    if (!analytics) {
      return;
    }

    const toolCallsTotal = Array.from(this.toolsUsedCount.values()).reduce((sum, count) => sum + count, 0);
    const todoToolCalls = (this.toolsUsedCount.get('todo_create') ?? 0)
      + (this.toolsUsedCount.get('todo_update') ?? 0)
      + (this.toolsUsedCount.get('todo_get') ?? 0);
    const driftDomainCount = this.touchedDomains.size;
    const driftRate = toolCallsTotal > 0
      ? Math.max(0, driftDomainCount - 1) / toolCallsTotal
      : 0;
    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    const iterationBudget = this.currentIterationBudget || this.config.maxIterations || iterationsUsed;
    const phaseDurationsMs = this.executionStateMachine.getPhaseDurationsMs();
    const phaseTransitions = this.executionStateMachine.getTransitions();
    const ledgerSummary = this.taskLedger.getSummary();

    const payload = {
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task: this.currentTask || '',
      success,
      error: errorMessage,
      summaryPreview: summary.slice(0, 300),
      iterationsUsed,
      iterationBudget,
      iterationUtilization: iterationBudget > 0 ? iterationsUsed / iterationBudget : 1,
      tokenBudget: this.currentTokenBudget > 0 ? this.currentTokenBudget : undefined,
      tokenUtilization: this.currentTokenBudget > 0 ? this.totalTokens / this.currentTokenBudget : undefined,
      startTier: this.runStartTier,
      finalTier: this.runFinalTier,
      escalated: this.tierEscalations.length > 0,
      escalationCount: this.tierEscalations.length,
      escalationReasons: this.tierEscalations.map((e) => e.reason),
      escalationPath: this.tierEscalations.map((e) => `${e.from}->${e.to}`),
      durationMs,
      tokensUsed: this.totalTokens,
      toolCallsTotal,
      toolSuccessCount: this.toolSuccessCount,
      toolErrorCount: this.toolErrorCount,
      toolErrorRate: toolCallsTotal > 0 ? this.toolErrorCount / toolCallsTotal : 0,
      todoToolCalls,
      todoUsed: todoToolCalls > 0,
      filesReadCount: this.filesRead.size,
      filesModifiedCount: this.filesModified.size,
      filesCreatedCount: this.filesCreated.size,
      evidenceDensity: iterationsUsed > 0 ? evidenceCount / iterationsUsed : evidenceCount,
      driftDomainCount,
      driftDomains: Array.from(this.touchedDomains),
      driftRate,
      executionPhase: this.executionStateMachine.getCurrent(),
      phaseDurationsMs,
      phaseTransitionCount: phaseTransitions.length,
      phaseTransitions: phaseTransitions.slice(-20),
      ledger: ledgerSummary,
      qualityGate: this.lastQualityGate,
    };

    await this.emitQualityRegressionEvent({
      driftRate,
      evidenceDensity: iterationsUsed > 0 ? evidenceCount / iterationsUsed : evidenceCount,
      toolErrorRate: toolCallsTotal > 0 ? this.toolErrorCount / toolCallsTotal : 0,
      tokensUsed: this.totalTokens,
      iterationsUsed,
      iterationBudget,
      iterationUtilization: iterationBudget > 0 ? iterationsUsed / iterationBudget : 1,
      qualityScore: this.lastQualityGate?.score ?? (success ? 1 : 0),
      qualityGateStatus: this.lastQualityGate?.status ?? 'pass',
    });

    await analytics.track('agent.kpi.run_completed', payload).catch((err) => {
      this.log(`[Agent] Failed to emit KPI analytics: ${err}`);
    });
  }

  private async recordTierEscalation(
    from: LLMTier,
    to: LLMTier,
    reason: string,
    iteration: number
  ): Promise<void> {
    this.tierEscalations.push({ from, to, reason, iteration });

    const analytics = useAnalytics();
    if (!analytics) {
      return;
    }

    await analytics.track(AGENT_ANALYTICS_EVENTS.TIER_ESCALATED, {
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task: this.currentTask || '',
      fromTier: from,
      toTier: to,
      reason,
      iteration,
      escalationCount: this.tierEscalations.length,
    }).catch((err) => {
      this.log(`[Agent] Failed to emit tier escalation analytics: ${err}`);
    });
  }

  private getKpiBaselineKey(): string {
    return `${this.sessionRootDir || this.config.workingDir || 'workspace'}::agent`;
  }

  private async emitQualityRegressionEvent(metrics: {
    driftRate: number;
    evidenceDensity: number;
    toolErrorRate: number;
    tokensUsed: number;
    iterationsUsed: number;
    iterationBudget: number;
    iterationUtilization: number;
    qualityScore: number;
    qualityGateStatus: 'pass' | 'partial';
  }): Promise<void> {
    const analytics = useAnalytics();
    if (!analytics) {
      return;
    }

    let baseline = {
      driftRateEma: metrics.driftRate,
      evidenceDensityEma: metrics.evidenceDensity,
      toolErrorRateEma: metrics.toolErrorRate,
      samples: 0,
      tokenHistory: [] as number[],
      iterationUtilizationHistory: [] as number[],
      qualityScoreHistory: [] as number[],
    };

    const sessionId = this.config.sessionId;
    let sessionManager: SessionManager | null = null;
    if (sessionId && this.sessionRootDir) {
      try {
        sessionManager = new SessionManager(this.sessionRootDir);
        const persisted = await sessionManager.getKpiBaseline(sessionId);
        if (persisted) {
          baseline = {
            driftRateEma: persisted.driftRateEma,
            evidenceDensityEma: persisted.evidenceDensityEma,
            toolErrorRateEma: persisted.toolErrorRateEma,
            samples: persisted.samples,
            tokenHistory: persisted.tokenHistory,
            iterationUtilizationHistory: persisted.iterationUtilizationHistory,
            qualityScoreHistory: persisted.qualityScoreHistory,
          };
        }
      } catch (err) {
        this.log(`[Agent] Failed to read persisted KPI baseline: ${err}`);
      }
    } else {
      const key = this.getKpiBaselineKey();
      baseline = Agent.PROCESS_KPI_BASELINES.get(key) ?? baseline;
    }

    const enoughHistory = baseline.samples >= 3;
    const driftRegressed = enoughHistory && metrics.driftRate > baseline.driftRateEma + 0.08;
    const evidenceRegressed = enoughHistory && metrics.evidenceDensity < baseline.evidenceDensityEma - 0.2;
    const errorRegressed = enoughHistory && metrics.toolErrorRate > baseline.toolErrorRateEma + 0.15;
    const overBudget = metrics.iterationBudget > 0 && metrics.iterationsUsed / metrics.iterationBudget > 0.9;
    const partialGate = metrics.qualityGateStatus === 'partial';

    const regressed = driftRegressed || evidenceRegressed || errorRegressed || (partialGate && overBudget);
    if (regressed) {
      const reasons: string[] = [];
      if (driftRegressed) {reasons.push('drift_rate_regressed');}
      if (evidenceRegressed) {reasons.push('evidence_density_regressed');}
      if (errorRegressed) {reasons.push('tool_error_rate_regressed');}
      if (partialGate && overBudget) {reasons.push('partial_quality_near_budget_limit');}

      await analytics.track('agent.kpi.quality_regression', {
        sessionId: this.config.sessionId,
        agentId: this.agentId,
        task: this.currentTask || '',
        reasons,
        metrics,
        baseline: {
          driftRateEma: baseline.driftRateEma,
          evidenceDensityEma: baseline.evidenceDensityEma,
          toolErrorRateEma: baseline.toolErrorRateEma,
          samples: baseline.samples,
        },
      }).catch((err) => {
        this.log(`[Agent] Failed to emit quality regression analytics: ${err}`);
      });
    }

    const alpha = 0.25;
    const updatedBaseline = {
      driftRateEma: baseline.samples === 0
        ? metrics.driftRate
        : baseline.driftRateEma * (1 - alpha) + metrics.driftRate * alpha,
      evidenceDensityEma: baseline.samples === 0
        ? metrics.evidenceDensity
        : baseline.evidenceDensityEma * (1 - alpha) + metrics.evidenceDensity * alpha,
      toolErrorRateEma: baseline.samples === 0
        ? metrics.toolErrorRate
        : baseline.toolErrorRateEma * (1 - alpha) + metrics.toolErrorRate * alpha,
      samples: baseline.samples + 1,
      tokenHistory: [...baseline.tokenHistory, metrics.tokensUsed].slice(-50),
      iterationUtilizationHistory: [...baseline.iterationUtilizationHistory, metrics.iterationUtilization].slice(-50),
      qualityScoreHistory: [...baseline.qualityScoreHistory, metrics.qualityScore].slice(-50),
    };

    if (sessionManager && sessionId) {
      await sessionManager.updateKpiBaseline(sessionId, () => ({
        version: 1,
        updatedAt: new Date().toISOString(),
        driftRateEma: updatedBaseline.driftRateEma,
        evidenceDensityEma: updatedBaseline.evidenceDensityEma,
        toolErrorRateEma: updatedBaseline.toolErrorRateEma,
        samples: updatedBaseline.samples,
        tokenHistory: updatedBaseline.tokenHistory,
        iterationUtilizationHistory: updatedBaseline.iterationUtilizationHistory,
        qualityScoreHistory: updatedBaseline.qualityScoreHistory,
      })).catch((err) => {
        this.log(`[Agent] Failed to persist KPI baseline: ${err}`);
      });
      return;
    }

    const key = this.getKpiBaselineKey();
    Agent.PROCESS_KPI_BASELINES.set(key, updatedBaseline);
  }

  /**
   * Track file operations
   */
  private trackFileOperation(toolName: string, input: Record<string, unknown>, _result?: unknown): void {
    const filePath = input.path as string | undefined;

    if (!filePath) {
      return;
    }

    if (toolName === 'fs_write') {
      if (!this.filesModified.has(filePath)) {
        this.filesCreated.add(filePath);
      }
    } else if (toolName === 'fs_patch' || toolName === 'fs_edit') {
      this.filesModified.add(filePath);
      this.filesCreated.delete(filePath);
    } else if (toolName === 'fs_read') {
      this.filesRead.add(filePath);
    }
  }

  /**
   * Phase 2: Update progress tracker after each iteration
   */
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
    // Track last 3 tool calls
    this.progressTracker.lastToolCalls.push(toolName);
    if (this.progressTracker.lastToolCalls.length > 3) {
      this.progressTracker.lastToolCalls.shift();
    }

    // Track output sizes
    this.progressTracker.lastOutputSizes.push(outputSize);
    if (this.progressTracker.lastOutputSizes.length > 3) {
      this.progressTracker.lastOutputSizes.shift();
    }

    const previousOutputSize = this.progressTracker.lastOutputSizes.length >= 2
      ? this.progressTracker.lastOutputSizes[this.progressTracker.lastOutputSizes.length - 2] ?? 0
      : 0;
    const outputGrowth = outputSize - previousOutputSize;
    const outputGrowthRatio = previousOutputSize > 0 ? outputSize / previousOutputSize : (outputSize > 0 ? 1 : 0);
    const searchSignalDelta = Math.max(0, input.searchSignalHits - this.progressTracker.lastSearchSignalHits);
    const failedToolDelta = this.progressTracker.lastFailureCount - input.failedToolsThisIteration;
    const repeatedSingleTool = this.progressTracker.lastToolCalls.length >= 3
      && new Set(this.progressTracker.lastToolCalls.slice(-3)).size === 1;

    let progressScore = 0;
    if (input.evidenceDelta > 0) {
      progressScore += 3;
    }
    if (searchSignalDelta > 0) {
      progressScore += 2;
    }
    if (failedToolDelta > 0) {
      progressScore += 2;
    }
    if (outputGrowth >= 300 || outputGrowthRatio >= 1.35) {
      progressScore += 1;
    }
    if (!repeatedSingleTool && this.progressTracker.lastToolCalls.length >= 2) {
      progressScore += 1;
    }

    if (progressScore >= 2) {
      this.progressTracker.iterationsSinceProgress = 0;
      this.progressTracker.lastProgressIteration = input.iteration;
    } else if (progressScore === 1) {
      // Weak but real signal: avoid false "hard stall" and keep momentum.
      this.progressTracker.iterationsSinceProgress = Math.max(0, this.progressTracker.iterationsSinceProgress - 1);
      this.progressTracker.lastProgressIteration = input.iteration;
    } else {
      this.progressTracker.iterationsSinceProgress += 1;
    }

    this.progressTracker.lastFailureCount = input.failedToolsThisIteration;
    this.progressTracker.lastSearchSignalHits = input.searchSignalHits;
  }

  private getEvidenceProgressScore(): number {
    return (
      this.filesRead.size
      + this.filesModified.size * 2
      + this.filesCreated.size * 2
      + this.searchSignalHits
      + this.recentSearchEvidence.length
    );
  }

  private countFailedToolResults(toolResults: LLMMessage[]): number {
    return toolResults.reduce((count, message) => {
      const content = typeof message.content === 'string' ? message.content : '';
      return content.startsWith('Error:') ? count + 1 : count;
    }, 0);
  }

  private shouldTriggerReflection(input: {
    trigger: 'post_tools' | 'before_escalation' | 'before_no_result';
    iteration: number;
    failedToolsThisIteration: number;
    escalationReason?: string;
    force: boolean;
  }): boolean {
    if (input.force || input.trigger !== 'post_tools') {
      return true;
    }

    if (input.iteration <= 1) {
      return input.failedToolsThisIteration > 0;
    }

    if (input.iteration - this.lastReflectionIteration < 2) {
      return false;
    }

    const repeatedSingleTool = this.progressTracker.lastToolCalls.length >= 3
      && new Set(this.progressTracker.lastToolCalls.slice(-3)).size === 1;

    return (
      input.failedToolsThisIteration > 0
      || repeatedSingleTool
      || this.progressTracker.iterationsSinceProgress >= this.progressTracker.stuckThreshold - 1
    );
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
    if (!this.shouldTriggerReflection(input)) {
      return;
    }

    const reflection = await this.generateOperationalReflection(input);
    if (!reflection) {
      return;
    }

    const normalizedHypothesis = reflection.hypothesis.trim().toLowerCase();
    if (normalizedHypothesis && this.lastReflectionHypothesis && normalizedHypothesis !== this.lastReflectionHypothesis) {
      this.hypothesisSwitches += 1;
    }
    if (normalizedHypothesis) {
      this.lastReflectionHypothesis = normalizedHypothesis;
    }
    this.lastReflectionIteration = input.iteration;
    this.reflectionCount += 1;

    const summary = [
      `[Reflection @iter ${input.iteration}] trigger=${input.trigger}; confidence=${reflection.confidence.toFixed(2)}`,
      `Hypothesis: ${reflection.hypothesis}`,
      `Evidence+: ${reflection.evidenceFor}`,
      `Evidence-: ${reflection.evidenceAgainst}`,
      `Next check: ${reflection.nextBestCheck}`,
      `Why: ${reflection.whyThisCheck}`,
    ].join('\n');

    this.emit({
      type: EVENT_TYPE_STATUS_CHANGE,
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      data: {
        status: 'thinking',
        message: `Reflection checkpoint: ${reflection.hypothesis} (conf ${reflection.confidence.toFixed(2)})`,
      },
    });

    messages.push({
      role: 'assistant',
      content: summary,
    });
  }

  private async generateOperationalReflection(input: {
    trigger: 'post_tools' | 'before_escalation' | 'before_no_result';
    iteration: number;
    toolCalls: LLMToolCall[];
    toolResults: LLMMessage[];
    failedToolsThisIteration: number;
    force: boolean;
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
          ? (this.filesRead.size + this.filesModified.size + this.filesCreated.size) / input.iteration
          : 0,
        iterationsUsed: input.iteration,
        isInformationalTask: this.taskIntent !== 'action',
      }),
    });
    if (!llm?.chatWithTools) {
      return null;
    }

    const toolRows = input.toolCalls.slice(-6).map((toolCall) => {
      const result = input.toolResults.find((item) => item.toolCallId === toolCall.id);
      const content = typeof result?.content === 'string' ? result.content.slice(0, 360) : '';
      return `${toolCall.name}: ${content}`;
    });

    const prompt = `Create a short operational reflection checkpoint for an autonomous agent.
Task: ${this.currentTask || ''}
Trigger: ${input.trigger}
Iteration: ${input.iteration}
Failed tools this iteration: ${input.failedToolsThisIteration}
Escalation reason candidate: ${input.escalationReason || 'n/a'}
Recent tool outcomes:
${toolRows.join('\n') || '(none)'}`;

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

  private getRequestedReadSpan(input: Record<string, unknown>): number | null {
    const offset = Number(input.offset);
    const limit = Number(input.limit);
    if (Number.isFinite(limit) && limit > 0) {
      return Math.floor(limit);
    }

    const startLine = Number(input.startLine);
    const endLine = Number(input.endLine);
    if (Number.isFinite(startLine) && Number.isFinite(endLine) && endLine >= startLine) {
      return endLine - startLine + 1;
    }
    if (Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0) {
      return Math.floor(limit);
    }
    return null;
  }

  private registerSmallReadWindow(filePath: string, _span: number): number {
    const current = this.smallReadWindowByPath.get(filePath) ?? 0;
    const updated = current + 1;
    this.smallReadWindowByPath.set(filePath, updated);
    return updated;
  }

  private computeAdaptiveReadLimit(
    filePath: string,
    requestedLimit: number | undefined,
    offset: number
  ): number {
    const knownLines = this.fileTotalLinesByPath.get(filePath);
    const currentAttempts = this.fileReadAttemptsByPath.get(filePath) ?? 0;
    const nextAttempts = currentAttempts + 1;
    this.fileReadAttemptsByPath.set(filePath, nextAttempts);

    if (requestedLimit && requestedLimit >= 120) {
      return Math.min(1000, requestedLimit);
    }

    let baseline = this.currentTier === 'small' ? 180 : this.currentTier === 'medium' ? 300 : 500;

    if (knownLines && knownLines <= this.behaviorPolicy.retrieval.smallFileReadAllThresholdLines) {
      baseline = Math.min(1000, knownLines);
    } else if (knownLines && knownLines >= 3000) {
      baseline = this.currentTier === 'small' ? 280 : this.currentTier === 'medium' ? 650 : 1000;
    } else if (knownLines && knownLines >= 1500) {
      baseline = this.currentTier === 'small' ? 240 : this.currentTier === 'medium' ? 500 : 900;
    }

    // If agent keeps reading same file in slices, widen window progressively.
    if (nextAttempts >= 3) {
      baseline = Math.min(1000, Math.round(baseline * 1.4));
    }
    if (nextAttempts >= 5) {
      baseline = Math.min(1000, Math.round(baseline * 1.6));
    }

    // Near tail reads don't need massive windows.
    if (knownLines && offset > Math.max(1, knownLines - 400)) {
      baseline = Math.min(baseline, 400);
    }

    if (requestedLimit && requestedLimit > 0) {
      return Math.min(1000, Math.max(requestedLimit, baseline));
    }

    return Math.min(1000, baseline);
  }

  private async updateNoResultTracker(
    toolCalls: LLMToolCall[],
    toolResults: LLMMessage[],
    iteration: number
  ): Promise<void> {
    if (toolCalls.length === 0) {
      this.consecutiveNoSignalSearchIterations = 0;
      return;
    }

    const searchCalls = toolCalls.filter((call) =>
      call.name === 'grep_search' || call.name === 'glob_search' || call.name === 'find_definition'
    );
    if (searchCalls.length === 0) {
      this.consecutiveNoSignalSearchIterations = 0;
      return;
    }

    const searchArtifacts = searchCalls.map((call) => {
      const result = toolResults.find((r) => r.toolCallId === call.id);
      return {
        tool: call.name,
        content: (result?.content || '').slice(0, 2000),
      };
    });

    const llmJudgement = await this.assessSearchSignalWithLLM(searchArtifacts);
    if (llmJudgement.snippets.length > 0) {
      for (const snippet of llmJudgement.snippets) {
        if (!this.recentSearchEvidence.includes(snippet)) {
          this.recentSearchEvidence.push(snippet);
        }
      }
      this.recentSearchEvidence = this.recentSearchEvidence.slice(-8);
    }

    const positiveSignalDetected = llmJudgement.signal !== 'none';
    if (positiveSignalDetected) {
      this.searchSignalHits += 1;
      this.lastSignalIteration = iteration;
    }

    const lowSignal = llmJudgement.signal === 'none';
    if (lowSignal) {
      this.consecutiveNoSignalSearchIterations += 1;
    } else {
      this.consecutiveNoSignalSearchIterations = 0;
    }
  }

  private shouldConcludeNoResultEarly(iteration: number): boolean {
    const task = this.currentTask || '';
    if (this.isLikelyActionTask(task)) {
      return false;
    }
    if (!this.isLikelyDiscoveryTask(task)) {
      return false;
    }

    if (iteration < this.behaviorPolicy.noResult.minIterationsBeforeConclusion) {
      return false;
    }

    const maxNoSignal = this.behaviorPolicy.noResult.maxConsecutiveNoSignalSearchByTier[this.currentTier];
    if (this.consecutiveNoSignalSearchIterations < maxNoSignal) {
      return false;
    }

    if (this.searchSignalHits > 0) {
      return false;
    }

    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    return evidenceCount <= 1;
  }

  private isLikelyDiscoveryTask(task: string): boolean {
    if (this.taskIntent) {
      return this.taskIntent === 'discovery';
    }
    return /(find|search|locate|where|which|what exports|usage|symbol|definition|найди|поиск|где|какой|какие|экспорт|используется|определение)/i.test(task);
  }

  private maybeExtendIterationBudget(currentIteration: number, currentBudget: number): number {
    // Only check when approaching the limit
    const remainingIterations = Math.max(0, currentBudget - currentIteration);
    if (remainingIterations > 2) {
      return currentBudget;
    }

    // Extend only if agent is making progress toward the goal — no hard ceiling
    const hasRecentSignal = this.lastSignalIteration > 0 && (currentIteration - this.lastSignalIteration) <= 3;
    const hasRecentProgress = this.progressTracker.lastProgressIteration > 0
      && (currentIteration - this.progressTracker.lastProgressIteration) <= 2;
    const hasProgress = this.progressTracker.iterationsSinceProgress < this.progressTracker.stuckThreshold
      || hasRecentSignal
      || hasRecentProgress;

    if (!hasProgress) {
      return currentBudget;
    }

    return currentBudget + 5;
  }

  private buildNoResultConclusionSummary(): string {
    const searchTools = ['grep_search', 'glob_search', 'find_definition']
      .map((name) => ({ name, count: this.toolsUsedCount.get(name) ?? 0 }))
      .filter((item) => item.count > 0);
    const attempts = searchTools.length > 0
      ? searchTools.map((item) => `${item.name}×${item.count}`).join(', ')
      : 'search tools';

    if (this.recentSearchEvidence.length > 0) {
      const evidence = this.recentSearchEvidence.slice(0, 5).map((item) => `- ${item}`).join('\n');
      return `Partial signal found after repeated search attempts (${attempts}), but evidence was insufficient for a high-confidence final claim.\nObserved matches:\n${evidence}\n\nProvide a narrower symbol/path or expected module to continue with a focused verification pass.`;
    }

    return `Insufficient evidence found after repeated search attempts (${attempts}). I could not locate reliable matches for the requested target in the current workspace scope.`;
  }

  private extractSearchEvidenceSnippets(content: string): string[] {
    if (!content.trim()) {
      return [];
    }

    const snippets: string[] = [];
    const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/[a-z0-9_\-./]+\.(ts|tsx|js|jsx|json|md|py|go|rs|yml|yaml)(:\d+)?/i.test(line)) {
        snippets.push(line.length > 180 ? `${line.slice(0, 177)}...` : line);
      }
      if (snippets.length >= 6) {
        break;
      }
    }

    return snippets;
  }

  /**
   * Phase 2: Detect if agent is stuck in a loop
   */
  private detectStuck(): boolean {
    // Pattern 1: Same 3 tools in a row
    if (this.progressTracker.lastToolCalls.length >= 3) {
      const lastThree = this.progressTracker.lastToolCalls.slice(-3);
      if (new Set(lastThree).size === 1) {
        return true; // Using same tool 3 times consecutively
      }
    }

    // Pattern 2: No progress for threshold iterations
    if (this.progressTracker.iterationsSinceProgress >= this.progressTracker.stuckThreshold) {
      return true; // Output size hasn't grown for 3+ iterations
    }

    return false;
  }

  private evaluateTierEscalationNeed(input: {
    tier: LLMTier;
    iteration: number;
    maxIterations: number;
  }): { shouldEscalate: boolean; reason: string } {
    if (!this.config.enableEscalation || this.config.onAskParent || input.tier === 'large') {
      return { shouldEscalate: false, reason: '' };
    }

    const minIterationsBeforeEscalation = Math.max(3, Math.ceil(input.maxIterations * 0.25));
    if (input.iteration < minIterationsBeforeEscalation) {
      return { shouldEscalate: false, reason: '' };
    }

    const noProgress = this.progressTracker.iterationsSinceProgress >= this.progressTracker.stuckThreshold;
    if (!noProgress) {
      return { shouldEscalate: false, reason: '' };
    }

    const hasRecentSignal = this.lastSignalIteration > 0 && (input.iteration - this.lastSignalIteration) <= 3;
    const hasRecentProgress = this.progressTracker.lastProgressIteration > 0
      && (input.iteration - this.progressTracker.lastProgressIteration) <= 2;
    if (hasRecentSignal || hasRecentProgress) {
      return { shouldEscalate: false, reason: '' };
    }

    const repeatedSingleTool = this.progressTracker.lastToolCalls.length >= 3
      && new Set(this.progressTracker.lastToolCalls.slice(-3)).size === 1;
    if (repeatedSingleTool) {
      return { shouldEscalate: true, reason: 'repeating same tool calls without new signal' };
    }

    const iterationUtilization = input.maxIterations > 0 ? input.iteration / input.maxIterations : 1;
    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    if (iterationUtilization >= 0.45 && evidenceCount <= 2) {
      return { shouldEscalate: true, reason: 'low evidence accumulation and stalled progress' };
    }

    return { shouldEscalate: false, reason: '' };
  }

  /**
   * Validate task completion using LLM
   */
  private async validateTaskCompletion(
    task: string,
    agentResponse?: string,
    iterationsUsed = 0
  ): Promise<{ success: boolean; summary: string }> {
    const historicalChanges = await this.getHistoricalChangesForSimilarTask(task);
    const effectiveModified = new Set<string>([
      ...Array.from(this.filesModified),
      ...historicalChanges.filesModified,
    ]);
    const effectiveCreated = new Set<string>([
      ...Array.from(this.filesCreated),
      ...historicalChanges.filesCreated,
    ]);
    const hasHistoricalFileChanges = historicalChanges.filesCreated.length > 0
      || historicalChanges.filesModified.length > 0;
    const ranVerificationCommands = (this.toolsUsedCount.get('shell_exec') ?? 0) > 0;
    const responseLooksLikeVerification = /(test|tests|vitest|jest|build|lint|passed|success|успеш|пройден|green)/i.test(agentResponse || '');

    // Read content of modified/created files for validation
    let fileContents = '';
    if (effectiveModified.size > 0 || effectiveCreated.size > 0) {
      const filesToCheck = [
        ...Array.from(effectiveModified),
        ...Array.from(effectiveCreated),
      ].slice(0, 3);

      for (const file of filesToCheck) {
        try {
           
          const result = await this.toolRegistry.execute('fs_read', {
            path: file,
          });
          if (result.success && result.output) {
            fileContents += `\n--- ${file} ---\n${result.output.slice(0, 1000)}\n`;
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // For informational/research tasks, return the agent response directly as summary
    // This includes questions (what/how/why) AND research verbs (analyze/scan/inspect/review/identify/check)
    const isInformationalTask = this.taskIntent ? this.taskIntent !== 'action' : !this.isLikelyActionTask(task);

    const evidenceCount = this.filesRead.size + this.filesModified.size + this.filesCreated.size;
    const hasFileChanges = effectiveCreated.size > 0 || effectiveModified.size > 0;
    const evidenceDensity = iterationsUsed > 0 ? evidenceCount / iterationsUsed : evidenceCount;
    const searchAttempts = (this.toolsUsedCount.get('grep_search') ?? 0)
      + (this.toolsUsedCount.get('glob_search') ?? 0)
      + (this.toolsUsedCount.get('find_definition') ?? 0);
    const looksLikeNoResultConclusion = /(not found|не найден|no matches|no results|не удалось найти|не содержит)/i.test(agentResponse || '');
    // Require substantial answer with evidence (file paths, code blocks, or technical details)
    const hasEvidence = /\.(ts|js|tsx|jsx|md|json|py|go|rs|yaml|yml)|\/[a-z]|```|:\d+/.test(agentResponse || '');
    if (
      isInformationalTask
      && agentResponse
      && agentResponse.trim().length >= this.behaviorPolicy.evidence.minInformationalResponseChars
      && hasEvidence
      && (
        this.filesRead.size >= this.behaviorPolicy.evidence.minFilesReadForInformational
        || evidenceDensity >= this.behaviorPolicy.evidence.minEvidenceDensityForInformational
        || this.searchSignalHits > 0
        || this.recentSearchEvidence.length > 0
      )
    ) {
      // For questions, the agent's response IS the answer - use it directly
      return {
        success: true,
        summary: agentResponse,
      };
    }

    if (isInformationalTask && agentResponse && looksLikeNoResultConclusion && searchAttempts >= 2) {
      return {
        success: true,
        summary: agentResponse,
      };
    }

    const llmTier = this.chooseSmartTier('taskValidation', {
      task,
      isInformationalTask,
      evidenceDensity,
      iterationsUsed,
    });
    const llm = useLLM({ tier: llmTier });

    const prompt = `You are validating if an agent task was successfully completed.

**Original Task:** ${task}

**Files Created (current run):** ${Array.from(this.filesCreated).join(', ') || 'None'}
**Files Modified (current run):** ${Array.from(this.filesModified).join(', ') || 'None'}
**Files Created (including prior matching runs):** ${Array.from(effectiveCreated).join(', ') || 'None'}
**Files Modified (including prior matching runs):** ${Array.from(effectiveModified).join(', ') || 'None'}
**Historical matching runs with file changes:** ${historicalChanges.matchingRunCount}
**Verification commands in current run:** ${ranVerificationCommands ? 'Yes' : 'No'}
**Files Read:** ${Array.from(this.filesRead).join(', ') || 'None'}

**Modified/Created Files Content:**${fileContents || '\n(No files to show)'}

${agentResponse ? `**Agent Response:**\n${agentResponse}\n` : ''}

**Validation Rules:**

1. **For informational/question tasks** (starting with "What", "How", "Why", "Explain", "Tell me", etc.):
   - SUCCESS only if response includes concrete evidence from current run.
   - Require at least one concrete reference (file path/symbol/line/code detail) grounded in tool outputs.
   - If response is generic or not evidence-backed, mark as FAILED.

2. **For action tasks** (create, edit, delete, run, etc.):
   - SUCCESS if appropriate files were created/modified/read.
   - IMPORTANT for retries: if current run mostly verifies/tests but prior matching runs already changed files, this can still be SUCCESS when verification evidence exists.
   - Example: "Create file.txt" → file.txt created = SUCCESS

IMPORTANT: Do NOT mark question tasks as success only because text exists. Evidence-grounded answer is required.

**CRITICAL for summary field:**
- For research/informational tasks: Include ACTUAL FINDINGS - specific file paths, package names, code details discovered
- For action tasks: Describe what was done specifically
- NEVER write meta-descriptions like "The agent successfully provided..." - include the actual discovered content
- If Agent Response exists, extract and include the key information from it`;

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      if (llm.chatWithTools) {
        const response = await llm.chatWithTools(
          [{ role: 'user', content: prompt }],
          {
            temperature: 0,
            tools: [
              {
                name: 'set_validation_result',
                description: 'Set final validation result and summary.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    summary: { type: 'string' },
                  },
                  required: ['success', 'summary'],
                },
              },
            ],
          }
        );
        const call = response.toolCalls?.find((tc) => tc.name === 'set_validation_result');
        const input = (call?.input ?? {}) as { success?: boolean; summary?: string };
        if (typeof input.success === 'boolean' && typeof input.summary === 'string' && input.summary.trim()) {
          if (
            !input.success
            && hasHistoricalFileChanges
            && this.filesCreated.size === 0
            && this.filesModified.size === 0
            && (ranVerificationCommands || responseLooksLikeVerification)
          ) {
            return {
              success: true,
              summary: `Verified retry succeeded using artifacts from prior run(s): ${input.summary}`,
            };
          }
          return {
            success: input.success,
            summary: input.summary,
          };
        }
      } else {
        const response = await llm.complete(`${prompt}\n\nReturn concise verdict and summary.`, {
          temperature: 0,
        });
        const content = response.content || '';
        if (content.trim().length > 0) {
          return {
            success: hasFileChanges || hasEvidence || looksLikeNoResultConclusion,
            summary: content.trim().slice(0, 1200),
          };
        }
      }
    } catch (error) {
      this.log(`⚠️  Validation error: ${error}`);
    }

    // Fallback: only file changes count as concrete success for non-informational tasks

    return {
      success: hasFileChanges || (
        isInformationalTask
        && (
          hasEvidence
          || looksLikeNoResultConclusion
          || this.searchSignalHits > 0
          || this.recentSearchEvidence.length > 0
        )
      ),
      summary: hasFileChanges
        ? `Modified ${effectiveModified.size} file(s), created ${effectiveCreated.size} file(s)`
        : agentResponse?.slice(0, 200) || 'Task did not produce concrete results',
    };
  }

  private async getHistoricalChangesForSimilarTask(task: string): Promise<{
    filesCreated: string[];
    filesModified: string[];
    matchingRunCount: number;
  }> {
    if (!this.config.sessionId || !this.sessionRootDir) {
      return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
    }

    try {
      const sessionManager = new SessionManager(this.sessionRootDir);
      const events = await sessionManager.getSessionEvents(this.config.sessionId, {
        types: ['agent:start', 'agent:end'],
      });
      if (events.length === 0) {
        return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
      }

      const normalizeTask = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
      const currentTaskNorm = normalizeTask(task);
      const taskByAgentId = new Map<string, string>();

      for (const event of events) {
        if (event.type !== 'agent:start' || event.parentAgentId || !event.agentId) {
          continue;
        }
        const candidate = typeof event.data?.task === 'string' ? event.data.task : '';
        if (candidate.trim()) {
          taskByAgentId.set(event.agentId, candidate);
        }
      }

      const filesCreated = new Set<string>();
      const filesModified = new Set<string>();
      let matchingRunCount = 0;

      for (const event of events) {
        if (event.type !== 'agent:end' || event.parentAgentId || !event.agentId) {
          continue;
        }
        if (event.agentId === this.agentId) {
          continue;
        }
        const priorTask = taskByAgentId.get(event.agentId);
        if (!priorTask || normalizeTask(priorTask) !== currentTaskNorm) {
          continue;
        }

        const created = Array.isArray(event.data?.filesCreated) ? event.data.filesCreated : [];
        const modified = Array.isArray(event.data?.filesModified) ? event.data.filesModified : [];
        if (created.length === 0 && modified.length === 0) {
          continue;
        }

        matchingRunCount += 1;
        for (const file of created) {
          if (typeof file === 'string' && file.trim()) {
            filesCreated.add(file);
          }
        }
        for (const file of modified) {
          if (typeof file === 'string' && file.trim()) {
            filesModified.add(file);
          }
        }
      }

      return {
        filesCreated: Array.from(filesCreated),
        filesModified: Array.from(filesModified),
        matchingRunCount,
      };
    } catch {
      return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
    }
  }

  /**
   * Load project-specific agent instructions from AGENT.md or similar files
   * Scans working directory for instruction files in priority order
   */
  private loadProjectInstructions(): string | null {
    const workingDir = this.config.workingDir || process.cwd();

    for (const fileName of INSTRUCTION_FILE_NAMES) {
      const filePath = path.join(workingDir, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.trim().length > 0) {
            return content;
          }
        }
      } catch {
        // Ignore read errors, try next file
      }
    }

    return null;
  }

  /**
   * Build system prompt with memory context and project instructions
   */
  private async buildSystemPrompt(): Promise<string> {
    const responseMode = (
      this.config as unknown as { responseMode?: 'auto' | 'brief' | 'deep' }
    ).responseMode ?? 'auto';
    let basePrompt = `You are an autonomous software engineering agent. You execute tasks end-to-end: research, implement, verify.

# Core rules

- NEVER answer from memory. Search codebase first, report only what you found in files.
- Read files before editing. Understand existing code before modifying.
- Verify your work. After editing, read the file back to confirm changes applied correctly.
- Prefer editing existing files over creating new ones.
- When stuck, try a different approach. Don't repeat the same failed action.

# Response quality policy

- Response mode: ${responseMode}
- NEVER pad answer with generic statements. Prefer concrete facts from files/tools.
- If confidence is limited, explicitly state uncertainty and what to verify next.

Formatting by mode:
- auto: choose format by question complexity.
  - simple factual question -> concise direct answer (no forced long template)
  - architecture/comparison/plan/debug question -> structured answer with sections
- brief: concise answer by default, only essential points
- deep: thorough structured answer with:
  1) Key findings
  2) Evidence (files/paths or tool outputs)
  3) Gaps/uncertainties
  4) Recommended next checks

For auto mode complexity detection:
- Treat as complex if request includes architecture/design/tradeoffs/comparison/plan/root-cause/migration/refactor,
- or if it references multiple components/subsystems,
- or if correctness/risk implications are high.
- Otherwise keep answer short and direct.

# Public reasoning traces (UI-visible)
- Do NOT reveal private chain-of-thought. Keep internal reasoning private.
- When calling tools, provide a short PUBLIC rationale first (1-2 sentences):
  - what needs to be verified,
  - why this tool helps,
  - what result is expected.
- Keep rationale concise and factual; these lines are shown in the UI between tool steps.

# Conversation continuity
- When conversation history is present, treat follow-up questions IN CONTEXT of previous turns.
- Example: if user asked about one module/repository and then asks "what modules are there?", stay in the same scope first.
- For follow-ups like "deeper/details/подробнее/глубже", first deepen the SAME files/packages from the previous answer.
- Do NOT jump to a different top-level repo/package unless the user explicitly asks, or current scope has no relevant evidence.
- ALWAYS match the user's language. If user writes in Russian, answer in Russian. If in English, answer in English.
- Reference previous findings when relevant — don't repeat the same searches.
- For simple directory listing questions ("what's in folder X?"), use fs_list or glob_search — not grep_search.

# Scope strategy (no hard lock)
- Do NOT assume global search is needed for every task.
- If task appears local to one package/folder, first confirm local scope with fs_list/glob_search and continue there.
- Keep scope flexible: narrow when evidence supports it, widen only if local scope has insufficient evidence.
- Avoid cross-repo/package drift without explicit user request.

# Retrieval policy
- Avoid repetitive tiny fs_read slices. Prefer anchor-based reads with meaningful windows.
- If file is small, read it fully instead of crawling line-by-line.
- If repeated search passes produce no evidence, converge early: report what was checked and what remains uncertain.

# Completeness protocol (for non-trivial analysis/audit tasks)
- Before final report, run a short coverage pass:
  1) primary symbols/entities from task text,
  2) related synonyms/aliases,
  3) failure/error variants (codes, keywords, provider-specific terms when relevant).
- Do not stop after first hit when task asks for architecture/audit overview. Cross-check neighboring components (imports, callees, adjacent modules) to avoid missing major parts.
- Keep findings categorized. Example for reliability audits: separate "LLM/provider-specific handling" from "generic infra/shell timeouts".
- If something was not found, explicitly list what patterns were tried before concluding "not found".

# Available tools

## Search & Discovery
- **find_definition** — find where a class/function/interface/type is defined. USE THIS FIRST for lookup queries.
- **grep_search** — search for exact text or regex in file contents. Use for: imports, error messages, string patterns. Excludes node_modules/dist/.git by default; pass exclude=[] to search everywhere.
- **glob_search** — find files by name pattern. Glob syntax: "*.ts", "*controller*", "src/**/*.tsx". NOT bare words. Same default excludes as grep_search.
- **code_stats** — count lines/files by extension for a DIRECTORY scope. Do not use as proof for single-file line counts.

## File Operations
- **fs_read** — read file contents (with line numbers and metadata). ALWAYS read before editing.
- **fs_write** — create new file or overwrite existing (use for new files).
- **fs_patch** — replace a range of lines in existing file. Requires fs_read first. Line numbers are 1-indexed, inclusive.
- **fs_list** — list directory contents.
- **mass_replace** — batch find-and-replace across files. Use dryRun first to preview. Great for renaming across codebase.
- Prefer primary source files over generated artifacts (dist/build/minified/backup) unless user explicitly asks for those artifacts.

Tool semantics guardrails:
- If user asks "how many lines in file X", use **fs_read(path=X)** and cite metadata.totalLines (or direct file content window evidence).
- If user asks "how many lines in folder/package", use **code_stats(directory=...)**.
- Do not present directory-level totals as file-level facts.

## Execution
- **shell_exec** — run shell commands (build, test, lint). Use to verify your changes work.
  - Always be explicit about execution scope in monorepos: prefer package-local runs via cwd/filters before workspace-wide commands.
  - Before running test/lint/build/qa, confirm current working directory and ensure it matches the target package.

## Progress tracking
- **todo_create** / **todo_update** / **todo_get** — track multi-step tasks. Create a checklist, mark items done.

## Memory
- **memory_get** — retrieve stored preferences and context.
- **memory_finding** — store important discoveries with confidence level.
- **memory_blocker** — record blockers you can't resolve.

## Finishing
- **report** — report your answer/result. Include evidence (file paths, code). Set confidence 0.0-1.0.

# Workflow patterns

## For research tasks (what/how/where questions):
1. Search: find_definition or grep_search to locate relevant code
2. Read: fs_read the files you found — get actual content, not just snippets
3. Analyze: understand the code structure and relationships
4. Report: report with file paths, code snippets, confidence

## For edit tasks (create/modify/fix/add/refactor):
1. Understand: read the target file and its surroundings first
2. Plan: identify exactly what needs to change
3. Edit: fs_patch for existing files, fs_write for new files
4. Verify: fs_read the edited file to confirm changes are correct
5. Test: shell_exec to run build/test if applicable
6. Report: report with files changed and verification results

## Progress discipline for 3+ step tasks:
1. In first 1-2 iterations, create todo list with todo_create (3-7 concrete items).
2. After each completed action block, mark item(s) with todo_update.
3. Before final report, call todo_get and ensure all applicable items are done.
4. If task is truly trivial (1-2 steps), skip todo tools and finish directly.

## When stuck:
- Try a different search approach (grep vs find_definition vs glob)
- Read surrounding files for context
- If truly blocked, report partial findings with low confidence — a partial answer beats an infinite loop
- For routine tasks, aim to finish in ~3-10 meaningful steps. Avoid long exploratory loops once enough evidence is gathered.
`;

    // Add delegation section only for main agents (sub-agents don't have spawn_agent)
    if (!this.config.parentAgentId) {
      basePrompt += `
## Delegation
- **spawn_agent** — spawn a sub-agent for a subtask. The sub-agent works independently with its own iteration loop and returns the result. Use for: research in a different directory, isolated fixes, or multi-part analysis. Parameters: task (required string — be specific, sub-agent has no context), maxIterations (default 10), directory (optional, relative path for sub-agent workingDir).

## For complex multi-part tasks:
1. Break down: identify independent subtasks
2. Delegate: use spawn_agent for each subtask (sub-agents work independently)
3. Combine: merge sub-agent results into a unified answer
4. Report: report the combined findings
`;
    }

    // Add project-specific instructions from CLAUDE.md / AGENT.md (truncated to prevent overflow)
    const projectInstructions = this.loadProjectInstructions();
    if (projectInstructions) {
      const MAX_INSTRUCTIONS_CHARS = 12000; // ~3000 tokens
      const truncated = projectInstructions.length > MAX_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n\n[...instructions truncated...]'
        : projectInstructions;
      basePrompt += `\n\n**Project Instructions:**\n${truncated}`;
    }

    // Add memory context if available (already token-limited internally)
    // Prefer structured memory when supported (includes corrections, last answer, constraints).
    if (this.memory) {
      let memoryContext = '';
      if (typeof (this.memory as { getStructuredContext?: (maxTokens?: number) => Promise<string> }).getStructuredContext === 'function') {
        memoryContext = await (this.memory as { getStructuredContext: (maxTokens?: number) => Promise<string> }).getStructuredContext(2500);
      } else {
        memoryContext = await this.memory.getContext(2000);
      }
      if (memoryContext.trim().length > 0) {
        basePrompt += `\n\n**Previous Context from Memory:**\n${memoryContext}`;
      }

      // Check if there's an original user task in memory (from parent agent)
      // Parent extracts structured context ONCE, sub-agent just reads it
      const recentMemories = await this.memory.getRecent(20);
      const originalTaskEntry = recentMemories.find(
        (entry) => entry.metadata?.isOriginalUserTask === true
      );

      if (originalTaskEntry && this.currentTask !== originalTaskEntry.content) {
        // Read structured context extracted by parent agent
        const globalContext = originalTaskEntry.metadata?.globalContext;

        basePrompt += `\n\n**⚠️ IMPORTANT CONTEXT - Original User Task:**\n${originalTaskEntry.content}\n`;
        basePrompt += `\n**Your Current Subtask:**\n${this.currentTask}\n`;

        if (globalContext?.targetDirectory) {
          basePrompt += `\n**🎯 CRITICAL: Target Directory**\n`;
          basePrompt += `All files must be created in: ${globalContext.targetDirectory}\n`;
          basePrompt += `Do NOT write files to current directory unless explicitly required!\n`;
        }

        if (globalContext?.constraints && globalContext.constraints.length > 0) {
          basePrompt += `\n**🚨 Constraints:**\n`;
          globalContext.constraints.forEach((c) => {
            basePrompt += `- ${c}\n`;
          });
        }

        if (globalContext?.requirements && globalContext.requirements.length > 0) {
          basePrompt += `\n**📋 Requirements:**\n`;
          globalContext.requirements.forEach((r) => {
            basePrompt += `- ${r}\n`;
          });
        }
      }
    }

    // Keep a lightweight continuity note in system prompt.
    // Full session history and trace context are injected via messages in executeWithTier.
    if (this.config.sessionId && this.sessionRootDir) {
      basePrompt += '\n\n# Session continuity\nUse previous turns already present in conversation messages as the primary context.\nDo not restate or duplicate long history from memory when it is already in messages.';
    }

    const workspaceMapPrompt = this.buildWorkspaceDiscoveryPrompt();
    if (workspaceMapPrompt) {
      basePrompt += `\n\n${workspaceMapPrompt}`;
    }

    return basePrompt;
  }

  /**
   * Build cache key for tool call
   * Normalizes input to ensure consistent keys (Phase 1, Step 1.4)
   */
  private buildCacheKey(toolName: string, input: Record<string, unknown>): string {
    // Sort keys for consistent hashing
    const sortedInput = Object.keys(input)
      .sort()
      .reduce((acc, key) => {
        acc[key] = input[key];
        return acc;
      }, {} as Record<string, unknown>);

    return JSON.stringify({ name: toolName, input: sortedInput });
  }

  /**
   * Track tool calls and detect loops.
   * Returns true if agent is stuck in a loop (same calls repeating).
   */
  private detectLoop(toolCalls: Array<{ name: string; arguments: string }>): boolean {
    // Build signature for this iteration's tool calls
    const sig = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).sort().join('|');
    this.recentToolCalls.push(sig);

    // Keep last 6 iterations
    if (this.recentToolCalls.length > 6) {
      this.recentToolCalls.shift();
    }

    // Check if last 3 iterations have identical tool calls
    if (this.recentToolCalls.length >= 3) {
      const last3 = this.recentToolCalls.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get cached result if valid (not expired) (Phase 1, Step 1.4)
   */
  private getCachedResult(cacheKey: string): ToolResult | null {
    const cached = this.toolResultCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    const age = Date.now() - cached.timestamp;
    if (age > Agent.CACHE_TTL_MS) {
      this.toolResultCache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  /**
   * Cache tool result (Phase 1, Step 1.4)
   */
  private cacheResult(cacheKey: string, result: ToolResult): void {
    this.toolResultCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Estimate time saved by cache hit (for logging) (Phase 1, Step 1.4)
   */
  private estimateSavedTimeMs(toolName: string): number {
    const estimates: Record<string, number> = {
      fs_read: 50,
      grep_search: 200,
      glob_search: 150,
      shell_exec: 500,
    };
    return estimates[toolName] ?? 100;
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
   * Record trace entry
   */
  private recordTrace(entry: TraceEntry): void {
    this.trace.push(entry);
    if (this.tracer) {
      this.tracer.trace(entry);
    }
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
