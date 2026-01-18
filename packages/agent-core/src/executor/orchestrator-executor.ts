/**
 * Orchestrator Executor (V2 Architecture)
 *
 * Smart orchestrator that:
 * - Breaks complex tasks into subtasks
 * - Delegates subtasks to specialists
 * - Synthesizes results into coherent answer
 * - Uses smart tier LLM (e.g., GPT-4) for planning/synthesis
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk';
import type { SpecialistConfigV1 } from '@kb-labs/agent-contracts';
import { SpecialistExecutor, type SpecialistContext, type SpecialistResult } from './specialist-executor.js';
import { SpecialistRegistry } from '../registry/specialist-registry.js';
import { ToolDiscoverer } from '../tools/tool-discoverer.js';

/**
 * Subtask definition
 */
export interface SubTask {
  id: string; // Unique subtask ID (e.g., "subtask-1")
  description: string; // What needs to be done
  specialistId: string; // Which specialist should handle this
  dependencies?: string[]; // IDs of subtasks that must complete first
  priority?: number; // Higher = more important (1-10)
  estimatedComplexity?: 'low' | 'medium' | 'high'; // Complexity estimate
}

/**
 * Result from a specialist execution
 */
export interface DelegatedResult {
  subtaskId: string;
  specialistId: string;
  success: boolean;
  output: unknown;
  error?: string;
  tokensUsed: number;
  durationMs: number;
}

/**
 * Orchestrator execution result
 */
export interface OrchestratorResult {
  success: boolean;
  answer: string; // Final synthesized answer
  plan: SubTask[]; // Original execution plan
  delegatedResults: DelegatedResult[]; // Results from specialists
  tokensUsed: number; // Total tokens (planning + specialists + synthesis)
  durationMs: number;
  error?: string;
}

/**
 * Orchestrator Executor
 *
 * Manages task delegation to specialists:
 * 1. planExecution() - Break task into subtasks using smart LLM
 * 2. selectSpecialist() - Match subtasks to specialist capabilities
 * 3. delegateTask() - Execute subtask via SpecialistExecutor
 * 4. synthesizeResults() - Combine specialist outputs into final answer
 */
export class OrchestratorExecutor {
  private registry: SpecialistRegistry;
  private toolDiscoverer: ToolDiscoverer;
  private specialistExecutor: SpecialistExecutor;

  constructor(private ctx: PluginContextV3) {
    this.registry = new SpecialistRegistry(ctx);
    this.toolDiscoverer = new ToolDiscoverer(ctx);
    this.specialistExecutor = new SpecialistExecutor(ctx);
  }

  /**
   * Execute a complex task via delegation to specialists
   *
   * @param task - High-level task description
   * @returns Orchestration result with synthesized answer
   */
  async execute(task: string): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    this.ctx.platform.logger.info('Orchestrator started', { task });

