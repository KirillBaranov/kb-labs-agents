/**
 * Plan mode handler - generate execution plan without running
 */

import type { TaskResult, AgentConfig, PlanContext } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import type { ModeHandler } from './mode-handler';
import { PlanGenerator } from '../planning/plan-generator';
import { SessionManager } from '../planning/session-manager';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Plan mode - generate execution plan only
 */
export class PlanModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    const planContext = config.mode?.context as PlanContext | undefined;
    const complexity = planContext?.complexity;

    // Generate session
    const sessionManager = new SessionManager(config.workingDir);
    const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Generate plan
    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task,
      sessionId,
      mode: 'plan',
      complexity,
    });

    // Save plan to session
    const planPath = sessionManager.getSessionPlanPath(sessionId);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    // Return result with plan
    return {
      success: true,
      summary: `Plan generated with ${plan.phases.length} phases and ${plan.phases.reduce((sum, p) => sum + p.steps.length, 0)} steps`,
      filesCreated: [planPath],
      filesModified: [],
      filesRead: [],
      iterations: 1,
      tokensUsed: 0, // Will be tracked by LLM wrapper
      sessionId,
      plan,
    };
  }
}
