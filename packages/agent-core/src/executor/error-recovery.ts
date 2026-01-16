/**
 * Error Recovery System
 *
 * Provides adaptive error recovery strategies when agent gets stuck or encounters failures.
 *
 * Problem: Agent gives up after first tool failure or gets stuck in unproductive loops.
 * Solution: Analyze failure context and try alternative approaches automatically.
 *
 * Benefits:
 * - Increases success rate by trying multiple strategies
 * - Reduces need for manual intervention
 * - Learns from blockers identified by ProgressTracker
 * - Foundation for zero-config self-learning (Phase 5)
 */

import type { AgentExecutionStep, ToolCall } from '@kb-labs/agent-contracts';
import type { ExecutionMemory } from './execution-memory.js';
import type { ProgressEstimate } from './progress-tracker.js';
import type { ILLM } from '@kb-labs/sdk';

/**
 * Recovery strategy type
 */
export type RecoveryStrategyType =
  | 'retry' // Retry same tool with backoff
  | 'alternative-tool' // Try different tool for same goal
  | 'parameter-adjustment' // Modify tool parameters
  | 'escalate' // Ask user for help
  | 'give-up'; // Accept failure gracefully

/**
 * Recovery action to take
 */
export interface RecoveryAction {
  /** Strategy to use */
  strategy: RecoveryStrategyType;

  /** Reasoning for this strategy */
  reasoning: string;

  /** Specific action details */
  action: {
    /** Tool to call (may differ from failed tool) */
    toolName: string;

    /** Adjusted parameters */
    parameters?: Record<string, unknown>;

    /** Message for user if escalating */
    escalationMessage?: string;
  };

  /** Expected outcome */
  expectedOutcome: string;

  /** Confidence in this strategy (0-1) */
  confidence: number;
}

/**
 * Recovery attempt result
 */
export interface RecoveryResult {
  /** Whether recovery succeeded */
  success: boolean;

  /** Strategy that was attempted */
  strategy: RecoveryStrategyType;

  /** New tool call if any */
  newToolCall?: ToolCall;

  /** Reason for failure if unsuccessful */
  failureReason?: string;
}

/**
 * Error Recovery Engine
 *
 * Analyzes stuck situations and generates recovery strategies.
 */
export class ErrorRecovery {
  private maxRetries = 2;
  private retryAttempts = new Map<string, number>(); // toolName -> attempt count

  constructor(private llm: ILLM) {}

  /**
   * Determine if recovery should be attempted
   *
   * @param progressEstimate Progress estimate from ProgressTracker
   * @param memory Execution memory with context
   * @returns Whether to attempt recovery
   */
  shouldAttemptRecovery(progressEstimate: ProgressEstimate, memory: ExecutionMemory): boolean {
    // Attempt recovery if:
    // 1. Agent is stuck (no progress)
    // 2. OR there are blockers identified
    // 3. OR progress is very low (<20%) after 5+ steps
    const isStuck = progressEstimate.isStuck;
    const hasBlockers = progressEstimate.blockers.length > 0;
    const lowProgressManySteps =
      progressEstimate.progressPercent < 20 && memory.completedSteps.length >= 5;

    return isStuck || hasBlockers || lowProgressManySteps;
  }

  /**
   * Generate recovery action based on context
   *
   * Uses LLM to analyze situation and suggest best recovery strategy.
   *
   * @param progressEstimate Progress estimate with blockers
   * @param memory Execution memory
   * @param latestStep Latest execution step (may have failed tool calls)
   * @returns Recovery action to take
   */
  async generateRecoveryAction(
    progressEstimate: ProgressEstimate,
    memory: ExecutionMemory,
    latestStep: AgentExecutionStep
  ): Promise<RecoveryAction> {
    const prompt = this.buildRecoveryPrompt(progressEstimate, memory, latestStep);

    try {
      const response = await this.llm.complete(prompt, {
        systemPrompt: this.getSystemPrompt(),
        temperature: 0.2, // Slightly higher for creative problem-solving
        maxTokens: 600,
      });

      return this.parseRecoveryResponse(response.content);
    } catch (error) {
      // Fallback: Basic retry strategy
      return this.getFallbackRecoveryAction(latestStep);
    }
  }

  /**
   * Check if we should give up (too many failed recovery attempts)
   *
   * @param toolName Tool that keeps failing
   * @returns Whether to give up
   */
  shouldGiveUp(toolName: string): boolean {
    const attempts = this.retryAttempts.get(toolName) || 0;
    return attempts >= this.maxRetries;
  }

  /**
   * Record recovery attempt
   *
   * @param toolName Tool being retried
   */
  recordAttempt(toolName: string): void {
    const current = this.retryAttempts.get(toolName) || 0;
    this.retryAttempts.set(toolName, current + 1);
  }

  /**
   * Clear retry attempts (e.g., after successful recovery)
   */
  clearAttempts(): void {
    this.retryAttempts.clear();
  }

