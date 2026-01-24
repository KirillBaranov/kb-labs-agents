/**
 * @module @kb-labs/adaptive-orchestrator/orchestrator
 * Adaptive agent orchestrator with tier-based model selection.
 *
 * Coordinates task classification, planning, execution, and synthesis
 * with automatic tier escalation and cost optimization.
 */

import type { ILLM, ILogger, PluginContextV3 } from "@kb-labs/sdk";
import type { LLMTier } from "@kb-labs/agent-contracts";
import { useLLM, useAnalytics, findRepoRoot } from "@kb-labs/sdk";
import { HybridComplexityClassifier } from "@kb-labs/task-classifier";
import {
  ProgressReporter,
  type ProgressCallback,
} from "@kb-labs/progress-reporter";
import { OrchestrationAnalytics } from "./analytics.js";
import { OrchestratorAgentRegistry } from "./agent-registry.js";
import { FileHistoryStorage } from "./history-storage.js";
import { executeWithAgent } from "./agent-execution-helper.js";
import type {
  ExecutionPlan,
  Subtask,
  SubtaskResult,
  OrchestratorResult,
  OrchestratorConfig,
} from "./types.js";
import type { OrchestrationHistory, SubtaskTrace } from "./history-types.js";

/**
 * Adaptive orchestrator.
 *
 * Implements the complete adaptive orchestration flow:
 * 1. Classify task complexity
 * 2. Create execution plan
 * 3. Execute subtasks with appropriate tiers
 * 4. Automatic escalation on failure
 * 5. Synthesize final result
 *
 * @example
 * ```typescript
 * import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
 * import { useLogger } from '@kb-labs/sdk';
 *
 * const logger = useLogger();
 * const orchestrator = new AdaptiveOrchestrator({ logger });
 *
 * const result = await orchestrator.execute('Реализуй мне фичу 1');
 * console.log(result.result);
 * console.log(`Cost: ${result.costBreakdown.total}`);
 * ```
 */
export class AdaptiveOrchestrator {
  private classifier: HybridComplexityClassifier;
  private reporter: ProgressReporter;
  private analytics: OrchestrationAnalytics;
  private config: Required<OrchestratorConfig>;
  private agentRegistry!: OrchestratorAgentRegistry; // Initialized in execute()
  private agentsLoaded = false;
  private historyStorage!: FileHistoryStorage; // Initialized in execute()
  private currentHistory?: Partial<OrchestrationHistory>;
  private subtaskTraces: SubtaskTrace[] = [];

  constructor(
    private ctx: PluginContextV3,
    private logger: ILogger,
    onProgress?: ProgressCallback,
    config?: OrchestratorConfig,
  ) {
    // Initialize classifier with small tier (cheap for classification)
    const classifierLLM = useLLM({ tier: "small" });
    if (!classifierLLM) {
      throw new Error("LLM not available. Cannot create classifier.");
    }
    this.classifier = new HybridComplexityClassifier(classifierLLM);

    // Initialize progress reporter
    this.reporter = new ProgressReporter(logger, onProgress);

    // Initialize analytics
    const analyticsAdapter = useAnalytics();
    this.analytics = new OrchestrationAnalytics(analyticsAdapter);

    // Note: Agent registry and history storage will be initialized in execute()
    // after finding repo root (which is async)

    // Default config
    this.config = {
      maxEscalations: config?.maxEscalations ?? 2,
      trackCost: config?.trackCost ?? true,
      pricing: config?.pricing ?? {
        small: 1_000_000, // $1 per 1M tokens
        medium: 500_000, // $1 per 500K tokens
        large: 100_000, // $1 per 100K tokens
      },
    };
  }

  /**
   * Execute task with adaptive orchestration.
   */
  async execute(task: string): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Find repository root (like commit-plugin does)
    const repoRoot =
      (await findRepoRoot(this.ctx.cwd || process.cwd())) ?? process.cwd();

    // Initialize agent registry and history storage with repo root
    if (!this.agentRegistry) {
      this.agentRegistry = new OrchestratorAgentRegistry(repoRoot);
    }
    if (!this.historyStorage) {
      this.historyStorage = new FileHistoryStorage(repoRoot);
    }

    // Reset state for new session
    this.subtaskTraces = [];
    this.currentHistory = {
      sessionId,
      task,
      startTime,
      agentsLoadedCount: 0,
      availableAgents: [],
    };

