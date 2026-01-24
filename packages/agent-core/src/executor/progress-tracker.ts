/**
 * Progress Tracker
 *
 * Estimates progress toward task completion using LLM-based analysis.
 *
 * Problem: Agent doesn't know if it's making progress or stuck in loops.
 * Solution: After each step, use LLM to estimate progress % and identify blockers.
 *
 * Benefits:
 * - Detects when agent is stuck (no progress over N steps)
 * - Identifies blockers early
 * - Provides progress visibility to users
 * - Enables adaptive strategies (retry, escalate, give up)
 */

import type { AgentExecutionStep } from "@kb-labs/agent-contracts";
import type { ExecutionMemory } from "./execution-memory.js";
import type { ILLM } from "@kb-labs/sdk";

/**
 * Progress estimation result
 */
export interface ProgressEstimate {
  /** Progress percentage (0-100) */
  progressPercent: number;

  /** LLM reasoning for this estimate */
  reasoning: string;

  /** Next expected milestone */
  nextMilestone: string;

  /** Current blockers preventing progress */
  blockers: string[];

  /** Whether agent appears stuck (no progress) */
  isStuck: boolean;
}

/**
 * Progress history entry
 */
interface ProgressHistory {
  step: number;
  progressPercent: number;
  timestamp: number;
}

/**
 * Progress Tracker
 *
 * Uses LLM to estimate task completion progress after each step.
 */
export class ProgressTracker {
  private history: ProgressHistory[] = [];
  private stuckThreshold = 3; // Steps without progress before marking as stuck

  constructor(private llm: ILLM) {}

  /**
   * Estimate progress toward task completion
   *
   * @param memory Execution memory with learned facts
   * @param task Original task description
   * @param latestStep Most recent execution step
   * @returns Progress estimate
   */
  async estimateProgress(
    memory: ExecutionMemory,
    task: string,
    latestStep: AgentExecutionStep,
  ): Promise<ProgressEstimate> {
    const prompt = this.buildProgressPrompt(memory, latestStep);

    try {
      const response = await this.llm.complete(prompt, {
        systemPrompt: this.getSystemPrompt(),
        temperature: 0.1,
        maxTokens: 500,
      });

      const estimate = this.parseProgressResponse(response.content);

      // Record in history
      this.history.push({
        step: latestStep.step,
        progressPercent: estimate.progressPercent,
        timestamp: Date.now(),
      });

      // Check if stuck
      estimate.isStuck = this.isStuck();

      return estimate;
    } catch (error) {
      // Fallback: assume progress based on tool calls
      const hasToolCalls = (latestStep.toolCalls?.length || 0) > 0;
      const hasSuccess =
        latestStep.toolCalls?.some((tc) => tc.success) || false;

      return {
        progressPercent: hasSuccess ? 50 : 0,
        reasoning: "Failed to estimate progress (LLM error)",
        nextMilestone: "Unknown",
        blockers: [],
        isStuck: false,
      };
    }
  }

  /**
   * Clear progress history
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Get progress history
   */
  getHistory(): ProgressHistory[] {
    return [...this.history];
  }

  /**
   * Check if agent appears stuck (no progress over threshold steps)
   */
  private isStuck(): boolean {
    if (this.history.length < this.stuckThreshold) {
      return false;
    }

    // Get last N entries
    const recent = this.history.slice(-this.stuckThreshold);

    // Check if progress hasn't increased
    const maxProgress = Math.max(...recent.map((h) => h.progressPercent));
    const minProgress = Math.min(...recent.map((h) => h.progressPercent));

    // Stuck if progress variance is less than 5% over threshold steps
    return maxProgress - minProgress < 5;
  }

  /**
   * Build progress estimation prompt (following roadmap structure)
   */
  private buildProgressPrompt(
    memory: ExecutionMemory,
    latestStep: AgentExecutionStep,
  ): string {
    const latestAction =
      latestStep.toolCalls?.map((tc) => tc.name).join(", ") || "none";
    const latestOutcome = latestStep.toolCalls?.every((tc) => tc.success)
      ? "success"
      : latestStep.toolCalls?.some((tc) => tc.success)
        ? "partial"
        : "failure";

    return `
Task Goal: ${memory.taskGoal}

Completed Steps: ${memory.completedSteps.length}
Latest Action: ${latestAction}
Latest Outcome: ${latestOutcome}

Known Facts:
${memory.knownFacts.length > 0 ? memory.knownFacts.map((f) => `- ${f}`).join("\n") : "(None yet)"}

Estimate progress toward goal (0-100%):
Consider:
- What portion of the goal is achieved?
- What critical information is still missing?
- How many steps remaining (estimate)?

Output JSON:
{
  "progressPercent": 0-100,
  "reasoning": "why this estimate",
  "nextMilestone": "what needs to happen next",
  "blockers": ["list any blockers"]
}
`.trim();
  }

  /**
   * System prompt for progress estimation
   */
  private getSystemPrompt(): string {
    return `
You are a progress estimator for an AI agent.

Your job is to:
1. Analyze what the agent has learned so far
2. Evaluate the latest step's contribution
3. Estimate how close the agent is to completing the task (0-100%)
4. Identify any blockers

Guidelines:
- 0%: Task just started, no meaningful progress
- 25%: Agent found relevant files/info but hasn't extracted answer yet
- 50%: Agent gathered key information, halfway to answer
- 75%: Agent has most of the answer, refining details
- 100%: Task fully completed

Be honest about blockers:
- Tool failures
- Missing information
- Circular reasoning
- Dead ends

Respond ONLY with valid JSON.
`.trim();
  }

  /**
   * Parse LLM response into ProgressEstimate
   */
  private parseProgressResponse(response: string): ProgressEstimate {
    try {
      // Extract JSON from response (LLM might add text around it)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and clamp progress
      const progressPercent = Math.max(
        0,
        Math.min(100, Number(parsed.progressPercent) || 0),
      );

      return {
        progressPercent,
        reasoning: String(parsed.reasoning || "No reasoning provided"),
        nextMilestone: String(parsed.nextMilestone || "Unknown"),
        blockers: Array.isArray(parsed.blockers)
          ? parsed.blockers.map(String)
          : [],
        isStuck: false, // Will be set by caller
      };
    } catch (error) {
      // Parsing failed, return pessimistic estimate
      return {
        progressPercent: 0,
        reasoning: `Failed to parse progress estimate: ${error}`,
        nextMilestone: "Unknown",
        blockers: ["LLM response parsing failed"],
        isStuck: false,
      };
    }
  }
}