    try {
      // Step 1: Plan execution (decompose task into subtasks)
      this.ctx.platform.logger.info('Planning execution...');
      const { plan, tokensUsed: planTokens } = await this.planExecution(task);
      totalTokens += planTokens;

      this.ctx.platform.logger.info('Execution plan created', {
        subtasks: plan.length,
        tokensUsed: planTokens,
      });

      // Step 2: Execute subtasks in order (respecting dependencies)
      this.ctx.platform.logger.info('Executing subtasks...');
      const delegatedResults: DelegatedResult[] = [];

      for (const subtask of plan) {
        // Check dependencies
        if (subtask.dependencies && subtask.dependencies.length > 0) {
          const dependenciesMet = subtask.dependencies.every((depId) =>
            delegatedResults.some((r) => r.subtaskId === depId && r.success)
          );

          if (!dependenciesMet) {
            this.ctx.platform.logger.warn('Subtask dependencies not met, skipping', {
              subtaskId: subtask.id,
              dependencies: subtask.dependencies,
            });
            continue;
          }
        }

        // Execute subtask
        const result = await this.delegateTask(subtask);
        delegatedResults.push(result);
        totalTokens += result.tokensUsed;

        this.ctx.platform.logger.info('Subtask completed', {
          subtaskId: subtask.id,
          specialistId: subtask.specialistId,
          success: result.success,
          tokensUsed: result.tokensUsed,
        });

        // Stop if critical subtask failed
        if (!result.success && subtask.priority && subtask.priority >= 8) {
          this.ctx.platform.logger.error('Critical subtask failed, aborting', new Error(
            `Subtask ${subtask.id} failed: ${result.error || 'unknown error'}`
          ));
          break;
        }
      }

      // Step 3: Synthesize results into final answer
      this.ctx.platform.logger.info('Synthesizing results...');
      const { answer, tokensUsed: synthesisTokens } = await this.synthesizeResults(
        task,
        plan,
        delegatedResults
      );
      totalTokens += synthesisTokens;

      const durationMs = Date.now() - startTime;

      this.ctx.platform.logger.info('Orchestrator completed', {
        success: true,
        subtasks: plan.length,
        tokensUsed: totalTokens,
        durationMs,
      });

      return {
        success: true,
        answer,
        plan,
        delegatedResults,
        tokensUsed: totalTokens,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error('Orchestrator failed', error instanceof Error ? error : new Error(errorMessage));

      return {
        success: false,
        answer: '',
        plan: [],
        delegatedResults: [],
        tokensUsed: totalTokens,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Plan execution by decomposing task into subtasks
   *
   * Uses smart tier LLM to analyze task and create execution plan.
   * Considers available specialists and their capabilities.
   *
   * @param task - High-level task description
   * @returns Execution plan with subtasks
   */
  private async planExecution(
    task: string
  ): Promise<{ plan: SubTask[]; tokensUsed: number }> {
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not available for orchestrator planning');
    }

    // Load available specialists
    const specialists = await this.registry.list();
    const specialistDescriptions = specialists
      .map(
        (s) =>
          `- ${s.id}: ${s.description || 'No description'}\n  Capabilities: ${s.capabilities?.join(', ') || 'None'}`
      )
      .join('\n');

    const systemPrompt = `You are an AI orchestrator that breaks complex tasks into subtasks.

# Available Specialists:
${specialistDescriptions}

# Your Role:
1. Analyze the task
2. Break it into logical subtasks
3. Assign each subtask to the most appropriate specialist
4. Define dependencies between subtasks
5. Assign priority (1-10, higher = more critical)

# Output Format:
Return a JSON array of subtasks in this exact format:

\`\`\`json
[
  {
    "id": "subtask-1",
    "description": "Clear description of what to do",
    "specialistId": "researcher",
    "dependencies": [],
    "priority": 8,
    "estimatedComplexity": "medium"
  }
]
\`\`\`

**Rules:**
1. Each subtask must have a unique id (subtask-1, subtask-2, etc.)
2. Use only specialist IDs from the list above
3. Keep subtask descriptions clear and actionable
4. Priority: 10 = critical, 1 = optional
5. Dependencies: array of subtask IDs that must complete first
6. Return ONLY the JSON array, no extra text`;

    const userPrompt = `Task: ${task}\n\nCreate an execution plan by breaking this task into subtasks and assigning them to specialists.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for planning
      }
    );

    const content = response.content || '';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    // Extract JSON from response
    const plan = this.extractPlan(content);

    return { plan, tokensUsed };
  }

  /**
   * Extract execution plan from LLM response
   *
   * Tries multiple strategies to parse JSON array of subtasks.
   *
   * @param content - LLM response content
   * @returns Parsed subtasks
   */
  private extractPlan(content: string): SubTask[] {
    // Strategy 1: Extract from ```json ... ``` code block
    const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed as SubTask[];
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON code block', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 2: Find JSON array anywhere in content
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed as SubTask[];
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON array', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 3: Fallback - try to parse entire content
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as SubTask[];
      }
    } catch {
      // Silent fail, will throw below
    }

    throw new Error('Failed to extract execution plan from LLM response');
  }

  /**
   * Delegate a subtask to a specialist
   *
   * Loads specialist configuration, discovers tools, and executes via SpecialistExecutor.
   *
   * @param subtask - Subtask to execute
   * @returns Delegated result
   */
  private async delegateTask(subtask: SubTask): Promise<DelegatedResult> {
    const startTime = Date.now();

    try {
      // Load specialist configuration
      const config = await this.registry.load(subtask.specialistId);

      // Discover tools for specialist
      const tools = await this.toolDiscoverer.discover(config.tools);

      // Create specialist context
      const context: SpecialistContext = { config, tools };

      // Execute via SpecialistExecutor
      const result = await this.specialistExecutor.execute(context, subtask.description);

      return {
        subtaskId: subtask.id,
        specialistId: subtask.specialistId,
        success: result.success,
        output: result.output,
        error: result.error,
        tokensUsed: result.tokensUsed,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error('Subtask delegation failed', new Error(
        `[${subtask.specialistId}] Subtask ${subtask.id}: ${errorMessage}`
      ));

      return {
        subtaskId: subtask.id,
        specialistId: subtask.specialistId,
        success: false,
        output: null,
        error: errorMessage,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Synthesize specialist results into final answer
   *
   * Uses smart tier LLM to combine outputs from multiple specialists
   * into a coherent, comprehensive answer.
   *
   * @param task - Original task
   * @param plan - Execution plan
   * @param results - Results from specialists
   * @returns Synthesized answer
   */
  private async synthesizeResults(
    task: string,
    plan: SubTask[],
    results: DelegatedResult[]
  ): Promise<{ answer: string; tokensUsed: number }> {
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not available for result synthesis');
    }

    // Build synthesis prompt with all specialist outputs
    let resultsText = '';
    for (const result of results) {
      const subtask = plan.find((s) => s.id === result.subtaskId);
      if (!subtask) continue;

      resultsText += `## ${subtask.description}\n`;
      resultsText += `**Specialist**: ${result.specialistId}\n`;
      resultsText += `**Status**: ${result.success ? 'Success' : 'Failed'}\n`;

      if (result.success && result.output) {
        if (typeof result.output === 'string') {
          resultsText += `**Output**:\n${result.output}\n\n`;
        } else {
          resultsText += `**Output**:\n${JSON.stringify(result.output, null, 2)}\n\n`;
        }
      } else if (result.error) {
        resultsText += `**Error**: ${result.error}\n\n`;
      }
    }

    const systemPrompt = `You are an AI orchestrator synthesizing results from multiple specialists.

# Your Role:
1. Review all specialist outputs
2. Identify key findings and insights
3. Combine information into a coherent answer
4. Resolve any conflicts or inconsistencies
5. Provide a comprehensive response to the original task

# Output Format:
Provide a clear, well-structured answer that:
- Directly addresses the original task
- Incorporates insights from all specialists
- Is easy to understand and actionable
- Cites which specialist provided which information (when relevant)`;

    const userPrompt = `# Original Task:
${task}

# Specialist Results:
${resultsText}

Synthesize these results into a comprehensive answer to the original task.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for synthesis
      }
    );

    const answer = response.content || '(no answer generated)';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    return { answer, tokensUsed };
  }
}
