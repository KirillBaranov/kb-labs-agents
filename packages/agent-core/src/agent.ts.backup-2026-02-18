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
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import {
  useLLM,
  useLogger,
  useAnalytics,
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

/**
 * Tool execution result
 */
interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
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
import {
  createContextRetrieveTool,
  executeContextRetrieve,
  formatContextRetrieveResult,
  type ContextRetrieveInput,
} from './tools/context-retrieve.js';
import { FileChangeTracker } from './history/file-change-tracker.js';
import { SnapshotStorage } from './history/snapshot-storage.js';
import { ConflictDetector } from './history/conflict-detector.js';
import { ConflictResolver } from './history/conflict-resolver.js';
import { DEFAULT_FILE_HISTORY_CONFIG } from '@kb-labs/agent-contracts';

/**
 * Default instruction file names to scan (in order of priority)
 */
const INSTRUCTION_FILE_NAMES = ['AGENT.md', 'KB_AGENT.md', '.agent.md'];

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
  private startTimestamp = ''; // ISO string for startedAt in agent:end events

  /** Unique ID for this agent instance (for event correlation) */
  public readonly agentId: string;

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

  /**
   * Phase 2: Progress tracking to detect when agent is stuck
   * Automatically triggers ask_orchestrator when stuck patterns detected
   */
  private progressTracker = {
    lastToolCalls: [] as string[], // Last 3 tool calls
    lastOutputSizes: [] as number[], // Output sizes to detect if gaining information
    iterationsSinceProgress: 0,
    stuckThreshold: 3, // Iterations before considering stuck
  };

  /**
   * Context optimization components (Phase 4: Integration)
   */
  private contextFilter: ContextFilter;
  private smartSummarizer: SmartSummarizer;
  private cachedSystemPrompt?: string;
  private cachedTaskMessage?: string;

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

    // Generate unique ID for this agent instance
    this.agentId = config.agentId || generateAgentId();

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
      // TypeScript doesn't see these new fields yet, so use type assertion
      (context as any).fileChangeTracker = this.fileChangeTracker;
      (context as any).agentId = this.agentId;
    } catch (error) {
      const logger = useLogger();
      // Non-critical: if tracker initialization fails, agent still works
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.warn('[Agent] Failed to initialize FileChangeTracker:', { error: errorMessage });
    }

    // Initialize context optimization (Phase 4)
    this.contextFilter = new ContextFilter({
      maxOutputLength: 500,
      slidingWindowSize: 5,
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
    if (!this.config.enableEscalation) {
      return this.executeWithTier(task, this.config.tier || 'small');
    }

    // Tier escalation enabled
    const tiers: LLMTier[] = ['small', 'medium', 'large'];
    const startTierIndex = tiers.indexOf(this.config.tier || 'small');

    for (let i = startTierIndex; i < tiers.length; i++) {
      const tier = tiers[i]!;
      this.log(`\n🎯 Trying with tier: ${tier}`);

      try {
         
        const result = await this.executeWithTier(task, tier);
        if (result.success) {
          if (tier !== this.config.tier) {
            this.log(`✅ Succeeded after escalation to ${tier} tier`);
          }
          return result;
        }

        if (i < tiers.length - 1) {
          this.log(
            `⚠️  Failed with ${tier} tier, escalating to ${tiers[i + 1]}...`
          );
        }
      } catch (error) {
        this.log(`❌ Error with ${tier} tier: ${error}`);
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
    this.logTaskHeader(task, tier);
    this.resetState();
    this.currentTask = task;
    this.startTime = Date.now();
    this.startTimestamp = new Date().toISOString();

    // Emit agent:start event
    this.emit({
      type: 'agent:start',
      timestamp: this.startTimestamp,
      sessionId: this.config.sessionId,
      data: {
        task,
        tier,
        maxIterations: this.config.maxIterations,
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
    // Uses only agent:end summaries (truncated to 500 chars) to prevent token overflow
    if (this.config.sessionId && this.config.workingDir) {
      const sessionManager = new SessionManager(this.config.workingDir);
      const previousTurns = await sessionManager.getConversationHistory(this.config.sessionId, 3);

      if (previousTurns.length > 0) {
        this.log(`📜 Loaded ${previousTurns.length} previous turn(s) from session history`);

        for (const turn of previousTurns) {
          // Ensure non-empty content for all messages
          if (turn.userTask?.trim()) {
            messages.push({ role: 'user', content: turn.userTask });
          }
          if (turn.agentResponse?.trim()) {
            messages.push({ role: 'assistant', content: turn.agentResponse });
          }
        }
      }
    }

    // Add current task
    messages.push({
      role: 'user',
      content: task,
    });

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

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      this.logIterationHeader(iteration);

      const iterationStartTimestamp = new Date().toISOString();

      // Emit iteration:start
      this.emit({
        type: 'iteration:start',
        timestamp: iterationStartTimestamp,
        sessionId: this.config.sessionId,
        data: {
          iteration,
          maxIterations: this.config.maxIterations,
        },
      });

      try {
        // On last iteration, only allow report_to_orchestrator tool
        const isLastIteration = iteration === this.config.maxIterations;
        const beforeTools = tools.map(t => t.name);
        const availableTools = isLastIteration
          ? tools.filter(t => t.name === 'report_to_orchestrator')
          : tools;
        const afterTools = availableTools.map(t => t.name);

        // Trace tool:filter event if tools were filtered
        if (this.tracer && isLastIteration && beforeTools.length !== afterTools.length) {
          const filtered = beforeTools
            .filter(name => !afterTools.includes(name))
            .map(name => ({
              name,
              reason: 'last_iteration' as const,
              explanation: 'Only report_to_orchestrator allowed on last iteration',
            }));

          this.tracer.trace(
            createToolFilterEvent({
              iteration,
              beforeTools,
              afterTools,
              filtered,
            })
          );
        }

        // Trace iteration:detail event
        if (this.tracer) {
          const toolNames = availableTools.map((t) => t.name);
          this.tracer.trace(
            createIterationDetailEvent({
              iteration,
              maxIterations: this.config.maxIterations,
              mode: 'auto', // TODO: extract from config
              temperature: this.config.temperature,
              availableTools: toolNames,
              messages,
              totalTokens: this.totalTokens,
            })
          );
        }

        // Add iteration context message for last iteration
        if (isLastIteration) {
          const beforeMessagesCount = messages.length;
          const lastIterationMessage = `🛑 LAST ITERATION (${iteration}/${this.config.maxIterations}) - You MUST call report_to_orchestrator NOW with your synthesized answer from all information you gathered. This is your ONLY chance to report findings!`;

          messages.push({
            role: 'user',
            content: lastIterationMessage,
          });

          // Trace prompt:diff event to debug prompt modifications
          if (this.tracer) {
            this.tracer.trace(
              createPromptDiffEvent({
                iteration,
                messagesAdded: 1,
                messagesRemoved: 0,
                totalMessages: messages.length,
                tokensBefore: beforeMessagesCount * 100,
                tokensAfter: messages.length * 100,
                changes: [
                  {
                    type: 'added',
                    role: 'user',
                    contentPreview: lastIterationMessage.slice(0, 100),
                    index: messages.length - 1,
                  },
                ],
              })
            );
          }
        }

        // AUTO-REFLECTION: Force reflection every 3 iterations (independent of LLM choice)
        // This ensures agents assess progress regularly, even if LLM prefers simpler tools
        if (iteration > 0 && iteration % 3 === 0 && iteration < this.config.maxIterations - 1) {
          this.log(`\n🤔 Auto-reflection triggered (iteration ${iteration}/${this.config.maxIterations})\n`);

          // Build reflection prompt with verification awareness
          const reflectionPrompt = `You are on iteration ${iteration} of ${this.config.maxIterations}. Review your progress and decide whether to continue or report completion.

Call reflect_on_progress with:
- findings_summary: Brief summary of what you've accomplished (2-3 sentences)
- confidence: Your confidence that the task is COMPLETE (0.0 = no progress, 1.0 = fully done)
- questions_remaining: What aspects are still incomplete (empty array if all done)
- should_continue: true if more work needed, false if ready to report
- reason: Explanation for your decision (1 sentence)
- evidence_of_completion: CONCRETE evidence of completion with VERIFICATION RESULTS

**Evidence Requirements:**

For RESEARCH tasks:
- List sources/files you read
- Quote key findings with file:line references
- Example: "Found AuthService in src/auth/service.ts:15-45, implements OAuth2 with login(), validate() methods"

For IMPLEMENTATION tasks:
- List files created/modified
- INCLUDE VERIFICATION RESULTS (critical!)
  * Created code → did you run tests? Include results: "npm test: 18/18 passing" or "npm test: 2 failed, 16 passed"
  * Created API → did you test endpoints? Include: "curl /health → 200 OK" or "Port conflict: EADDRINUSE 3000"
  * Created deployment → did you verify? Include: "docker build successful" or "Build failed: missing dependency"
- Example: "Created 15 files including package.json, src/index.ts. Ran npm install (success), npm test (2 failed: validation.test.js, auth.test.js)"

**Confidence Assessment (be honest!):**
- HIGH (≥0.8): Work done AND verified working (tests pass, service healthy, etc.)
- MEDIUM (0.5-0.7): Work done BUT verification failed OR not verified yet
- LOW (<0.5): Work incomplete OR verification blocked OR don't know how to verify

**Decision Logic:**
- Verification PASSED → should_continue: false (ready to report success)
- Verification FAILED but you can fix → should_continue: true (retry, explain what you'll fix)
- Verification FAILED multiple times → should_continue: false (report partial result, let orchestrator decide)
- Haven't verified yet → should_continue: true (verify first before claiming completion)

**CRITICAL:** Don't claim high confidence without verification proof. "Created files" ≠ "Working solution".`;

          messages.push({
            role: 'user',
            content: reflectionPrompt,
          });

          // Call LLM to get reflection (only reflect_on_progress tool allowed)
          const reflectionTools = tools.filter(t => t.name === 'reflect_on_progress');

          // Phase 4: Use lean context for reflection too
           
          const reflectionResponse = await this.callLLMWithTools(
            llm,
            messages,
            reflectionTools,
            tier,
            iteration,
            this.cachedSystemPrompt,
            this.cachedTaskMessage
          );

          messages.push({
            role: 'assistant',
            content: reflectionResponse.content || '[Reflecting...]',
            toolCalls: reflectionResponse.toolCalls,
          });

          // If reflection includes tool call, execute it
          if (reflectionResponse.toolCalls && reflectionResponse.toolCalls.length > 0) {
             
            const reflectionToolResults = await this.executeToolCalls(reflectionResponse.toolCalls, iteration);

            // Add tool results to messages
            messages.push(...reflectionToolResults);

            // Check if should auto-report
            for (const toolResultMsg of reflectionToolResults) {
              const metadata = toolResultMsg.metadata as { shouldAutoReport?: boolean; reflection?: { findingsSummary: string; confidence: number } } | undefined;

              if (metadata?.shouldAutoReport && metadata?.reflection) {
                this.log(`\n🤔 Auto-reflection triggered early exit (confidence: ${metadata.reflection.confidence.toFixed(2)})\n`);

                 
                return await this.createSuccessResult({
                  success: true,
                  summary: metadata.reflection.findingsSummary,
                }, iteration);
              }
            }
          }
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
          const reachedMaxIterations = iteration >= this.config.maxIterations;
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
              iterationsRemaining: this.config.maxIterations - iteration,
              timeElapsedMs: Date.now() - this.startTime,
              toolCallsInLast3Iterations: response.toolCalls?.length || 0,
            })
          );
        }

        // Check if done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // On last iteration, FORCE synthesis if LLM didn't call report_to_orchestrator
          if (isLastIteration) {
            // Emit forced synthesis event
            this.emit({
              type: 'synthesis:forced',
              timestamp: new Date().toISOString(),
              sessionId: this.config.sessionId,
              data: {
                iteration,
                reason: 'Last iteration reached without tool call',
                messagesCount: messages.length,
              },
            } as AgentEvent);

            // Synthesize answer from conversation history using LLM
            const synthesisPrompt = `You are on the LAST iteration of your research task. Based on all the information you gathered through tool calls, provide a comprehensive synthesized answer.

Review what you found and create a detailed response that includes:
1. Specific file references (e.g., "In kb-labs-plugin/packages/plugin-runtime/src/index.ts...")
2. Code snippets or interface definitions you discovered
3. Architecture patterns you identified
4. Key components and how they work together

DO NOT say "I couldn't find" or "No information available" - synthesize what you DID find from your research.

Your answer should be detailed, specific, and reference actual files and code you read.`;

            messages.push({
              role: 'user',
              content: synthesisPrompt,
            });

            // Emit synthesis start event
            this.emit({
              type: 'synthesis:start',
              timestamp: new Date().toISOString(),
              sessionId: this.config.sessionId,
              data: {
                iteration,
                promptLength: synthesisPrompt.length,
              },
            } as AgentEvent);

            // Call LLM for synthesis (no tools needed)
            const synthesisStartTime = Date.now();
            // Sequential LLM call required - part of agent iteration loop
             
            const synthesisResponse = await llm.chatWithTools(messages, {
              tools: [], // No tools needed for synthesis
              toolChoice: 'none', // Explicitly disable tool calling
              temperature: this.config.temperature || 0.1,
            });
            const synthesisDurationMs = Date.now() - synthesisStartTime;

            const synthesizedAnswer = synthesisResponse.content || 'Unable to synthesize findings';

            // Trace detailed synthesis:forced event
            if (this.tracer) {
              this.tracer.trace(
                createSynthesisForcedEvent({
                  iteration,
                  reason: 'last_iteration',
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

            // Emit synthesis result event
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

            // Emit iteration:end
            this.emit({
              type: 'iteration:end',
              timestamp: new Date().toISOString(),
              sessionId: this.config.sessionId,
              startedAt: iterationStartTimestamp,
              data: {
                iteration,
                hadToolCalls: false,
                toolCallCount: 0,
              },
            } as AgentEvent);

            // Return with synthesized answer
            // This await in return breaks the loop, not a sequential operation
             
            return await this.createSuccessResult({
              success: true,
              summary: synthesizedAnswer,
            }, iteration);
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
            },
          } as AgentEvent);

           
          const validation = await this.validateTaskCompletion(task, response.content);
           
          return await this.createSuccessResult(validation, iteration);
        }

        // Execute tools and update messages
         
        const toolResults = await this.executeToolCalls(response.toolCalls, iteration);
         
        await this.appendToolMessagesToHistory(messages, response, toolResults, iteration);

        // Phase 2: Update progress tracker after tool execution
        if (response.toolCalls.length > 0) {
          const firstToolName = response.toolCalls[0]!.name;
          const totalOutputSize = toolResults.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
          this.updateProgressTracker(firstToolName, totalOutputSize);
        }

        // Phase 4: Trigger async summarization every 10 iterations (non-blocking)
        if (iteration % 10 === 0) {
          const historySnapshot = this.contextFilter.getHistorySnapshot();
          this.smartSummarizer.triggerSummarization(historySnapshot, iteration)
            .catch((err: Error) => {
              this.log(`⚠️  Background summarization failed: ${err.message}`);
            });
        }

        // Phase 1: Check for ask_orchestrator tool call
        const hasAskOrchestrator = response.toolCalls.some(tc => tc.name === 'ask_orchestrator');
        if (hasAskOrchestrator && this.config.onAskOrchestrator) {
          // Extract question from tool call
          const askCall = response.toolCalls.find(tc => tc.name === 'ask_orchestrator');
          const input = askCall?.input as Record<string, unknown> | undefined;
          const question = (input?.question as string) || 'No question provided';
          const reason = (input?.reason as 'stuck' | 'uncertain' | 'blocker' | 'clarification') || 'uncertain';
          const context = input?.context as Record<string, unknown> | undefined;

          // Call orchestrator callback
           
          const orchestratorResponse = await this.config.onAskOrchestrator({
            question,
            reason,
            context,
            iteration,
            subtask: this.currentTask,
          });

          // Add orchestrator's answer to conversation history
          messages.push({
            role: 'user',
            content: `📣 Orchestrator response:\n\n${orchestratorResponse.answer}${orchestratorResponse.hint ? `\n\n💡 Hint: ${orchestratorResponse.hint}` : ''}`,
          });

          // Handle orchestrator action
          if (orchestratorResponse.action === 'skip') {
            // Orchestrator says skip this subtask
             
            return await this.createSuccessResult({
              success: true,
              summary: `Skipped on orchestrator's guidance: ${orchestratorResponse.answer}`,
            }, iteration);
          }

          // Continue with next iteration (orchestrator's answer is in history)
          continue;
        }

        // Check for early exit via report_to_orchestrator
        const hasReportTool = response.toolCalls.some(tc => tc.name === 'report_to_orchestrator');
        if (hasReportTool) {
          // Extract answer from tool call
          const reportCall = response.toolCalls.find(tc => tc.name === 'report_to_orchestrator');
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
            },
          } as AgentEvent);

          // Return early with synthesized answer
           
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

            // Auto-trigger report_to_orchestrator
             
            return await this.createSuccessResult({
              success: true,
              summary: metadata.reflection.findingsSummary,
            }, iteration);
          }
        }

        // Phase 2: Auto-detect stuck and ask orchestrator for help
        if (this.detectStuck() && this.config.onAskOrchestrator) {
          this.log(`\n🔄 Detected stuck pattern - asking orchestrator for guidance...\n`);

          const stuckReason = this.progressTracker.lastToolCalls.length >= 3 &&
                             new Set(this.progressTracker.lastToolCalls.slice(-3)).size === 1
            ? `Using same tool (${this.progressTracker.lastToolCalls[0]}) repeatedly`
            : `No progress for ${this.progressTracker.iterationsSinceProgress} iterations`;

           
          const orchestratorResponse = await this.config.onAskOrchestrator({
            question: `I appear to be stuck. ${stuckReason}. What should I do?`,
            reason: 'stuck',
            context: {
              lastToolCalls: this.progressTracker.lastToolCalls,
              iterationsSinceProgress: this.progressTracker.iterationsSinceProgress,
            },
            iteration,
            subtask: this.currentTask,
          });

          // Add orchestrator's guidance to conversation
          messages.push({
            role: 'user',
            content: `🤖 Auto-detected stuck pattern!\n\n📣 Orchestrator guidance:\n\n${orchestratorResponse.answer}${orchestratorResponse.hint ? `\n\n💡 Hint: ${orchestratorResponse.hint}` : ''}`,
          });

          // Reset progress tracker after getting help
          this.progressTracker.iterationsSinceProgress = 0;
          this.progressTracker.lastToolCalls = [];
          this.progressTracker.lastOutputSizes = [];

          // Handle orchestrator action
          if (orchestratorResponse.action === 'skip') {
             
            return await this.createSuccessResult({
              success: true,
              summary: `Skipped on orchestrator's guidance (auto-stuck detection): ${orchestratorResponse.answer}`,
            }, iteration);
          }

          // Continue with orchestrator's guidance
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
          },
        } as AgentEvent);
      } catch (error) {
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


        return this.createFailureResult(`Failed: ${errorMsg}`, iteration, errorMsg);
      }
    }

    return this.createFailureResult(
      `Max iterations (${this.config.maxIterations}) reached without completion`,
      this.config.maxIterations
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
  }

  /**
   * Convert tool definitions to LLM format
   * Phase 4: Add context_retrieve tool for on-demand context retrieval
   */
  private convertToolDefinitions(): LLMTool[] {
    const toolDefinitions = this.toolRegistry.getDefinitions();
    const registryTools = toolDefinitions.map(td => ({
      name: td.function.name,
      description: td.function.description,
      inputSchema: td.function.parameters as Record<string, unknown>,
    }));

    // Add context_retrieve tool (Phase 4: On-demand retrieval)
    const contextRetrieveTool = createContextRetrieveTool(
      () => this.contextFilter.getHistorySnapshot()
    );

    return [
      ...registryTools,
      contextRetrieveTool,
    ];
  }

  /**
   * Log iteration header
   */
  private logIterationHeader(iteration: number): void {
    this.log(`\n${'─'.repeat(60)}`);
    this.log(`📍 Iteration ${iteration}/${this.config.maxIterations}`);
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

    // Record LLM response details
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'llm_response',
      data: {
        content: response.content || '',
        hasToolCalls: Boolean(response.toolCalls && response.toolCalls.length > 0),
        toolCallsCount: response.toolCalls?.length || 0,
      },
      durationMs: 0,
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
      const input = toolCall.input as Record<string, unknown>;

      // === DISABLED: Cache has bug with tool_use_id format (Phase 1, Step 1.4) ===
      // TODO: Fix cache to work within single LLM request, not across iterations
      // const cacheKey = this.buildCacheKey(toolCall.name, input);
      // const cached = this.getCachedResult(cacheKey);
      // ... cache logic disabled for now
      // === END DISABLED ===

      this.log(
        `🔧 ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}...)`
      );

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
        // Phase 4: Handle context_retrieve tool (special case - not in registry)
        let result: ToolResult;
        if (toolCall.name === 'context_retrieve') {
           
          const retrieveResult = await executeContextRetrieve(
            input as ContextRetrieveInput,
            () => this.contextFilter.getHistorySnapshot()
          );

          const formattedOutput = formatContextRetrieveResult(retrieveResult);

          result = {
            success: retrieveResult.success,
            output: formattedOutput,
            error: retrieveResult.error,
            metadata: {
              messagesRetrieved: retrieveResult.count,
            },
          };
        } else {
           
          result = await this.toolRegistry.execute(toolCall.name, input);
        }

        // === DISABLED: Cache disabled (Phase 1, Step 1.4) ===
        // this.cacheResult(cacheKey, result);
        // === END DISABLED ===

        const toolDurationMs = Date.now() - toolStartTime;

        this.trackFileOperation(toolCall.name, input, result);
        this.logToolResult(result);
        this.recordToolTrace(toolCall, result, iteration, toolDurationMs);

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
        const toolDurationMs = Date.now() - toolStartTime;
        this.log(`  ✗ Tool error: ${errorMsg}`);

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
      return {
        command: input.command as string,
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
      toolMetadata = {
        command: input.command as string,
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
      : `Error: ${result.error}`;

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
    // Note: When LLM returns tool calls, content may be empty or null
    // We need to ensure non-empty content for the message
    // Use a placeholder if no content but has tool calls
    const content = response.content?.trim()
      || (response.toolCalls?.length ? '[Executing tools...]' : '');

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

    // Phase 4: Append to full history (preserved for tracing/context_retrieve)
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
    const durationMs = Date.now() - this.startTime;

    // Record in memory
    if (this.memory && this.currentTask) {
      await this.memory.add({
        content: `Task completed: ${this.currentTask}\nResult: ${validation.summary}`,
        type: 'result',
        metadata: {
          taskId: `task-${Date.now()}`,
          importance: 0.8,
        },
      });
    }

    // Emit agent:end with startedAt for duration calculation in UI
    this.emit({
      type: 'agent:end',
      timestamp: new Date().toISOString(),
      sessionId: this.config.sessionId,
      startedAt: this.startTimestamp, // When agent started
      data: {
        success: validation.success,
        summary: validation.summary,
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
        message: validation.summary,
      },
    });

    // Trace task end
    this.recordTrace({
      iteration,
      timestamp: new Date().toISOString(),
      type: 'task_end',
      data: {
        success: validation.success,
        summary: validation.summary,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesRead: Array.from(this.filesRead),
        totalIterations: iteration,
        totalTokens: this.totalTokens,
      },
      durationMs: 0,
    });

    return {
      success: validation.success,
      summary: validation.summary,
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
    const durationMs = Date.now() - this.startTime;

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
      },
      durationMs: 0,
    });

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
   * Track file operations
   */
  private trackFileOperation(toolName: string, input: Record<string, unknown>, result?: { metadata?: Record<string, unknown> }): void {
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
      // Save content hash for edit protection
      if (result?.metadata?.contentHash) {
        this.filesReadHash.set(filePath, result.metadata.contentHash as string);
      }
    }
  }

  /**
   * Phase 2: Update progress tracker after each iteration
   */
  private updateProgressTracker(toolName: string, outputSize: number): void {
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

    // Check if making progress (output size increasing)
    if (this.progressTracker.lastOutputSizes.length >= 2) {
      const latest = this.progressTracker.lastOutputSizes[this.progressTracker.lastOutputSizes.length - 1];
      const previous = this.progressTracker.lastOutputSizes[this.progressTracker.lastOutputSizes.length - 2];
      if (latest! > previous! * 0.5) {
        // Making progress - output size grew by >50%
        this.progressTracker.iterationsSinceProgress = 0;
      } else {
        // Not making progress - output size stagnant
        this.progressTracker.iterationsSinceProgress++;
      }
    }
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

  /**
   * Validate task completion using LLM
   */
  private async validateTaskCompletion(
    task: string,
    agentResponse?: string
  ): Promise<{ success: boolean; summary: string }> {
    const llm = useLLM({ tier: 'small' });

    // Read content of modified/created files for validation
    let fileContents = '';
    if (this.filesModified.size > 0 || this.filesCreated.size > 0) {
      const filesToCheck = [
        ...Array.from(this.filesModified),
        ...Array.from(this.filesCreated),
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
    const isInformationalTask = /^(what|how|why|explain|tell|describe|show|list|find|search|where|when|who|analyze|scan|inspect|review|identify|check|examine|investigate|explore|map|determine)/i.test(task.trim());

    if (isInformationalTask && agentResponse && agentResponse.trim().length > 50) {
      // For questions, the agent's response IS the answer - use it directly
      return {
        success: true,
        summary: agentResponse,
      };
    }

    const prompt = `You are validating if an agent task was successfully completed.

**Original Task:** ${task}

**Files Created:** ${Array.from(this.filesCreated).join(', ') || 'None'}
**Files Modified:** ${Array.from(this.filesModified).join(', ') || 'None'}
**Files Read:** ${Array.from(this.filesRead).join(', ') || 'None'}

**Modified/Created Files Content:**${fileContents || '\n(No files to show)'}

${agentResponse ? `**Agent Response:**\n${agentResponse}\n` : ''}

**Validation Rules:**

1. **For informational/question tasks** (starting with "What", "How", "Why", "Explain", "Tell me", etc.):
   - SUCCESS if agent provided a text response (even if no files were created/modified)
   - The agent response answers the question, even if it references past actions
   - File operations are NOT required for these tasks
   - Example: "What did I write?" → agent says "You wrote X" = SUCCESS

2. **For action tasks** (create, edit, delete, run, etc.):
   - SUCCESS if appropriate files were created/modified/read
   - Example: "Create file.txt" → file.txt created = SUCCESS

IMPORTANT: If there is an Agent Response and the task is a question, consider it SUCCESS even if no files were modified.

**CRITICAL for summary field:**
- For research/informational tasks: Include ACTUAL FINDINGS - specific file paths, package names, code details discovered
- For action tasks: Describe what was done specifically
- NEVER write meta-descriptions like "The agent successfully provided..." - include the actual discovered content
- If Agent Response exists, extract and include the key information from it

Respond ONLY with valid JSON:
{"success": true/false, "summary": "actual findings with specific details"}`;

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      const response = await llm.complete(prompt, {
        temperature: 0,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        return {
          success: parsed.success === true,
          summary: parsed.summary || 'Task completed',
        };
      }
    } catch (error) {
      this.log(`⚠️  Validation error: ${error}`);
    }

    // Fallback: consider successful if files were modified/created OR agent provided a response
    const hasFileChanges =
      this.filesCreated.size > 0 || this.filesModified.size > 0;
    const hasResponse = Boolean(agentResponse && agentResponse.trim().length > 0);

    return {
      success: hasFileChanges || hasResponse,
      summary: hasFileChanges
        ? `Modified ${this.filesModified.size} file(s), created ${this.filesCreated.size} file(s)`
        : hasResponse
          ? agentResponse!.slice(0, 200)
          : 'Task completed without file changes',
    };
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
            this.log(`📋 Loaded project instructions from ${fileName}`);
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
    let basePrompt = `You are an autonomous agent that helps users complete tasks.

**Available Tools:**
You have access to ${this.toolRegistry.getDefinitions().length} tools:
- Filesystem: fs_write, fs_read, fs_edit, fs_list
- Search: glob_search, grep_search
- Shell: shell_exec
- Memory: memory_get, memory_preference, memory_constraint, memory_correction, memory_finding, memory_blocker
- Session: session_save
- TODO (optional): todo_create, todo_update, todo_get
- Interaction: ask_user

**🧠 BEFORE EACH TOOL CALL - THINK FIRST:**

Before calling ANY tool, briefly think through:
1. **Goal:** What am I trying to achieve with this call?
2. **Already have:** Do I already have this information from a previous call?
3. **Necessary:** Is this call strictly necessary to answer the user's question?
4. **Alternative:** Could I answer without this call based on what I already found?

Example good thinking:
"Goal: Find where AuthService is defined. Already have: Nothing about auth yet. Necessary: Yes. Alternative: None."

Example that should STOP:
"Goal: Find more files about auth. Already have: Found AuthService in src/auth/service.ts with full implementation. Necessary: NO - I have enough to answer. Alternative: Synthesize from what I found."

**🛑 EARLY EXIT - Use report_to_orchestrator when you have enough information:**

When you meet ANY of these stopping conditions, call **report_to_orchestrator** immediately:

1. **Found the target:**
   - User asked "What is X?" and you found X's definition/implementation
   - User asked "Where is X?" and you found the file path
   - User asked "How does X work?" and you read X's code

2. **Sufficient context:**
   - You've read 2-3 files directly relevant to the question
   - You have code snippets that demonstrate the answer
   - Additional searches return similar/related but not new information

3. **Diminishing returns:**
   - Your last 2 searches found things you already knew
   - You're finding the same files/patterns repeatedly
   - Search results are getting less relevant

4. **Practical limits:**
   - You've made 5+ tool calls without finding something new
   - You've read 5+ files on the topic

5. **Last iteration:**
   - You're on the last iteration - MUST call report_to_orchestrator with synthesized answer
   - Include everything you found, with file references and specifics

**How to use report_to_orchestrator:**
- Call report_to_orchestrator with answer (string) and confidence (0.0-1.0)
- Include file references, code snippets, and specific details
- Example: answer = "In src/auth/service.ts, the AuthService class handles OAuth2. Methods: login(), validate()..."

**IMPORTANT:** It's better to answer with "I found X but couldn't find Y" than to keep searching indefinitely. Users prefer honest partial answers over endless loops.

**🤔 REFLECTION - Assess your progress regularly:**

Every 3-4 iterations, OR when you think you might have enough information, call **reflect_on_progress** to:
1. Summarize what you've found so far
2. Rate your confidence (0.0-1.0)
3. List remaining unanswered questions
4. Decide whether to continue searching

**When reflect_on_progress shows high confidence (≥0.7) AND no questions remain:**
- The system will automatically call report_to_orchestrator with your findings
- You DON'T need to manually call report_to_orchestrator
- This prevents over-searching and saves tokens

**Example reflection call:**
reflect_on_progress with:
  findings_summary: "Found AuthService in src/auth/service.ts with OAuth2 methods: login(), validate(), and refresh()"
  confidence: 0.9
  questions_remaining: []
  should_continue: false
  reason: "Have complete implementation details and no outstanding questions"

**Reflection triggers:**
- After 3-4 tool calls
- When you've read 2-3 relevant files
- When search results start repeating
- BEFORE the last iteration (iteration 11/12)

**DO NOT:**
- Keep searching "just to be thorough" after finding the answer
- Search for "more examples" when you have 2-3 good ones
- Re-read files you already read
- Search for synonyms of things you already found

**⚠️ CRITICAL RULES - MUST FOLLOW:**

1. **NEVER answer questions from general knowledge.** You MUST use tools to research the codebase first.
   - For "What is X?" → Use grep_search or glob_search to find X, then fs_read to understand it
   - For "How does X work?" → Find and read the actual implementation files
   - For "Explain X" → Search for X in the codebase and read relevant files

2. **Always show your research.** Before answering any informational question:
   - FIRST: Use search tools (glob_search, grep_search) to find relevant files
   - THEN: Use fs_read to read the actual code
   - FINALLY: Synthesize your answer based on what you found

3. **If you cannot find information, say so.** Never hallucinate or guess.

**Task Completion Criteria:**
- For code tasks: write, test, and verify the code works
- For information tasks: SEARCH → READ → SYNTHESIZE (not from memory!)
- For complex tasks: break down into steps and execute systematically

**Tool Usage Order for Questions:**
1. memory_get - check for relevant context
2. glob_search / grep_search - find relevant files
3. fs_read - read the actual code
4. (Only then) Provide your answer based on what you found

**Best Practices:**
- Use memory_preference to save user preferences (persistent)
- Use memory_constraint to save project rules (persistent)
- Use memory_correction when user corrects your understanding (session)
- Use memory_finding to save discoveries with confidence level (session)

**When Done:**
- Respond with a summary that includes WHAT FILES YOU READ and WHAT YOU FOUND
- Include file paths in your answer to show your research

Work systematically: SEARCH → READ → ANSWER.

**✅ ADAPTIVE VERIFICATION - Verify your work and fix issues:**

After completing work, VERIFY your results. Choose verification method based on what you created:

**1. How to Decide Verification Method:**

Ask yourself: "What artifact did I create and how can I prove it works?"

- Created **Node.js project** with package.json → "npm install && npm test"
- Created **Python project** with requirements.txt → "pip install -r requirements.txt && pytest"
- Created **API/service** → "curl http://localhost:PORT/endpoint" or health check
- Created **Docker setup** → "docker build -t myapp ."
- Created **shell script** → "bash script.sh --help" or dry-run
- Created **config file** → validate syntax (jq for JSON, yamllint for YAML)
- Researched **code/architecture** → re-read files to verify claims

**2. Verification Workflow:**

   Create artifact → Verify it works → If FAIL: analyze + fix + retry (max 3x) → Report result

**Examples:**

**Code Project Verification:**
   1. Created .agent-sandbox/package.json + src/ + tests/
   2. Verify:
      shell_exec: "cd .agent-sandbox && npm install"
      shell_exec: "cd .agent-sandbox && npm test"
   3. If FAIL: "Port 3000 EADDRINUSE"
      - Fix: fs_edit server.js (change port 3000 → 3001)
      - Retry: npm test again
      - Result: PASS → confidence: 0.9
   4. In reflection evidence:
      "Created 15 files. npm install: success. npm test: 18/18 passing ✓"

**API Verification:**
   1. Created REST API with Express
   2. Verify:
      shell_exec: "cd .agent-sandbox && npm start &"
      shell_exec: "sleep 2 && curl http://localhost:3000/health"
   3. If FAIL: "Connection refused"
      - Check logs: shell_exec "cat .agent-sandbox/logs/error.log"
      - Fix: install missing dependency
      - Retry: restart + curl again
   4. In reflection evidence:
      "API deployed. GET /health → 200 OK ✓"

**Research Verification:**
   1. Researched "How does AuthService work?"
   2. Verify claims:
      fs_read: src/auth/service.ts
      → Confirm AuthService class exists at line 15
      → Confirm methods: login(), validate()
   3. In reflection evidence:
      "Found AuthService in src/auth/service.ts:15-45. Verified methods: login(), validate(), refresh()"

**3. When Verification Fails (Retry Loop):**

   Attempt 1: Run verification → analyze error → fix obvious issue → re-verify
   Attempt 2: Try alternative fix → re-verify
   Attempt 3: Last attempt with different approach → re-verify
   After 3 fails: Report to orchestrator with error details (don't keep banging your head)

**4. Confidence Based on Verification:**

- **0.9-1.0**: Work complete + verification PASSED (tests green, service healthy)
- **0.6-0.8**: Work complete + verification FAILED but fixable (know what's wrong)
- **0.3-0.5**: Work complete + verification FAILED + don't know how to fix
- **0.0-0.2**: Work incomplete or verification not attempted

**5. When to Skip Verification:**

- Pure research questions (no artifacts created)
- Explicitly told "don't test" or "dry run only"
- No verification tools available (legacy project without tests)

**IMPORTANT:** Your evidence_of_completion MUST include verification results. Saying "created files" without testing = LOW confidence.

`;

    // Add project-specific instructions from AGENT.md (truncated to prevent overflow)
    const projectInstructions = this.loadProjectInstructions();
    if (projectInstructions) {
      const MAX_INSTRUCTIONS_CHARS = 4000; // ~1000 tokens
      const truncated = projectInstructions.length > MAX_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n\n[...instructions truncated...]'
        : projectInstructions;
      basePrompt += `\n\n**Project Instructions (from AGENT.md):**\n${truncated}`;
    }

    // Add memory context if available (already token-limited internally)
    if (this.memory) {
      const memoryContext = await this.memory.getContext(2000); // Reduced from 4000
      if (memoryContext.trim().length > 0) {
        basePrompt += `\n\n**Previous Context from Memory:**\n${memoryContext}`;
      }

      // Check if there's an original user task in memory (from orchestrator)
      // Orchestrator extracts structured context ONCE, agent just reads it
      const recentMemories = await this.memory.getRecent(20);
      const originalTaskEntry = recentMemories.find(
        (entry) => entry.metadata?.isOriginalUserTask === true
      );

      if (originalTaskEntry && this.currentTask !== originalTaskEntry.content) {
        // Read structured context extracted by orchestrator
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
