/**
 * Phase 3: Universal Task Runner - Planner
 *
 * Uses Opus to create 3-7 step execution plan from task description
 */

import { useLLM } from '@kb-labs/sdk';
import type { TaskInput, ExecutionPlan, PlanStep } from './types.js';

export interface PlannerConfig {
  /**
   * Min/max steps in plan
   */
  minSteps?: number;
  maxSteps?: number;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class Planner {
  private config: Required<PlannerConfig>;

  constructor(config: PlannerConfig = {}) {
    this.config = {
      minSteps: config.minSteps ?? 3,
      maxSteps: config.maxSteps ?? 7,
      verbose: config.verbose ?? false,
    };
  }

  /**
   * Create execution plan from task description
   */
  async createPlan(input: TaskInput): Promise<ExecutionPlan> {
    this.log(`📋 Creating execution plan for task: ${input.id}`);

    const llm = useLLM({ tier: 'large' }); // Opus for planning

    if (!llm || !llm.chatWithTools) {
      throw new Error('LLM not available or does not support chatWithTools');
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(input);

    const response = await llm.chatWithTools(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for planning
        temperature: 0.1,
      }
    );

    const plan = this.parsePlanFromResponse(response.content, input);

    this.log(`✅ Created plan with ${plan.steps.length} steps`);
    this.validatePlan(plan);

    return plan;
  }

  /**
   * Build system prompt for planning
   */
  private buildSystemPrompt(): string {
    return `You are an expert task planner. Your job is to break down tasks into clear, executable steps.

**Guidelines:**

1. **${this.config.minSteps}-${this.config.maxSteps} steps:** Create ${this.config.minSteps} to ${this.config.maxSteps} steps (prefer fewer high-level steps over many micro-steps)

2. **Each step should:**
   - Be concrete and actionable (not vague like "understand the code")
   - Have clear success criteria
   - List specific actions to take
   - Identify dependencies on previous steps

3. **Good planning principles:**
   - Front-load research (understand before implementing)
   - Group related actions together
   - Plan for verification (testing, validation)
   - Consider rollback if needed

4. **Output format:** JSON object with this structure:
\`\`\`json
{
  "summary": "One-sentence plan overview",
  "steps": [
    {
      "stepNumber": 1,
      "description": "What this step accomplishes",
      "actions": ["Specific action 1", "Specific action 2"],
      "successCriteria": ["How to know this step succeeded"],
      "dependsOn": [],
      "estimatedDuration": 60000
    }
  ],
  "successCriteria": ["Overall task success criteria"],
  "estimatedDuration": 300000,
  "estimatedCost": 0.50
}
\`\`\`

5. **Estimation:**
   - estimatedDuration: milliseconds (be realistic)
   - estimatedCost: USD (Sonnet ~$3/M input, ~$15/M output; Opus ~10x more)

**Remember:** You're planning for an AI agent with tools (file ops, search, LLM). The agent is smart but needs clear direction.`;
  }

  /**
   * Build user prompt with task details
   */
  private buildUserPrompt(input: TaskInput): string {
    const parts: string[] = [];

    parts.push(`**Task ID:** ${input.id}`);
    parts.push(`**Description:** ${input.description}`);

    if (input.source) {
      parts.push(`**Source:** ${input.source}`);
    }

    if (input.context?.files && input.context.files.length > 0) {
      parts.push(`**Relevant Files:** ${input.context.files.join(', ')}`);
    }

    if (input.context?.links && input.context.links.length > 0) {
      parts.push(`**Links:** ${input.context.links.join(', ')}`);
    }

    if (input.context?.relatedTasks && input.context.relatedTasks.length > 0) {
      parts.push(`**Related Tasks:** ${input.context.relatedTasks.join(', ')}`);
    }

    if (input.constraints) {
      parts.push(`**Constraints:**`);
      if (input.constraints.maxDuration) {
        parts.push(`  - Max duration: ${input.constraints.maxDuration}ms`);
      }
      if (input.constraints.budget) {
        parts.push(`  - Max budget: $${input.constraints.budget}`);
      }
      if (input.constraints.requiresApproval) {
        parts.push(`  - Requires approval: yes`);
      }
    }

    parts.push('');
    parts.push('Create an execution plan for this task. Output valid JSON only (no markdown, no explanation).');

    return parts.join('\n');
  }

  /**
   * Parse JSON plan from LLM response
   */
  private parsePlanFromResponse(response: string, input: TaskInput): ExecutionPlan {
    try {
      // Strip markdown code blocks if present
      const cleaned = response.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        taskId: input.id,
        createdAt: new Date().toISOString(),
        summary: parsed.summary,
        steps: parsed.steps.map((s: unknown) => this.normalizeStep(s)),
        estimatedDuration: parsed.estimatedDuration,
        estimatedCost: parsed.estimatedCost,
        successCriteria: parsed.successCriteria || [],
      };
    } catch (error) {
      throw new Error(
        `Failed to parse execution plan: ${error instanceof Error ? error.message : String(error)}\n\nResponse:\n${response}`
      );
    }
  }

  /**
   * Normalize and validate a plan step
   */
  private normalizeStep(raw: unknown): PlanStep {
    const step = raw as Record<string, unknown>;

    return {
      stepNumber: Number(step.stepNumber),
      description: String(step.description),
      actions: Array.isArray(step.actions) ? step.actions.map(String) : [],
      successCriteria: Array.isArray(step.successCriteria) ? step.successCriteria.map(String) : [],
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(Number) : undefined,
      estimatedDuration: step.estimatedDuration ? Number(step.estimatedDuration) : undefined,
    };
  }

  /**
   * Validate plan meets requirements
   */
  private validatePlan(plan: ExecutionPlan): void {
    if (plan.steps.length < this.config.minSteps) {
      throw new Error(`Plan has too few steps: ${plan.steps.length} < ${this.config.minSteps}`);
    }

    if (plan.steps.length > this.config.maxSteps) {
      throw new Error(`Plan has too many steps: ${plan.steps.length} > ${this.config.maxSteps}`);
    }

    // Check step numbers are sequential
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step) {
        throw new Error(`Step at index ${i} is undefined`);
      }
      const expected = i + 1;
      if (step.stepNumber !== expected) {
        throw new Error(`Step ${i} has wrong stepNumber: ${step.stepNumber} (expected ${expected})`);
      }
    }

    // Check dependencies reference valid steps
    for (const step of plan.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (dep >= step.stepNumber) {
            throw new Error(`Step ${step.stepNumber} cannot depend on step ${dep} (circular or forward dependency)`);
          }
        }
      }
    }
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }
}
