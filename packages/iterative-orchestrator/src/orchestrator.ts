/**
 * Iterative Orchestrator
 *
 * Manager-Worker Architecture:
 * - Smart orchestrator (Opus) THINKS, DECIDES, DELEGATES
 * - Cheap workers (Haiku) execute tools
 *
 * Key features:
 * - Iterative loop: think → execute → evaluate → decide
 * - Early stopping when confident
 * - Explicit user escalation when stuck
 * - Context accumulation across iterations
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk';
import { AgentExecutor } from '@kb-labs/agent-core';
import type { AgentContext, AgentConfigV1 } from '@kb-labs/agent-contracts';
import type {
  OrchestratorDecision,
  OrchestratorResponse,
  AgentResult,
  OrchestrationContext,
  OrchestrationResult,
  IterativeOrchestratorConfig,
  AgentDefinition,
  OrchestratorCallbacks,
} from './types.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: IterativeOrchestratorConfig = {
  maxIterations: 10,
  maxIterationsWithoutProgress: 3,
  confidenceThreshold: 0.8,
  timeoutMs: 300000, // 5 minutes
  tokenBudget: 0, // unlimited
};

/**
 * Orchestrator system prompt template
 */
const ORCHESTRATOR_PROMPT = `You are a senior technical lead orchestrating a team of AI agents.

## Your Role
- THINK about the task and what's needed
- DECIDE what to do next based on available information
- DELEGATE work to specialist agents (you don't execute tools directly)
- STOP when you have enough information (don't over-engineer)
- ESCALATE to the user if stuck or need clarification

## Task
{task}

## Execution History
{history}

## Available Agents
{agents}

Each agent has specific tools and expertise. You assign tasks to them.

## Your Decision Options

1. **COMPLETE** - You have enough information to answer
   Use when: confident in the answer, no more investigation needed

2. **DELEGATE** - Assign work to one agent
   Use when: need specific information or action

3. **DELEGATE_PARALLEL** - Assign work to multiple agents
   Use when: need multiple independent pieces of information
   NOTE: You will evaluate after EACH result, can stop early!

4. **ESCALATE** - Ask the user for help
   Use when: stuck, ambiguous requirements, multiple valid paths

5. **ABORT** - Cannot complete the task
   Use when: impossible requirements, missing permissions

## Critical Rules
- DO NOT delegate the same task twice
- DO NOT loop without progress - escalate instead
- DO NOT wait for all parallel tasks if you get a good answer early
- DO keep your reasoning concise but clear

## Response Format (JSON only, no markdown)
{
  "reasoning": "brief explanation of your thinking",
  "decision": {
    "type": "COMPLETE" | "DELEGATE" | "DELEGATE_PARALLEL" | "ESCALATE" | "ABORT",

    // If COMPLETE:
    "answer": "your synthesized answer",
    "confidence": 0.0-1.0,

    // If DELEGATE:
    "agentId": "agent-id",
    "task": "specific task for agent",

    // If DELEGATE_PARALLEL:
    "tasks": [
      { "agentId": "agent-1", "task": "task for agent 1" },
      { "agentId": "agent-2", "task": "task for agent 2" }
    ],

    // If ESCALATE:
    "reason": "why you're stuck",
    "question": "specific question for user",
    "options": ["Option A", "Option B", "Option C"],

    // If ABORT:
    "reason": "why task cannot be completed"
  }
}`;

/**
 * Iterative Orchestrator
 */
export class IterativeOrchestrator {
  private ctx: PluginContextV3;
  private config: IterativeOrchestratorConfig;
  private agents: Map<string, AgentDefinition>;
  private callbacks?: OrchestratorCallbacks;

  constructor(
    ctx: PluginContextV3,
    config: Partial<IterativeOrchestratorConfig> = {},
    callbacks?: OrchestratorCallbacks
  ) {
    this.ctx = ctx;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agents = new Map();
    this.callbacks = callbacks;
  }

