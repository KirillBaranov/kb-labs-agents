/**
 * Phase 3: Universal Task Runner - Executor
 *
 * Uses Sonnet (medium tier) to execute a single step from the plan
 */

import { Agent } from '@kb-labs/agent-core';
import type { AgentConfig } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import type { PlanStep, StepResult, TaskCheckpoint } from './types.js';

export interface ExecutorConfig {
  /**
   * Working directory for agent execution
   */
  workingDir: string;

  /**
   * Max iterations per step
   */
  maxIterations?: number;

  /**
   * Tool registry
   */
  toolRegistry: ToolRegistry;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class Executor {
  private config: ExecutorConfig;

  constructor(config: ExecutorConfig) {
    this.config = {
      ...config,
      maxIterations: config.maxIterations ?? 10,
    };
  }

  /**
   * Execute a single plan step
   */
  async executeStep(step: PlanStep, checkpoint: TaskCheckpoint): Promise<StepResult> {
    this.log(`\n🔨 Executing Step ${step.stepNumber}: ${step.description}`);

    const startTime = Date.now();

    try {
      // Build task description for agent
      const task = this.buildTaskDescription(step, checkpoint);

      // Create agent config
      const agentConfig: AgentConfig = {
        workingDir: this.config.workingDir,
        maxIterations: this.config.maxIterations!,
        temperature: 0.1, // Focused, deterministic execution
        tier: 'medium', // Sonnet for execution
        verbose: this.config.verbose ?? false,
        agentId: `step-${step.stepNumber}-executor`,
      };

      // Execute step with agent
      const agent = new Agent(agentConfig, this.config.toolRegistry);
      const result = await agent.execute(task);

      const durationMs = Date.now() - startTime;

      // Map agent result to step result
      const stepResult: StepResult = {
        stepNumber: step.stepNumber,
        status: this.determineStatus(result, step),
        output: result.summary, // Use summary from TaskResult
        filesAffected: this.extractFilesAffected(result),
        toolCalls: this.extractToolCalls(result),
        durationMs,
        costUsd: this.estimateCost(result),
        errors: this.extractErrors(result),
        warnings: this.extractWarnings(result),
      };

      this.log(`✅ Step ${step.stepNumber} completed in ${durationMs}ms (${stepResult.status})`);

      return stepResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      this.log(`❌ Step ${step.stepNumber} failed: ${error instanceof Error ? error.message : String(error)}`);

      return {
        stepNumber: step.stepNumber,
        status: 'failed',
        output: '',
        durationMs,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Build task description for agent from plan step
   */
  private buildTaskDescription(step: PlanStep, checkpoint: TaskCheckpoint): string {
    const parts: string[] = [];

    parts.push(`**Step ${step.stepNumber}: ${step.description}**\n`);

    parts.push('**Actions to take:**');
    for (const action of step.actions) {
      parts.push(`- ${action}`);
    }
    parts.push('');

    parts.push('**Success criteria:**');
    for (const criterion of step.successCriteria) {
      parts.push(`- ${criterion}`);
    }
    parts.push('');

    // Add context from previous steps
    if (checkpoint.completedSteps.length > 0) {
      parts.push('**Previous steps completed:**');
      for (const prev of checkpoint.completedSteps) {
        parts.push(`- Step ${prev.stepNumber}: ${prev.status}`);
        if (prev.output) {
          parts.push(`  Output: ${prev.output.slice(0, 200)}${prev.output.length > 200 ? '...' : ''}`);
        }
      }
      parts.push('');
    }

    // Add dependencies info
    if (step.dependsOn && step.dependsOn.length > 0) {
      parts.push('**This step depends on:**');
      for (const depNum of step.dependsOn) {
        const depStep = checkpoint.completedSteps.find((s) => s.stepNumber === depNum);
        if (depStep) {
          parts.push(`- Step ${depNum}: ${depStep.status}`);
        }
      }
      parts.push('');
    }

    parts.push('Execute this step and report what you accomplished.');

    return parts.join('\n');
  }

  /**
   * Determine step status from agent result
   */
  private determineStatus(result: unknown, step: PlanStep): 'success' | 'partial' | 'failed' {
    const r = result as { summary: string; trace?: Array<{ type: string }> };

    // Check for explicit failure indicators
    if (r.summary.toLowerCase().includes('failed') || r.summary.toLowerCase().includes('error')) {
      return 'failed';
    }

    // Check if all success criteria mentioned in summary
    const summaryLower = r.summary.toLowerCase();
    const criteriaMet = step.successCriteria.filter((criterion) => {
      const keywords = criterion.toLowerCase().split(/\s+/);
      return keywords.some((kw) => summaryLower.includes(kw));
    });

    if (criteriaMet.length === step.successCriteria.length) {
      return 'success';
    }

    if (criteriaMet.length > 0) {
      return 'partial';
    }

    return 'success'; // Default to success if no clear failure
  }

  /**
   * Extract files affected from agent result
   */
  private extractFilesAffected(result: unknown): string[] {
    const r = result as { trace?: Array<{ type: string; data?: { toolName?: string; input?: Record<string, unknown> } }> };

    if (!r.trace) {return [];}

    const files = new Set<string>();

    for (const entry of r.trace) {
      if (entry.type === 'tool_call' && entry.data?.toolName) {
        const toolName = entry.data.toolName;
        const input = entry.data.input;

        // Extract file paths from fs operations
        if (toolName.startsWith('fs:') && input && 'path' in input && typeof input.path === 'string') {
          files.add(input.path);
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Extract tool calls from agent result
   */
  private extractToolCalls(result: unknown): Array<{ name: string; input: Record<string, unknown>; result: unknown }> {
    const r = result as {
      trace?: Array<{ type: string; data?: { toolName?: string; input?: Record<string, unknown>; result?: unknown } }>;
    };

    if (!r.trace) {return [];}

    const calls: Array<{ name: string; input: Record<string, unknown>; result: unknown }> = [];

    for (const entry of r.trace) {
      if (entry.type === 'tool_call' && entry.data?.toolName && entry.data.input) {
        calls.push({
          name: entry.data.toolName,
          input: entry.data.input,
          result: entry.data.result,
        });
      }
    }

    return calls;
  }

  /**
   * Estimate cost from agent result
   */
  private estimateCost(result: unknown): number {
    const r = result as { trace?: Array<{ type: string; data?: { usage?: { total_tokens?: number } } }> };

    if (!r.trace) {return 0;}

    let totalTokens = 0;

    for (const entry of r.trace) {
      if (entry.type === 'llm_response' && entry.data?.usage?.total_tokens) {
        totalTokens += entry.data.usage.total_tokens;
      }
    }

    // Rough estimate: Sonnet ~$3/M input + ~$15/M output
    // Assume 2:1 output:input ratio
    const inputTokens = totalTokens / 3;
    const outputTokens = (totalTokens * 2) / 3;

    const costUsd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

    return Math.round(costUsd * 100) / 100; // Round to cents
  }

  /**
   * Extract errors from agent result
   */
  private extractErrors(result: unknown): string[] | undefined {
    const r = result as { summary: string };

    // Simple heuristic: look for error indicators in summary
    const errorIndicators = ['error:', 'failed:', 'exception:'];
    const summaryLower = r.summary.toLowerCase();

    const errors: string[] = [];

    for (const indicator of errorIndicators) {
      if (summaryLower.includes(indicator)) {
        // Extract error message (simple approach)
        const lines = r.summary.split('\n');
        for (const line of lines) {
          if (line.toLowerCase().includes(indicator)) {
            errors.push(line.trim());
          }
        }
      }
    }

    return errors.length > 0 ? errors : undefined;
  }

  /**
   * Extract warnings from agent result
   */
  private extractWarnings(result: unknown): string[] | undefined {
    const r = result as { summary: string };

    // Simple heuristic: look for warning indicators
    const warningIndicators = ['warning:', 'note:', 'caution:'];
    const summaryLower = r.summary.toLowerCase();

    const warnings: string[] = [];

    for (const indicator of warningIndicators) {
      if (summaryLower.includes(indicator)) {
        const lines = r.summary.split('\n');
        for (const line of lines) {
          if (line.toLowerCase().includes(indicator)) {
            warnings.push(line.trim());
          }
        }
      }
    }

    return warnings.length > 0 ? warnings : undefined;
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
