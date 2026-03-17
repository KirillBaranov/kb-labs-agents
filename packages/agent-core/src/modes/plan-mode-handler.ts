/**
 * Plan mode handler - lightweight "Claude Code style" planning flow.
 *
 * Core behavior:
 * - Reuse regular Agent loop (research + tool use).
 * - Restrict tool access to read-only/discovery/reporting tools.
 * - Ask agent to output a markdown plan (free-form, human-oriented).
 * - Persist plan as session plan.json + canonical markdown document.
 */

import type {
  AgentConfig,
  AgentEvent,
  TaskPlan,
  TaskResult,
  PlanContext,
  Phase,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import { createToolRegistry, PLAN_READ_ONLY_TOOL_NAMES } from '@kb-labs/agent-tools';
import type { ModeHandler } from './mode-handler';
import { AgentSDK, type IAgentRunner } from '@kb-labs/agent-sdk';
import { createCoreToolPack } from '../tools/index.js';
import { SessionManager } from '../planning/session-manager';
import { PlanDocumentService } from '../planning/plan-document-service';
import { TaskMiddleware } from '../middleware/builtin/task-middleware';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

class SharedTokenBudget {
  private consumed = 0;

  constructor(private readonly total: number) {}

  get remaining(): number {
    return Math.max(0, this.total - this.consumed);
  }

  get used(): number {
    return Math.max(0, this.consumed);
  }

  allocate(requested: number, minimum = 3000): number {
    const requestedSafe = Number.isFinite(requested) ? Math.max(minimum, Math.floor(requested)) : minimum;
    if (this.remaining <= 0) {return 0;}
    return Math.min(this.remaining, requestedSafe);
  }

  consume(tokensUsed: number): void {
    if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) {return;}
    this.consumed += Math.floor(tokensUsed);
  }
}