  /**
   * Register an agent that can be delegated to
   */
  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Execute a task using iterative orchestration
   */
  async execute(task: string): Promise<OrchestrationResult> {
    const context: OrchestrationContext = {
      task,
      iteration: 0,
      results: [],
      startTime: Date.now(),
      totalTokens: 0,
      totalCost: 0,
    };

    this.ctx.platform.logger.info('Starting iterative orchestration', {
      task,
      maxIterations: this.config.maxIterations,
      agents: Array.from(this.agents.keys()),
    });

    // Main iteration loop
    while (context.iteration < this.config.maxIterations) {
      context.iteration++;

      // Check timeout
      const elapsed = Date.now() - context.startTime;
      if (elapsed > this.config.timeoutMs) {
        return this.createTimeoutResult(context);
      }

      // 1. Orchestrator thinks
      const decision = await this.think(context);
      this.callbacks?.onIteration?.(context.iteration, decision);

      this.ctx.platform.logger.info('Orchestrator decision', {
        iteration: context.iteration,
        type: decision.type,
      });

      // 2. Handle decision
      switch (decision.type) {
        case 'COMPLETE':
          return this.complete(context, decision);

        case 'DELEGATE':
          const result = await this.delegateToAgent(decision.agentId, decision.task, context);
          context.results.push(result);
          break;

        case 'DELEGATE_PARALLEL':
          // For MVP, execute sequentially with early stopping check
          for (const delegateTask of decision.tasks) {
            const parallelResult = await this.delegateToAgent(
              delegateTask.agentId,
              delegateTask.task,
              context
            );
            context.results.push(parallelResult);

            // Check if orchestrator wants to stop early
            const evalDecision = await this.think(context);
            if (evalDecision.type === 'COMPLETE') {
              return this.complete(context, evalDecision);
            }
          }
          break;

        case 'ESCALATE':
          return this.escalate(context, decision);

        case 'ABORT':
          return this.abort(context, decision);
      }
    }

    // Max iterations reached - force escalate
    return this.escalate(context, {
      type: 'ESCALATE',
      reason: `Max iterations (${this.config.maxIterations}) reached without completion`,
      question: 'The task is taking longer than expected. Should I continue with a different approach or do you want to simplify the request?',
    });
  }

  /**
   * Orchestrator thinks and decides what to do next
   */
  private async think(context: OrchestrationContext): Promise<OrchestratorDecision> {
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not available');
    }

    // Build prompt
    const prompt = this.buildPrompt(context);

    this.ctx.platform.logger.debug('Orchestrator thinking', {
      iteration: context.iteration,
      promptLength: prompt.length,
    });

    // Call LLM
    const response = await llm.complete(prompt, {
      temperature: 0.3, // Low temperature for consistent decisions
      maxTokens: 2000,
    });

    context.totalTokens += response.usage.promptTokens + response.usage.completionTokens;

    // Parse response
    const parsed = this.parseResponse(response.content || '');

    this.ctx.platform.logger.debug('Orchestrator decision parsed', {
      reasoning: parsed.reasoning,
      decisionType: parsed.decision.type,
    });

