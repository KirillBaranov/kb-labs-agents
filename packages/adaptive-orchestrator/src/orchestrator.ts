/**
 * @module @kb-labs/adaptive-orchestrator/orchestrator
 * Adaptive agent orchestrator with tier-based model selection.
 *
 * Coordinates task classification, planning, execution, and synthesis
 * with automatic tier escalation and cost optimization.
 */

import type { ILLM, ILogger, LLMTier } from '@kb-labs/sdk';
import { useLLM, useAnalytics } from '@kb-labs/sdk';
import { HybridComplexityClassifier } from '@kb-labs/task-classifier';
import { ProgressReporter, type ProgressCallback } from '@kb-labs/progress-reporter';
import { OrchestrationAnalytics } from './analytics.js';
import type {
  ExecutionPlan,
  Subtask,
  SubtaskResult,
  OrchestratorResult,
  OrchestratorConfig,
} from './types.js';

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

  constructor(
    private logger: ILogger,
    onProgress?: ProgressCallback,
    config?: OrchestratorConfig
  ) {
    // Initialize classifier with small tier (cheap for classification)
    const classifierLLM = useLLM({ tier: 'small' });
    if (!classifierLLM) {
      throw new Error('LLM not available. Cannot create classifier.');
    }
    this.classifier = new HybridComplexityClassifier(classifierLLM);

    // Initialize progress reporter
    this.reporter = new ProgressReporter(logger, onProgress);

    // Initialize analytics
    const analyticsAdapter = useAnalytics();
    this.analytics = new OrchestrationAnalytics(analyticsAdapter);

    // Default config
    this.config = {
      maxEscalations: config?.maxEscalations ?? 2,
      trackCost: config?.trackCost ?? true,
      pricing: config?.pricing ?? {
        small: 1_000_000,   // $1 per 1M tokens
        medium: 500_000,    // $1 per 500K tokens
        large: 100_000,     // $1 per 100K tokens
      },
    };
  }

  /**
   * Execute task with adaptive orchestration.
   */
  async execute(task: string): Promise<OrchestratorResult> {
    const startTime = Date.now();

    // 1. Start tracking
    this.reporter.start(task);
    this.analytics.trackTaskStarted(task);

    try {
      // 2. Classify task complexity
      const { tier, confidence, method } = await this.classifier.classify({
        taskDescription: task,
      });
      this.reporter.classified(tier, confidence, method);
      this.analytics.trackClassification(tier, confidence, method);

      // 3. Planning phase (use classified tier)
      this.reporter.planning('started');
      const llm = useLLM({ tier });
      if (!llm) {
        throw new Error(`LLM not available for tier: ${tier}`);
      }

      const plan = await this.createPlan(llm, task);
      this.reporter.planning('completed', { subtaskCount: plan.subtasks.length });

      // Track tier distribution in plan
      const tierDistribution = plan.subtasks.reduce(
        (acc, st) => {
          acc[st.complexity] = (acc[st.complexity] || 0) + 1;
          return acc;
        },
        {} as Record<LLMTier, number>
      );
      this.analytics.trackPlanningCompleted(plan.subtasks.length, tierDistribution);

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
      this.reporter.complete('success', costBreakdown);

      const orchestratorResult: OrchestratorResult = {
        status: 'success',
        result: finalResult,
        costBreakdown,
        subtaskResults: results,
      };

      this.analytics.trackTaskCompleted(task, orchestratorResult, duration);

      return orchestratorResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.reporter.complete('failed', {
        total: 'N/A',
        small: 'N/A',
        medium: 'N/A',
        large: 'N/A',
      });
      this.analytics.trackTaskFailed(
        task,
        error instanceof Error ? error : new Error(String(error)),
        duration
      );
      throw error;
    }
  }

  /**
   * Create execution plan for task.
   */
  private async createPlan(llm: ILLM, task: string): Promise<ExecutionPlan> {
    const prompt = `You are a task planning assistant. Break down the following task into subtasks.

Task: ${task}

Respond with a JSON array of subtasks. Each subtask should have:
- id: number (1-based)
- description: string
- complexity: "small" | "medium" | "large"

Example:
[
  {"id": 1, "description": "Research authentication methods", "complexity": "small"},
  {"id": 2, "description": "Implement JWT service", "complexity": "medium"},
  {"id": 3, "description": "Write integration tests", "complexity": "small"}
]

Respond with ONLY the JSON array, no markdown.`;

    const response = await llm.complete(prompt, {
      maxTokens: 500,
      temperature: 0.3,
    });

    try {
      const subtasks = JSON.parse(response.content.trim());
      return { subtasks };
    } catch (error) {
      this.logger.error(`Failed to parse plan JSON: ${response.content.slice(0, 200)}`);
      // Fallback: treat as single subtask
      return {
        subtasks: [
          {
            id: 1,
            description: task,
            complexity: 'medium',
          },
        ],
      };
    }
  }

  /**
   * Execute subtask with automatic retry and escalation.
   */
  private async executeSubtaskWithRetry(subtask: Subtask): Promise<SubtaskResult> {
    let currentTier = subtask.complexity;
    let attempts = 0;

    while (attempts <= this.config.maxEscalations) {
      try {
        // Report start
        this.reporter.subtask(
          subtask.id,
          subtask.description,
          currentTier,
          'started'
        );

        // Execute with current tier
        const result = await this.executeSubtask(subtask, currentTier);

        // Report completion
        this.reporter.subtask(
          subtask.id,
          subtask.description,
          currentTier,
          'completed'
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
              'failed',
              { error: error instanceof Error ? error.message : 'Unknown error' }
            );
            throw error;
          }

          // Escalate
          const reason = error instanceof Error ? error.message : 'Unknown error';
          this.reporter.escalated(subtask.id, currentTier, nextTier, reason);
          this.analytics.trackTierEscalated(subtask.id, currentTier, nextTier, reason);
          currentTier = nextTier;
        } else {
          // No more attempts, fail
          this.reporter.subtask(
            subtask.id,
            subtask.description,
            currentTier,
            'failed',
            { error: error instanceof Error ? error.message : 'Unknown error' }
          );
          throw error;
        }
      }
    }

    throw new Error('Max escalations reached');
  }

  /**
   * Execute single subtask with specified tier.
   */
  private async executeSubtask(
    subtask: Subtask,
    tier: LLMTier
  ): Promise<SubtaskResult> {
    const llm = useLLM({ tier });
    if (!llm) {
      throw new Error(`LLM not available for tier: ${tier}`);
    }

    const prompt = `Execute the following subtask:\n\n${subtask.description}\n\nProvide a concise result.`;

    const response = await llm.complete(prompt, {
      maxTokens: 1000,
      temperature: 0.5,
    });

    // Estimate tokens (rough approximation)
    const tokens = Math.ceil((prompt.length + response.content.length) / 4);

    return {
      id: subtask.id,
      status: 'success',
      tier,
      content: response.content,
      tokens,
    };
  }

  /**
   * Synthesize final result from subtask results.
   */
  private async synthesize(
    llm: ILLM,
    originalTask: string,
    results: SubtaskResult[]
  ): Promise<string> {
    const subtaskSummary = results
      .map((r) => `[${r.id}] ${r.content?.slice(0, 200) || 'No content'}`)
      .join('\n\n');

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
      case 'small':
        return 'medium';
      case 'medium':
        return 'large';
      case 'large':
        return 'large'; // Already at max
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
      return { total: 'N/A', small: 'N/A', medium: 'N/A', large: 'N/A' };
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