  /**
   * Build recovery prompt for LLM
   */
  private buildRecoveryPrompt(
    progressEstimate: ProgressEstimate,
    memory: ExecutionMemory,
    latestStep: AgentExecutionStep
  ): string {
    const failedTools = latestStep.toolCalls?.filter((tc) => !tc.success) || [];
    const failedToolNames = failedTools.map((tc) => tc.name).join(', ');
    const errorMessages = failedTools.map((tc) => tc.error || 'Unknown error').join('; ');

    return `
Task Goal: ${memory.taskGoal}

Current Situation:
- Progress: ${progressEstimate.progressPercent}%
- Stuck: ${progressEstimate.isStuck ? 'YES' : 'NO'}
- Blockers: ${progressEstimate.blockers.length > 0 ? progressEstimate.blockers.join(', ') : 'None'}
- Next Milestone: ${progressEstimate.nextMilestone}

Latest Failed Action:
- Tools: ${failedToolNames || 'none'}
- Errors: ${errorMessages || 'none'}

Known Facts (what we learned so far):
${memory.knownFacts.length > 0 ? memory.knownFacts.map((f) => `- ${f}`).join('\n') : '(None yet)'}

Suggest a recovery strategy:

Available Strategies:
1. **retry** - Try same tool again (if transient error)
2. **alternative-tool** - Use different tool to achieve same goal
3. **parameter-adjustment** - Modify tool parameters (e.g., search pattern, file path)
4. **escalate** - Ask user for help (if stuck completely)
5. **give-up** - Accept failure gracefully (if goal is impossible)

Consider:
- What alternative approaches could work?
- Are the blockers resolvable?
- Is the error transient or fundamental?

Output JSON:
{
  "strategy": "retry|alternative-tool|parameter-adjustment|escalate|give-up",
  "reasoning": "why this strategy",
  "action": {
    "toolName": "tool to use",
    "parameters": { "adjusted": "parameters" },
    "escalationMessage": "message for user if escalating"
  },
  "expectedOutcome": "what we hope to achieve",
  "confidence": 0.0-1.0
}
`.trim();
  }

  /**
   * System prompt for recovery analysis
   */
  private getSystemPrompt(): string {
    return `
You are an error recovery specialist for an AI agent.

Your job is to:
1. Analyze why the agent is stuck or failing
2. Identify the root cause (bad parameters, wrong tool, impossible goal, etc.)
3. Suggest the most likely strategy to recover
4. Be realistic about confidence (don't suggest retry if error is fundamental)

Guidelines:
- **retry**: Only if error seems transient (network, timeout, etc.)
- **alternative-tool**: If wrong tool was chosen (e.g., fs:search failed → try mind:rag-query)
- **parameter-adjustment**: If tool is right but parameters are wrong (e.g., wrong file path)
- **escalate**: If you need information only user can provide
- **give-up**: If goal is genuinely impossible (file doesn't exist, no such feature, etc.)

Respond ONLY with valid JSON.
`.trim();
  }

  /**
   * Parse LLM recovery response
   */
  private parseRecoveryResponse(response: string): RecoveryAction {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        strategy: parsed.strategy as RecoveryStrategyType,
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        action: {
          toolName: String(parsed.action?.toolName || ''),
          parameters: parsed.action?.parameters || undefined,
          escalationMessage: parsed.action?.escalationMessage || undefined,
        },
        expectedOutcome: String(parsed.expectedOutcome || 'Unknown'),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      };
    } catch (error) {
      // Parsing failed, return fallback
      return {
        strategy: 'escalate',
        reasoning: `Failed to parse recovery strategy: ${error}`,
        action: {
          toolName: '',
          escalationMessage: 'Agent encountered an error and needs help',
        },
        expectedOutcome: 'User provides guidance',
        confidence: 0.3,
      };
    }
  }

  /**
   * Fallback recovery action if LLM fails
   */
  private getFallbackRecoveryAction(latestStep: AgentExecutionStep): RecoveryAction {
    const failedTools = latestStep.toolCalls?.filter((tc) => !tc.success) || [];

    if (failedTools.length === 0) {
      // No failed tools, just stuck - escalate
      return {
        strategy: 'escalate',
        reasoning: 'No clear failure, but agent is stuck',
        action: {
          toolName: '',
          escalationMessage: 'Agent is not making progress. Please provide guidance.',
        },
        expectedOutcome: 'User provides guidance',
        confidence: 0.5,
      };
    }

    const firstFailedTool = failedTools[0];
    if (!firstFailedTool) {
      // Shouldn't happen but TypeScript needs this check
      return {
        strategy: 'escalate',
        reasoning: 'No failed tools found',
        action: {
          toolName: '',
          escalationMessage: 'Agent is stuck but no failed tools found.',
        },
        expectedOutcome: 'User provides guidance',
        confidence: 0.5,
      };
    }

    // Simple heuristic: retry once, then give up
    if (!this.shouldGiveUp(firstFailedTool.name)) {
      return {
        strategy: 'retry',
        reasoning: 'Simple retry fallback',
        action: {
          toolName: firstFailedTool.name,
          parameters: firstFailedTool.input as Record<string, unknown>,
        },
        expectedOutcome: 'Tool succeeds on retry',
        confidence: 0.4,
      };
    }

    return {
      strategy: 'give-up',
      reasoning: 'Max retries exceeded',
      action: {
        toolName: '',
      },
      expectedOutcome: 'Accept failure gracefully',
      confidence: 0.8,
    };
  }
}
