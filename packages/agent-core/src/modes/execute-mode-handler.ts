/**
 * Execute mode handler - standard task execution.
 *
 * When a session has an approved plan, the plan is injected into the task
 * prompt so the execution agent can reference it (but is not forced to
 * follow it rigidly).
 */

import type { TaskResult, AgentConfig, TaskPlan } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import type { ModeHandler } from './mode-handler';
import { AgentSDK } from '@kb-labs/agent-sdk';
import { createCoreToolPack } from '../tools/index.js';
import { SessionManager } from '../planning/session-manager';
import { promises as fs } from 'node:fs';

/**
 * Execute mode - standard agent execution
 */
export class ExecuteModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    // If session has an approved plan, load and inject as context
    const enrichedTask = await this.enrichTaskWithPlan(task, config);
    const runner = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
    return runner.execute(enrichedTask);
  }

  /**
   * Load approved plan from session (if any) and prepend to task prompt.
   */
  private async enrichTaskWithPlan(task: string, config: AgentConfig): Promise<string> {
    if (!config.sessionId || !config.workingDir) {return task;}

    try {
      const sessionManager = new SessionManager(config.workingDir);
      const planPath = sessionManager.getSessionPlanPath(config.sessionId);
      const raw = await fs.readFile(planPath, 'utf-8');
      const plan: TaskPlan = JSON.parse(raw);

      if (plan.status !== 'approved' && plan.status !== 'draft') {return task;}
      if (!plan.phases || plan.phases.length === 0) {return task;}

      const planContext = this.formatPlanContext(plan);
      return `${task}\n\n${planContext}`;
    } catch {
      // No plan file or parse error — proceed without plan
      return task;
    }
  }

  /**
   * Format plan phases/steps as a lightweight reference block.
   */
  private formatPlanContext(plan: TaskPlan): string {
    const lines: string[] = [
      'APPROVED PLAN (reference — follow as closely as reasonable):',
    ];

    for (const phase of plan.phases) {
      const anchor = phase.anchor ? `[${phase.anchor}]` : '';
      lines.push(`### ${anchor} ${phase.name}`);
      for (const step of phase.steps) {
        const stepAnchor = step.anchor ? `[${step.anchor}]` : '';
        lines.push(`  - ${stepAnchor} ${step.action}`);
      }
    }

    return lines.join('\n');
  }
}