    return parsed.decision;
  }

  /**
   * Delegate task to a worker agent
   */
  private async delegateToAgent(
    agentId: string,
    task: string,
    context: OrchestrationContext
  ): Promise<AgentResult> {
    const startTime = Date.now();

    this.ctx.platform.logger.info('Delegating to agent', {
      agentId,
      task,
      iteration: context.iteration,
    });

    this.callbacks?.onAgentStart?.(agentId, task);

    const agent = this.agents.get(agentId);
    if (!agent) {
      const errorResult: AgentResult = {
        agentId,
        task,
        result: `Agent "${agentId}" not found`,
        success: false,
        iteration: context.iteration,
        durationMs: Date.now() - startTime,
        error: `Agent "${agentId}" not registered`,
      };
      this.callbacks?.onAgentComplete?.(errorResult);
      return errorResult;
    }

    try {
      // Create agent executor
      const executor = new AgentExecutor(this.ctx);

      // Build agent context
      const agentConfig: AgentConfigV1 = {
        schema: 'kb.agent/1',
        id: agentId,
        name: agent.name,
        description: agent.description,
        llm: {
          tier: 'small', // Cheap model for workers
          temperature: 0.7,
          maxTokens: 4000,
          maxToolCalls: 10,
        },
        tools: {
          kbLabs: {
            mode: 'allowlist',
            allow: agent.tools,
          },
        },
      };

      const agentContext: AgentContext = {
        config: agentConfig,
        tools: [], // TODO: Load tools based on agent definition
      };

      // Execute agent
      const result = await executor.execute(agentContext, task);

      const agentResult: AgentResult = {
        agentId,
        task,
        result: result.result || '',
        success: result.success,
        iteration: context.iteration,
        durationMs: Date.now() - startTime,
        tokens: result.totalTokens,
        error: result.error?.message,
      };

      this.callbacks?.onAgentComplete?.(agentResult);

      this.ctx.platform.logger.info('Agent completed', {
        agentId,
        success: result.success,
        durationMs: agentResult.durationMs,
      });

      return agentResult;
    } catch (error) {
      const errorResult: AgentResult = {
        agentId,
        task,
        result: '',
        success: false,
        iteration: context.iteration,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };

      this.callbacks?.onAgentComplete?.(errorResult);

      this.ctx.platform.logger.error('Agent execution failed', error instanceof Error ? error : new Error(String(error)));

      return errorResult;
    }
  }

  /**
   * Complete the orchestration with an answer
   */
  private complete(
    context: OrchestrationContext,
    decision: { type: 'COMPLETE'; answer: string; confidence: number }
  ): OrchestrationResult {
    this.ctx.platform.logger.info('Orchestration completed', {
      iterations: context.iteration,
      confidence: decision.confidence,
      agentCalls: context.results.length,
    });

    return {
      success: true,
      answer: decision.answer,
      confidence: decision.confidence,
      stats: this.buildStats(context),
    };
  }

  /**
   * Escalate to user for clarification
   */
  private async escalate(
    context: OrchestrationContext,
    decision: { type: 'ESCALATE'; reason: string; question: string; options?: string[] }
  ): Promise<OrchestrationResult> {
    this.ctx.platform.logger.warn('Orchestration escalating to user', {
      reason: decision.reason,
      question: decision.question,
    });

    // Try to get user response via callback
    const userResponse = await this.callbacks?.onEscalate?.(decision.reason, decision.question);

    if (userResponse) {
      // User provided input - continue orchestration
      this.ctx.platform.logger.info('User provided escalation response', {
        response: userResponse.slice(0, 100),
      });

      // Add user response to context and continue
      context.results.push({
        agentId: 'user',
        task: decision.question,
        result: userResponse,
        success: true,
        iteration: context.iteration,
        durationMs: 0,
      });

      // Re-think with user input
      const newDecision = await this.think(context);

      if (newDecision.type === 'COMPLETE') {
        return this.complete(context, newDecision);
      }

      // Continue loop would require recursion - for now return escalation
    }

    return {
      success: false,
      escalation: {
        reason: decision.reason,
        question: decision.question,
        options: decision.options,
      },
      stats: this.buildStats(context),
    };
  }

  /**
   * Abort the orchestration
   */
  private abort(
    context: OrchestrationContext,
    decision: { type: 'ABORT'; reason: string }
  ): OrchestrationResult {
    this.ctx.platform.logger.warn('Orchestration aborted', {
      reason: decision.reason,
    });

    return {
      success: false,
      abort: {
        reason: decision.reason,
      },
      stats: this.buildStats(context),
    };
  }

  /**
   * Create timeout result
   */
  private createTimeoutResult(context: OrchestrationContext): OrchestrationResult {
    this.ctx.platform.logger.warn('Orchestration timed out', {
      timeoutMs: this.config.timeoutMs,
      iterations: context.iteration,
    });

    return {
      success: false,
      abort: {
        reason: `Timeout after ${this.config.timeoutMs}ms`,
      },
      stats: this.buildStats(context),
    };
  }

  /**
   * Build orchestrator prompt
   */
  private buildPrompt(context: OrchestrationContext): string {
    // Format execution history
    const history = context.results.length === 0
      ? '(No previous actions)'
      : context.results.map((r, i) => {
          const status = r.success ? '✓' : '✗';
          const truncatedResult = r.result.length > 500
            ? r.result.slice(0, 500) + '...'
            : r.result;
          return `${i + 1}. [${status}] Agent: ${r.agentId}\n   Task: ${r.task}\n   Result: ${truncatedResult}`;
        }).join('\n\n');

    // Format available agents
    const agents = Array.from(this.agents.values())
      .map(a => `- **${a.id}**: ${a.description}\n  Tools: ${a.tools.join(', ')}`)
      .join('\n');

    return ORCHESTRATOR_PROMPT
      .replace('{task}', context.task)
      .replace('{history}', history)
      .replace('{agents}', agents || '(No agents registered)');
  }

  /**
   * Parse LLM response into decision
   */
  private parseResponse(content: string): OrchestratorResponse {
    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: treat as direct answer
      return {
        reasoning: 'Could not parse structured response',
        decision: {
          type: 'COMPLETE',
          answer: content,
          confidence: 0.5,
        },
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        reasoning: parsed.reasoning || '',
        decision: parsed.decision,
      };
    } catch {
      return {
        reasoning: 'JSON parse failed',
        decision: {
          type: 'COMPLETE',
          answer: content,
          confidence: 0.5,
        },
      };
    }
  }

  /**
   * Build execution statistics
   */
  private buildStats(context: OrchestrationContext): OrchestrationResult['stats'] {
    const durationMs = Date.now() - context.startTime;
    const agentTokens = context.results.reduce((sum, r) => sum + (r.tokens || 0), 0);

    return {
      iterations: context.iteration,
      agentCalls: context.results.length,
      durationMs,
      totalTokens: context.totalTokens + agentTokens,
      estimatedCost: this.estimateCost(context.totalTokens, agentTokens),
    };
  }

  /**
   * Estimate cost based on tokens
   */
  private estimateCost(orchestratorTokens: number, agentTokens: number): number {
    // Rough estimates:
    // Orchestrator (Opus): ~$15/M input, ~$75/M output (assume 50/50 split)
    // Agents (Haiku): ~$0.25/M input, ~$1.25/M output
    const orchestratorCost = (orchestratorTokens / 1_000_000) * 45; // Average
    const agentCost = (agentTokens / 1_000_000) * 0.75; // Average
    return orchestratorCost + agentCost;
  }
}