    // 1. Start tracking
    this.reporter.start(task);
    this.analytics.trackTaskStarted(task);

    try {
      // 2. Load agents (lazy initialization)
      if (!this.agentsLoaded) {
        await this.agentRegistry.loadAgents();
        this.agentsLoaded = true;
        this.logger.debug(
          `Agent registry has ${this.agentRegistry.count()} agents`,
        );
        if (this.agentRegistry.hasAgents()) {
          this.logger.info(`Loaded ${this.agentRegistry.count()} agent agents`);
        } else {
          this.logger.warn("No agent agents found in .kb/agents/");
        }
      }

      // Update history with loaded agents
      this.currentHistory!.agentsLoadedCount = this.agentRegistry.count();
      this.currentHistory!.availableAgents = this.agentRegistry
        .getAll()
        .map((a) => a.id);

      // 3. Classify task complexity
      const { tier, confidence, method } = await this.classifier.classify({
        taskDescription: task,
      });
      this.reporter.classified(tier, confidence, method);
      this.analytics.trackClassification(tier, confidence, method);

      // Update history with classification
      this.currentHistory!.classifiedTier = tier;
      this.currentHistory!.classificationConfidence = confidence;
      this.currentHistory!.classificationMethod = method;

      // 4. Planning phase (use classified tier)
      this.reporter.planning("started");
      const llm = useLLM({ tier });
      if (!llm) {
        throw new Error(`LLM not available for tier: ${tier}`);
      }

      const plan = await this.createPlan(llm, task);
      this.reporter.planning("completed", {
        subtaskCount: plan.subtasks.length,
      });

      // Update history with plan
      this.currentHistory!.plan = plan;

      // Track tier and agent distribution in plan
      const tierDistribution = plan.subtasks.reduce(
        (acc, st) => {
          acc[st.complexity] = (acc[st.complexity] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const agentDistribution = plan.subtasks.reduce(
        (acc, st) => {
          if (st.agentId) {
            acc[st.agentId] = (acc[st.agentId] || 0) + 1;
          }
          return acc;
        },
        {} as Record<string, number>,
      );

      this.analytics.trackPlanningCompleted(
        plan.subtasks.length,
        tierDistribution,
        Object.keys(agentDistribution).length > 0
          ? agentDistribution
          : undefined,
      );

      // 4. Execute subtasks with appropriate tiers
      const results: SubtaskResult[] = [];
      for (const subtask of plan.subtasks) {
        const result = await this.executeSubtaskWithRetry(subtask);
        results.push(result);
      }

      // 5. Synthesize final result (use orchestrator tier)
      const finalResult = await this.synthesize(llm, task, results);

      // 6. Calculate cost breakdown
      const costBreakdown = this.calculateCost(results);

      // 7. Complete tracking
      const duration = Date.now() - startTime;
      this.reporter.complete("success", costBreakdown);

      const orchestratorResult: OrchestratorResult = {
        status: "success",
        result: finalResult,
        costBreakdown,
        subtaskResults: results,
      };

      this.analytics.trackTaskCompleted(task, orchestratorResult, duration);

      // 8. Save execution history
      await this.saveHistory(orchestratorResult, startTime, true);

      return orchestratorResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.reporter.complete("failed", {
        total: "N/A",
        small: "N/A",
        medium: "N/A",
        large: "N/A",
      });
      this.analytics.trackTaskFailed(
        task,
        error instanceof Error ? error : new Error(String(error)),
        duration,
      );

      // Save execution history even on failure
      try {
        const failedResult: OrchestratorResult = {
          status: "failed",
          result: "",
          costBreakdown: {
            total: "N/A",
            small: "N/A",
            medium: "N/A",
            large: "N/A",
          },
          subtaskResults: [],
        };
        await this.saveHistory(
          failedResult,
          startTime,
          false,
          error instanceof Error ? error.message : String(error),
        );
      } catch (historyError) {
        this.logger.warn(
          `Failed to save execution history: ${historyError instanceof Error ? historyError.message : String(historyError)}`,
        );
      }

      throw error;
    }
  }

  /**
   * Validate and fix agent assignments in subtasks.
   * Uses agent keywords to automatically assign agents when LLM didn't.
   */
  private validateAndFixAgentAssignments(subtasks: Subtask[]): void {
    const agents = this.agentRegistry.getAll();

    for (const subtask of subtasks) {
      // Skip if agent already assigned
      if (subtask.agentId) {
        continue;
      }

      const desc = subtask.description.toLowerCase();

      // Try to match with agent keywords
      let bestMatch: {
        agentId: string;
        score: number;
        matchedKeywords: string[];
      } | null = null;

      for (const agent of agents) {
        const keywords = agent.metadata.keywords || [];
        const matchedKeywords: string[] = [];

        // Check how many keywords match
        for (const keyword of keywords) {
          if (desc.includes(keyword.toLowerCase())) {
            matchedKeywords.push(keyword);
          }
        }

        if (matchedKeywords.length > 0) {
          const score = matchedKeywords.length;
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { agentId: agent.id, score, matchedKeywords };
          }
        }
      }

      // Auto-assign if we found a good match
      if (bestMatch && bestMatch.score > 0) {
        subtask.agentId = bestMatch.agentId;
        subtask.reasoning = `Auto-assigned: Matched keywords [${bestMatch.matchedKeywords.join(", ")}]`;
        this.logger.warn(
          `Auto-assigned ${bestMatch.agentId} to subtask ${subtask.id}: "${subtask.description}" (matched: ${bestMatch.matchedKeywords.join(", ")})`,
        );
      }
    }
  }

  /**
   * Create execution plan for task.
   */
  private async createPlan(llm: ILLM, task: string): Promise<ExecutionPlan> {
    // Get available agents
    const agentsList = this.agentRegistry.toPromptFormat();

    const prompt = `You are a task planning assistant. Break down the following task into subtasks.

Task: ${task}

${
  this.agentRegistry.hasAgents()
    ? `## Available Agent Agents

**IMPORTANT:** You MUST assign agent agents when subtasks require tools (file operations, code search, etc.).
Generic LLM without agent cannot create files, modify code, or execute tools.

${agentsList}

**Agent Selection Rules:**
1. If subtask needs to CREATE, WRITE, or IMPLEMENT code/files → MUST use coding-agent
2. If subtask needs to WRITE TESTS → MUST use testing-agent
3. If subtask needs to WRITE DOCUMENTATION → MUST use documentation-agent
4. If subtask needs to FIX bugs or DEBUG → MUST use debugging-agent
5. If subtask needs to REFACTOR or IMPROVE code → MUST use refactoring-agent
6. Only use generic LLM (no agentId) for pure analysis/research tasks that don't need file access

`
    : ""
}Respond with a JSON array of subtasks. Each subtask should have:
- id: number (1-based)
- description: string
- complexity: "small" | "medium" | "large"${
      this.agentRegistry.hasAgents()
        ? `
- agentId: string (REQUIRED if task needs tools; agent agent ID)
- reasoning: string (REQUIRED if agentId provided: why this agent was chosen)`
        : ""
    }

Example:
[
  {"id": 1, "description": "Create formatBytes utility function", "complexity": "small", "agentId": "coding-agent", "reasoning": "Needs to create new code file with implementation"},
  {"id": 2, "description": "Write tests for formatBytes", "complexity": "small", "agentId": "testing-agent", "reasoning": "Needs to create test file"},
  {"id": 3, "description": "Research best practices for formatting bytes", "complexity": "small"}
]

Respond with ONLY the JSON array, no markdown.`;

    // Debug: Log the planning prompt
    this.logger.debug(`Planning prompt:\n${prompt.substring(0, 500)}...`);
    this.logger.debug(`Available agents: ${this.agentRegistry.count()}`);

    const response = await llm.complete(prompt, {
      maxTokens: 1000,
      temperature: 0.3,
    });

    this.logger.debug(
      `LLM planning response: ${response.content.substring(0, 300)}...`,
    );

    try {
      const subtasks = JSON.parse(response.content.trim());

      // Validate and fix agent assignments
      this.validateAndFixAgentAssignments(subtasks);

      // Track agent selections
      for (const subtask of subtasks) {
        if (subtask.agentId && subtask.reasoning) {
          this.analytics.trackAgentSelected(
            subtask.id,
            subtask.agentId,
            subtask.reasoning,
            subtask.complexity,
          );
        }
      }

      return { subtasks };
    } catch (error) {
      this.logger.error(
        `Failed to parse plan JSON: ${response.content.slice(0, 200)}`,
      );
      // Fallback: treat as single subtask
      return {
        subtasks: [
          {
            id: 1,
            description: task,
            complexity: "medium",
          },
        ],
      };
    }
  }

  /**
   * Execute subtask with automatic retry and escalation.
   */
  private async executeSubtaskWithRetry(
    subtask: Subtask,
  ): Promise<SubtaskResult> {
    let currentTier = subtask.complexity;
    let attempts = 0;

    while (attempts <= this.config.maxEscalations) {
      try {
        // Report start
        this.reporter.subtask(
          subtask.id,
          subtask.description,
          currentTier,
          "started",
          { agentId: subtask.agentId },
        );

        // Execute with current tier
        const result = await this.executeSubtask(subtask, currentTier);

        // Report completion
        this.reporter.subtask(
          subtask.id,
          subtask.description,
          currentTier,
          "completed",
          { agentId: subtask.agentId },
        );

        // Track analytics
        this.analytics.trackSubtaskExecuted(result);

        return result;
      } catch (error) {
        attempts++;

        // Try escalation if attempts remain
        if (attempts <= this.config.maxEscalations) {
          const nextTier = this.escalateTier(currentTier);
          if (nextTier === currentTier) {
            // Already at max tier, fail
            this.reporter.subtask(
              subtask.id,
              subtask.description,
              currentTier,
              "failed",
              {
                error: error instanceof Error ? error.message : "Unknown error",
                agentId: subtask.agentId,
              },
            );
            throw error;
          }

          // Escalate
          const reason =
            error instanceof Error ? error.message : "Unknown error";
          this.reporter.escalated(subtask.id, currentTier, nextTier, reason);
          this.analytics.trackTierEscalated(
            subtask.id,
            currentTier,
            nextTier,
            reason,
          );
          currentTier = nextTier;
        } else {
          // No more attempts, fail
          this.reporter.subtask(
            subtask.id,
            subtask.description,
            currentTier,
            "failed",
            {
              error: error instanceof Error ? error.message : "Unknown error",
              agentId: subtask.agentId,
            },
          );
          throw error;
        }
      }
    }

    throw new Error("Max escalations reached");
  }

  /**
   * Execute single subtask with specified tier.
   */
  private async executeSubtask(
    subtask: Subtask,
    tier: LLMTier,
  ): Promise<SubtaskResult> {
    const startTime = Date.now();

    // If agent is specified, execute with full agent + tools
    if (subtask.agentId) {
      this.logger.info(
        `Executing subtask ${subtask.id} with agent agent: ${subtask.agentId}`,
      );

      const { result, toolCalls, llmInteractions } = await executeWithAgent(
        this.ctx,
        subtask,
        tier,
      );

      const endTime = Date.now();

      // Track in history
      this.subtaskTraces.push({
        id: subtask.id,
        description: subtask.description,
        tier,
        agentId: subtask.agentId,
        llmInteractions,
        toolCalls,
        result,
        startTime,
        endTime,
        durationMs: endTime - startTime,
      });

      // Track agent execution analytics
      this.analytics.trackAgentExecuted(
        subtask.agentId,
        tier,
        result.status as "success" | "failed",
        result.tokens || 0,
      );

      return result;
    }

    // Otherwise, use generic LLM (no tools)
    this.logger.debug(
      `Executing subtask ${subtask.id} with generic LLM (tier: ${tier})`,
    );

    const llm = useLLM({ tier });
    if (!llm) {
      throw new Error(`LLM not available for tier: ${tier}`);
    }

    const prompt = `Execute the following subtask:\n\n${subtask.description}\n\nProvide a concise result.`;

    const llmStartTime = Date.now();
    const response = await llm.complete(prompt, {
      maxTokens: 1000,
      temperature: 0.5,
    });
    const llmEndTime = Date.now();

    // Estimate tokens (rough approximation)
    const tokens = Math.ceil((prompt.length + response.content.length) / 4);

    const result: SubtaskResult = {
      id: subtask.id,
      status: "success",
      tier,
      content: response.content,
      tokens,
    };

    const endTime = Date.now();

    // Track in history
    this.subtaskTraces.push({
      id: subtask.id,
      description: subtask.description,
      tier,
      llmInteractions: [
        {
          type: "complete",
          tier,
          input: prompt,
          output: response.content,
          tokens,
          durationMs: llmEndTime - llmStartTime,
          timestamp: llmStartTime,
        },
      ],
      result,
      startTime,
      endTime,
      durationMs: endTime - startTime,
    });

    return result;
  }

  /**
   * Load agent context from context.md file.
   */
  private async loadAgentContext(agentId: string): Promise<string> {
    try {
      const agentInfo = this.agentRegistry.get(agentId);
      if (!agentInfo) {
        this.logger.warn(`Agent not found: ${agentId}, using generic LLM`);
        return "";
      }

      // Try to load context.md
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const contextPath = join(agentInfo.path, "context.md");

      try {
        const contextContent = await readFile(contextPath, "utf-8");
        this.logger.debug(
          `Loaded context for agent: ${agentId} (${contextContent.length} chars)`,
        );
        return contextContent;
      } catch (error) {
        // context.md is optional
        this.logger.debug(
          `No context.md found for agent: ${agentId}, using base config only`,
        );
        return "";
      }
    } catch (error) {
      this.logger.error(
        `Failed to load agent context for ${agentId}:`,
        error instanceof Error ? error : undefined,
      );
      return "";
    }
  }

  /**
   * Synthesize final result from subtask results.
   */
  private async synthesize(
    llm: ILLM,
    originalTask: string,
    results: SubtaskResult[],
  ): Promise<string> {
    const subtaskSummary = results
      .map((r) => `[${r.id}] ${r.content?.slice(0, 200) || "No content"}`)
      .join("\n\n");

    const prompt = `You completed a multi-step task. Synthesize the results into a final answer.

Original Task: ${originalTask}

Subtask Results:
${subtaskSummary}

Provide a concise, coherent final result.`;

    const response = await llm.complete(prompt, {
      maxTokens: 500,
      temperature: 0.3,
    });

    return response.content.trim();
  }

  /**
   * Escalate to next higher tier.
   */
  private escalateTier(tier: LLMTier): LLMTier {
    switch (tier) {
      case "small":
        return "medium";
      case "medium":
        return "large";
      case "large":
        return "large"; // Already at max
    }
  }

  /**
   * Save execution history to storage.
   */
  private async saveHistory(
    result: OrchestratorResult,
    startTime: number,
    success: boolean,
    error?: string,
  ): Promise<void> {
    if (!this.currentHistory) {
      this.logger.warn("No current history to save");
      return;
    }

    const endTime = Date.now();

    const history: OrchestrationHistory = {
      sessionId: this.currentHistory.sessionId!,
      task: this.currentHistory.task!,
      classifiedTier: this.currentHistory.classifiedTier!,
      classificationConfidence: this.currentHistory.classificationConfidence!,
      classificationMethod: this.currentHistory.classificationMethod!,
      plan: this.currentHistory.plan!,
      agentsLoadedCount: this.currentHistory.agentsLoadedCount!,
      availableAgents: this.currentHistory.availableAgents!,
      subtaskTraces: this.subtaskTraces,
      result,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      success,
      error,
    };

    try {
      await this.historyStorage.save(history);
      this.logger.info(`Execution history saved: ${history.sessionId}`);
    } catch (err) {
      this.logger.error(
        "Failed to save execution history:",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Calculate cost breakdown.
   */
  private calculateCost(results: SubtaskResult[]): {
    total: string;
    small: string;
    medium: string;
    large: string;
  } {
    if (!this.config.trackCost) {
      return { total: "N/A", small: "N/A", medium: "N/A", large: "N/A" };
    }

    const costs = {
      small: 0,
      medium: 0,
      large: 0,
    };

    for (const result of results) {
      if (result.tokens) {
        const tokensPerDollar = this.config.pricing[result.tier];
        const cost = result.tokens / tokensPerDollar;
        costs[result.tier] += cost;
      }
    }

    const total = costs.small + costs.medium + costs.large;

    return {
      total: `$${total.toFixed(4)}`,
      small: `$${costs.small.toFixed(4)}`,
      medium: `$${costs.medium.toFixed(4)}`,
      large: `$${costs.large.toFixed(4)}`,
    };
  }
}