export class PlanModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const sessionManager = new SessionManager(config.workingDir);
    const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const planContext = config.mode?.context as PlanContext | undefined;
    const complexity = planContext?.complexity || 'medium';
    const existingPlanPath = sessionManager.getSessionPlanPath(sessionId);
    const existingPlan = config.sessionId ? await this.loadPlan(existingPlanPath) : null;
    const complexityDefault = complexity === 'simple' ? 15 : complexity === 'complex' ? 40 : 25;
    // Plan mode caps iterations — token budget is the real control, not iterations
    const effectiveMaxIterations = Math.min(config.maxIterations, Math.max(10, complexityDefault));
    const totalPlanBudget = Math.max(
      10_000,
      Math.floor(config.tokenBudget?.maxTokens ?? 1_000_000),
    );
    const sharedBudget = new SharedTokenBudget(totalPlanBudget);
    const planTaskPrompt = this.buildPlanPrompt(
      task,
      existingPlan?.markdown,
      effectiveMaxIterations,
      sharedBudget.remaining,
      totalPlanBudget,
    );
    const budgetSnapshot = () => this.buildBudgetSnapshot(sharedBudget, totalPlanBudget);

    this.emit(config, {
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        status: 'planning',
        message: 'Plan mode enabled: read-only exploration + markdown plan drafting',
        ...budgetSnapshot(),
      },
    });
    this.emit(config, {
      type: 'progress:update',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        phase: 'plan',
        progress: 10,
        message: existingPlan ? 'Revising existing plan draft' : 'Generating new plan draft',
        ...budgetSnapshot(),
      },
    });

    try {
      // Build the plan-writer's toolRegistry with:
      // - allowedTools: read-only set + task_submit/task_status/task_collect for async delegation
      // - taskManager: TaskMiddleware that spawns read-only research sub-agents
      //   Sub-agents get allowedTools=PLAN_READ_ONLY_TOOL_NAMES but no taskManager
      //   → task tools won't register for them → no recursion.
      const planTaskMw = new TaskMiddleware({ maxConcurrent: 5 });
      planTaskMw.setSpawnFn(async (request) => {
        const researchRegistry = createToolRegistry({
          ...toolRegistry.getContext(),
          allowedTools: PLAN_READ_ONLY_TOOL_NAMES,
          // no taskManager → task tools not registered → no recursion
        });
        const researchRunner = this.createSubRunner(
          {
            ...config,
            mode: undefined,
            maxIterations: request.maxIterations ?? Math.min(15, Math.max(5, Math.floor(effectiveMaxIterations * 0.25))),
            workingDir: request.workingDir ?? config.workingDir,
            tokenBudget: {
              ...config.tokenBudget,
              enabled: true,
              maxTokens: sharedBudget.allocate(Math.floor(sharedBudget.remaining * 0.30), 4000),
              softLimitRatio: 0.75,
              hardLimitRatio: 0.95,
              hardStop: true,
              forceSynthesisOnHardLimit: true,
              allowIterationBudgetExtension: false,
            },
            onEvent: config.onEvent,
          },
          researchRegistry as unknown as ToolRegistry,
        );
        const startedAt = Date.now();
        const result = await researchRunner.execute(request.task);
        sharedBudget.consume(result.tokensUsed);
        return {
          success: result.success,
          summary: result.summary,
          filesRead: result.filesRead,
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          iterations: result.iterations,
          tokensUsed: result.tokensUsed,
          durationMs: Date.now() - startedAt,
          error: result.error,
          preset: request.preset ?? 'research' as const,
        };
      });

      const planWriterRegistry = createToolRegistry({
        ...toolRegistry.getContext(),
        allowedTools: PLAN_READ_ONLY_TOOL_NAMES,
        taskManager: planTaskMw,
      });

      const budgetAwarePrompt = `${planTaskPrompt}\nCURRENT TOKEN BUDGET: ${sharedBudget.remaining}/${totalPlanBudget} tokens remaining. Be concise, avoid redundant exploration, and prioritize executable plan output.`;
      let reportedPlanText = '';
      const childOnEvent: AgentConfig['onEvent'] = (event) => {
        if (event.type === 'tool:end' && event.data?.toolName === 'report') {
          const metadataAnswer = (event.data?.metadata as { answer?: unknown } | undefined)?.answer;
          const output = typeof event.data?.output === 'string' ? event.data.output : '';
          const answer = typeof metadataAnswer === 'string' ? metadataAnswer : '';
          const captured = answer.trim() || output.trim();
          if (captured) {
            reportedPlanText = captured;
          }
        }
        if (event.type === 'llm:end') {
          const content = typeof event.data?.content === 'string' ? event.data.content.trim() : '';
          if (content && /^#{1,3}\s+/m.test(content) && content.length > 200) {
            reportedPlanText = content;
          }
        }
        config.onEvent?.(event);
      };
      const planRunner = this.createSubRunner(
        {
          ...config,
          sessionId,
          mode: undefined,
          maxIterations: effectiveMaxIterations,
          tokenBudget: {
            ...config.tokenBudget,
            enabled: true,
            maxTokens: sharedBudget.allocate(Math.max(8_000, Math.floor(sharedBudget.remaining * 0.9)), 8000),
            softLimitRatio: config.tokenBudget?.softLimitRatio ?? 0.40,
            hardLimitRatio: config.tokenBudget?.hardLimitRatio ?? 0.95,
            hardStop: config.tokenBudget?.hardStop ?? true,
            forceSynthesisOnHardLimit: config.tokenBudget?.forceSynthesisOnHardLimit ?? true,
            restrictBroadExplorationAtSoftLimit:
              config.tokenBudget?.restrictBroadExplorationAtSoftLimit ?? true,
            allowIterationBudgetExtension: false,
          },
          onEvent: childOnEvent,
        },
        planWriterRegistry as unknown as ToolRegistry,
      );

      const planningResult = await planRunner.execute(budgetAwarePrompt);
      sharedBudget.consume(planningResult.tokensUsed);
      const { markdown, incomplete } = this.extractMarkdownPlan(
        reportedPlanText || planningResult.summary,
        task,
        existingPlan?.markdown,
      );

      const plan = this.buildTaskPlan({
        sessionId,
        task,
        complexity,
        markdown,
        existingPlan,
      });

      if (incomplete) {
        plan.status = 'failed';
      }

      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'plan',
          progress: 78,
          message: incomplete ? 'Plan generation incomplete' : 'Plan draft ready, persisting artifacts',
          ...budgetSnapshot(),
        },
      });

      const planPath = sessionManager.getSessionPlanPath(sessionId);
      await fs.mkdir(path.dirname(planPath), { recursive: true });
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

      const planDocumentService = new PlanDocumentService(config.workingDir);
      const draft = await planDocumentService.createDraft(plan);
      const phaseCount = plan.phases.length;
      const stepCount = plan.phases.reduce((sum, phase) => sum + phase.steps.length, 0);

      if (incomplete) {
        this.emit(config, {
          type: 'status:change',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            status: 'error',
            message: 'Plan generation incomplete — agent did not produce a structured plan',
            ...budgetSnapshot(),
          },
        });
        this.emit(config, {
          type: 'progress:update',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            phase: 'plan',
            progress: 100,
            message: 'Plan mode complete (incomplete)',
            ...budgetSnapshot(),
          },
        });

        return {
          success: false,
          summary: 'Plan generation incomplete — agent could not produce a concrete plan within the budget.',
          filesCreated: [planPath, draft.path],
          filesModified: [],
          filesRead: planningResult.filesRead,
          iterations: planningResult.iterations,
          tokensUsed: planningResult.tokensUsed,
          sessionId,
          plan,
        };
      }

      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: 'waiting',
          message: 'Plan ready. Waiting for user approval before execution.',
          ...budgetSnapshot(),
        },
      });
      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'plan',
          progress: 100,
          message: 'Plan mode complete',
          ...budgetSnapshot(),
        },
      });

      return {
        success: true,
        summary: `Plan draft ready (${phaseCount} phases, ${stepCount} steps). Awaiting approval.`,
        filesCreated: [planPath, draft.path],
        filesModified: [],
        filesRead: planningResult.filesRead,
        iterations: planningResult.iterations,
        tokensUsed: planningResult.tokensUsed,
        sessionId,
        plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: 'error',
          message,
        },
      });
      this.emit(config, {
        type: 'agent:end',
        timestamp: new Date().toISOString(),
        sessionId,
        startedAt,
        data: {
          success: false,
          summary: 'Plan mode failed',
          iterations: 1,
          tokensUsed: 0,
          durationMs: Date.now() - startMs,
          filesCreated: [],
          filesModified: [],
          stopReason: 'error',
        },
      });
      throw error;
    }
  }

  private async loadPlan(planPath: string): Promise<TaskPlan | null> {
    try {
      const raw = await fs.readFile(planPath, 'utf-8');
      return JSON.parse(raw) as TaskPlan;
    } catch {
      return null;
    }
  }

  private buildPlanPrompt(
    task: string,
    existingMarkdown?: string,
    maxIterations?: number,
    remainingTokens?: number,
    totalTokens?: number,
  ): string {
    const budget = maxIterations || 10;
    const researchBudget = Math.ceil(budget * 0.6);
    const remainingText = typeof remainingTokens === 'number' ? remainingTokens.toLocaleString('en-US') : 'unknown';
    const totalText = typeof totalTokens === 'number' ? totalTokens.toLocaleString('en-US') : 'unknown';
    const revisionSection = existingMarkdown
      ? `\nExisting draft markdown (revise it based on the new request):\n\n${existingMarkdown}\n`
      : '';
    return `PLAN MODE ACTIVE.

Goal:
- Explore the repository with available read-only tools.
- Produce an executable implementation/refactor plan for the user request.
- DO NOT modify source files or run write/edit operations.

User request:
${task}
${revisionSection}

BUDGET: You have ~${budget} iterations total. Use ~${researchBudget} for research, then WRITE the plan.
TOKEN BUDGET: ${remainingText}/${totalText} tokens remaining. Spend tokens carefully and avoid duplicate scans.

RESEARCH QUALITY GATE — before writing the plan, verify:
1. You found the actual entry point files for the feature (not just files that happen to mention keywords).
2. If your first search returned 0 results or irrelevant files — search again with different terms or explore the directory structure.
3. Do NOT reference a file in the plan unless you have read it and confirmed it is relevant.
4. If you are unsure where something lives — use fs_list on the top-level directories first to orient yourself.

DELEGATION WITH task_submit (ASYNC SUB-AGENTS):
You have access to async task tools for parallel sub-agent delegation:
- \`task_submit\` — fire off a sub-agent in the background, get a task ID immediately
- \`task_status\` — check progress of running tasks (without blocking)
- \`task_collect\` — wait for a specific task to complete and get its full result

WHEN TO DELEGATE — use task_submit if ANY of these are true:
- A directory has 3+ files that each need to be read fully (e.g. a whole package or module)
- You need to find all callers/usages across multiple packages
- The task involves a large file (500+ lines) AND other files also need reading
- You can split research into 2-3 independent questions that don't depend on each other
- The task mentions "ALL repositories" or "all packages" — delegate each repo/group to a sub-agent

HOW TO USE EFFECTIVELY:
1. Submit 2-5 parallel tasks: \`task_submit({ description: "Analyze kb-labs-core deps", task: "Read all package.json files in kb-labs-core/packages/, list dependencies...", preset: "research" })\`
2. Continue your own work while sub-agents run in parallel
3. Collect results: \`task_collect({ taskId: "abc123" })\` — blocks until that task completes
4. Synthesize all results into the final plan

TIPS:
- Give each sub-agent ONE focused question with clear deliverables
- Sub-agents run concurrently — submit multiple before collecting any
- Sub-agents return findings as text — YOU synthesize and write the plan
- budgetPercent defaults to 20% per task — adjust if needed

WHEN NOT TO DELEGATE:
- You only need to read 1-2 small files (<200 lines each)
- Your token budget is almost exhausted

Output requirements:
- Final output must be a single markdown document.
- Include: title, Table of Contents, Task (A -> B), Steps/Phases, Risks, Verification, Approval.
- The ## Verification section MUST list concrete shell commands wrapped in backticks, e.g.:
  - \`pnpm --filter @kb-labs/agent-core build\`
  - \`pnpm --filter @kb-labs/agent-core test\`
  - \`pnpm --filter @kb-labs/agent-cli run build\`
- If revising existing plan, update the same plan and preserve useful parts.
- End with a short line that the plan is ready for user approval.

LANGUAGE: Write the plan body text in the SAME language as the user request above. Section headings (## Task, ## Steps, etc.) can stay in English, but all descriptions, explanations, and prose MUST match the user's language.

WRITING STYLE — the plan is for a HUMAN reader, not a machine:
- Write like you're explaining the plan to a colleague. A real person will read this top to bottom to verify you understood the task and didn't miss anything.
- For each phase/step, briefly explain WHY — not just "Edit file X at line Y" but what the change achieves and why it's needed.
- Show that you understood the current code: "Currently \`log()\` only calls console.log when verbose=true, but useLogger is already imported and unused — we'll wire it up".
- Use short prose paragraphs between steps to connect the narrative — the reader should feel the logical flow, not read a raw checklist.
- Keep code snippets short (3-5 lines max). The plan is a map, not the implementation itself. Reference line numbers instead of pasting large blocks.
- DO NOT pad with filler text. Every sentence should either explain context, justify a decision, or describe a concrete action.

QUALITY CRITERIA (your plan will be scored on these):
1. SPECIFICITY — reference ACTUAL file paths you discovered (e.g. \`src/planning/plan-generator.ts:1319\`)
2. ACTIONABILITY — every step must contain a file path OR a shell command, not just descriptions
3. VERIFICATION — include runnable commands (e.g. \`pnpm --filter @kb-labs/agent-core test\`)

Examples of GOOD vs BAD steps:
  BAD:  "Update the configuration file"
  GOOD: "Edit packages/agent-core/src/planning/plan-generator.ts:1319 — add specificity scoring to assessPlanQuality"

  BAD:  "Run tests"
  GOOD: "pnpm --filter @kb-labs/agent-core test — verify validator passes"

  BAD:  "Ensure the module exports are correct"
  GOOD: "Add \`export { PlanValidator }\` to packages/agent-core/src/planning/index.ts"

PLAN VALIDATION — MANDATORY BEFORE report():
After writing the plan markdown, you MUST validate it before submitting:

1. Call \`plan_validate(task="<original user task>", plan_markdown="<your plan>")\`
   - The tool will score your plan and return pass/fail with concrete feedback.
   - If PASSED: call \`report(answer=<plan>)\` immediately.
   - If FAILED: read the feedback, improve the specific sections it criticizes, then call \`plan_validate\` again.
   - After 3 consecutive FAILED validations: call \`ask_user(message=<plan + feedback summary>)\` to escalate.

2. NEVER call \`report()\` without a passing \`plan_validate\` first (unless you've exhausted all 3 attempts).

CRITICAL — TOOL USE REQUIRED:
You MUST call the \`report\` tool as your final action. Do NOT write the plan as plain text without a tool call.
- A plain-text response without calling \`report()\` is NOT a valid completion — it will fail the quality gate.
- Call \`report(answer=<your full markdown plan>, confidence=0.7)\` when done.
- Even if you think you are done, you MUST call \`report\` to submit the plan.`;
  }

  private extractMarkdownPlan(summary: string, task: string, existingMarkdown?: string): { markdown: string; incomplete: boolean } {
    const text = (summary || '').trim();
    if (!text) {
      return { markdown: this.buildIncompleteMarkdown(task, existingMarkdown), incomplete: true };
    }

    // Check the raw text first — plan may contain internal code fences (```typescript, etc.)
    // that would confuse a greedy fenced-block extraction.
    // Accept plans starting with # or ## headings (agents sometimes skip the top-level #)
    const hasStructure = (t: string) => /^#{1,3}\s+/m.test(t) && t.split('\n').filter(l => /^#{1,3}\s+/.test(l)).length >= 2;
    if (hasStructure(text)) {
      return { markdown: text, incomplete: false };
    }

    // If raw text doesn't look like a plan, try extracting from a wrapping markdown fence
    const fenced = /^```(?:markdown|md)\n([\s\S]*?)```\s*$/i.exec(text);
    const candidate = fenced?.[1]?.trim() || text;
    if (hasStructure(candidate)) {
      return { markdown: candidate, incomplete: false };
    }

    return { markdown: this.buildIncompleteMarkdown(task, candidate), incomplete: true };
  }

  private buildTaskPlan(input: {
    sessionId: string;
    task: string;
    complexity: 'simple' | 'medium' | 'complex';
    markdown: string;
    existingPlan: TaskPlan | null;
  }): TaskPlan {
    const now = new Date().toISOString();
    const planId = input.existingPlan?.id || `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const phases = this.parsePhasesFromMarkdown(input.markdown, planId);
    return {
      id: planId,
      sessionId: input.sessionId,
      task: input.task,
      mode: 'plan',
      phases,
      estimatedDuration: input.existingPlan?.estimatedDuration || 'Unknown',
      complexity: input.complexity,
      createdAt: input.existingPlan?.createdAt || now,
      updatedAt: now,
      status: 'draft',
      markdown: input.markdown,
    };
  }

  private parsePhasesFromMarkdown(markdown: string, planId?: string): Phase[] {
    const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
    const headingIndexes: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^###\s+/.test(lines[i] || '') || /^##\s+Phase\b/i.test(lines[i] || '')) {
        headingIndexes.push(i);
      }
    }

    const extractBullets = (chunk: string[]): string[] =>
      chunk
        .map((line) => {
          const bullet = /^\s*[-*]\s+(.+)\s*$/.exec(line);
          if (bullet?.[1]) {return bullet[1].trim();}
          const numbered = /^\s*\d+\.\s+(.+)\s*$/.exec(line);
          return numbered?.[1]?.trim() || '';
        })
        .filter(Boolean);

    const anchorPrefix = planId ? `${planId}:` : '';

    if (headingIndexes.length === 0) {
      const bullets = extractBullets(lines);
      return [{
        id: 'phase-1',
        name: 'Plan Execution',
        description: 'Execute the drafted plan.',
        dependencies: [],
        status: 'pending',
        anchor: `${anchorPrefix}phase-1`,
        steps: (bullets.length > 0 ? bullets : ['Execute approved plan changes']).slice(0, 20).map((item, idx) => ({
          id: `step-1-${idx + 1}`,
          action: item,
          expectedOutcome: `Completed: ${item}`,
          status: 'pending',
          anchor: `${anchorPrefix}phase-1:step-${idx + 1}`,
        })),
      }];
    }

    return headingIndexes.map((start, idx) => {
      const end = headingIndexes[idx + 1] ?? lines.length;
      const title = (lines[start] || '').replace(/^#{2,3}\s+/, '').trim() || `Phase ${idx + 1}`;
      const body = lines.slice(start + 1, end);
      const bullets = extractBullets(body);
      const description = body.find((line) => line.trim().length > 0 && !/^\s*(?:[-*]|\d+\.)\s+/.test(line))?.trim()
        || `Execute ${title}`;
      const phaseNum = idx + 1;
      return {
        id: `phase-${phaseNum}`,
        name: title,
        description,
        dependencies: idx === 0 ? [] : [`phase-${idx}`],
        status: 'pending',
        anchor: `${anchorPrefix}phase-${phaseNum}`,
        steps: (bullets.length > 0 ? bullets : [`Execute ${title}`]).slice(0, 20).map((item, stepIdx) => ({
          id: `step-${phaseNum}-${stepIdx + 1}`,
          action: item,
          expectedOutcome: `Completed: ${item}`,
          status: 'pending',
          anchor: `${anchorPrefix}phase-${phaseNum}:step-${stepIdx + 1}`,
        })),
      };
    });
  }

  private buildIncompleteMarkdown(task: string, capturedText?: string): string {
    const details = (capturedText || '').trim();
    const researchNotes = details
      ? details.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10)
      : [];

    return [
      `# Plan: ${task}`,
      '',
      '> **WARNING:** This is an incomplete plan. The agent could not generate a proper plan within the iteration budget.',
      '',
      '## Status: INCOMPLETE',
      '',
      '## Task',
      `- User request: ${task}`,
      '- The agent was unable to produce a concrete, actionable plan.',
      '',
      ...(researchNotes.length > 0
        ? [
            '## Research Notes (raw)',
            'The following notes were captured during exploration but do not constitute a plan:',
            '',
            ...researchNotes.map((line) => `- ${line}`),
            '',
          ]
        : []),
      '## Next Steps',
      '- Re-run plan mode with a more focused task description',
      '- Provide additional context or constraints to guide the agent',
      '- Consider breaking the task into smaller sub-tasks',
    ].join('\n');
  }


  private createSubRunner(config: AgentConfig, toolRegistry: ToolRegistry): IAgentRunner {
    return new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
  }

  private buildBudgetSnapshot(sharedBudget: SharedTokenBudget, totalBudget: number): {
    budgetUsedTokens: number;
    budgetRemainingTokens: number;
    budgetTotalTokens: number;
  } {
    return {
      budgetUsedTokens: sharedBudget.used,
      budgetRemainingTokens: sharedBudget.remaining,
      budgetTotalTokens: totalBudget,
    };
  }

  private emit(config: AgentConfig, event: AgentEvent): void {
    if (!config.onEvent) {return;}
    config.onEvent({
      ...event,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
    });
  }
}
