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
  ToolDefinition,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import type { ModeHandler } from './mode-handler';
import { SessionManager } from '../planning/session-manager';
import { PlanDocumentService } from '../planning/plan-document-service';
import { PlanValidator } from '../planning/plan-validator';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const PLAN_READ_ONLY_TOOLS = new Set<string>([
  'fs_read',
  'fs_list',
  'glob_search',
  'grep_search',
  'find_definition',
  'code_stats',
  'memory_get',
  'memory_finding',
  'memory_blocker',
  'archive_recall',
  'todo_create',
  'todo_update',
  'todo_get',
  'ask_user',
  'spawn_agent',
  'report',
]);

class ReadOnlyPlanToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly allowedNames: Set<string>,
  ) {}

  get(name: string) {
    if (!this.allowedNames.has(name)) return undefined;
    return this.base.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return this.base
      .getDefinitions()
      .filter((def) => this.allowedNames.has(def.function.name));
  }

  async execute(name: string, input: Record<string, unknown>) {
    if (!this.allowedNames.has(name)) {
      throw new Error(`Tool "${name}" is disabled in plan mode (read-only).`);
    }
    return this.base.execute(name, input);
  }

  getToolNames(): string[] {
    return this.base
      .getToolNames()
      .filter((tool) => this.allowedNames.has(tool));
  }

  getContext() {
    return this.base.getContext();
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
    const effectiveMaxIterations = Math.max(6, Math.min(config.maxIterations || 10, 12));
    const planTaskPrompt = this.buildPlanPrompt(task, existingPlan?.markdown, effectiveMaxIterations);

    this.emit(config, {
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        status: 'planning',
        message: 'Plan mode enabled: read-only exploration + markdown plan drafting',
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
      },
    });

    try {
      const readOnlyRegistry = new ReadOnlyPlanToolRegistry(toolRegistry, PLAN_READ_ONLY_TOOLS) as unknown as ToolRegistry;
      const { Agent } = await import('../agent');
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
          if (content && /^#\s+/m.test(content)) {
            reportedPlanText = content;
          }
        }
        config.onEvent?.(event);
      };
      const planAgent = new Agent(
        {
          ...config,
          sessionId,
          mode: undefined,
          maxIterations: effectiveMaxIterations,
          enableEscalation: false,
          onEvent: childOnEvent,
          forcedSynthesisPrompt: `Budget exhausted. Write a plan NOW using what you found.
REQUIRED sections: # Plan title, ## Task (current state A → target state B), ## Steps (with REAL file paths from your research), ## Risks, ## Verification (runnable commands like pnpm test), ## Approval.
Reference ACTUAL files you discovered during research. A partial plan is better than no plan.
Call the report tool with the full markdown plan as the main content.`,
        },
        readOnlyRegistry,
      );

      const planningResult = await planAgent.execute(planTaskPrompt);
      const { markdown, incomplete } = this.extractMarkdownPlan(
        reportedPlanText || planningResult.summary,
        task,
        existingPlan?.markdown,
      );

      // Validate plan quality with deterministic rubric
      const validator = new PlanValidator();
      const validation = validator.validate(markdown);

      const planFailed = incomplete || !validation.passed;
      const plan = this.buildTaskPlan({
        sessionId,
        task,
        complexity,
        markdown,
        existingPlan,
      });

      // Override status when plan is incomplete or fails quality gate
      if (planFailed) {
        plan.status = 'failed';
      }

      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'plan',
          progress: 78,
          message: planFailed
            ? `Plan quality insufficient (score: ${validation.score.toFixed(2)})`
            : 'Plan draft ready, persisting artifacts',
        },
      });

      const planPath = sessionManager.getSessionPlanPath(sessionId);
      await fs.mkdir(path.dirname(planPath), { recursive: true });
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

      const planDocumentService = new PlanDocumentService(config.workingDir);
      const draft = await planDocumentService.createDraft(plan);
      const phaseCount = plan.phases.length;
      const stepCount = plan.phases.reduce((sum, phase) => sum + phase.steps.length, 0);

      if (planFailed) {
        const issuesSummary = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ');

        this.emit(config, {
          type: 'status:change',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            status: 'error',
            message: `Plan generation incomplete — quality score ${validation.score.toFixed(2)}`,
          },
        });
        this.emit(config, {
          type: 'progress:update',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            phase: 'plan',
            progress: 100,
            message: 'Plan mode complete (failed quality gate)',
          },
        });

        return {
          success: false,
          summary: `Plan generation incomplete — agent could not produce a concrete plan (score: ${validation.score.toFixed(2)}). ${issuesSummary}`,
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
        },
      });

      return {
        success: true,
        summary: `Plan draft ready (${phaseCount} phases, ${stepCount} steps, quality: ${validation.score.toFixed(2)}). Awaiting approval.`,
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

  private buildPlanPrompt(task: string, existingMarkdown?: string, maxIterations?: number): string {
    const budget = maxIterations || 10;
    const researchBudget = Math.ceil(budget * 0.6);
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
A partial plan with real file paths is ALWAYS better than no plan. Do NOT spend all iterations on research.

Output requirements:
- Final output must be a single markdown document.
- Include: title, Table of Contents, Task (A -> B), Steps/Phases, Risks, Verification, Approval.
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

When finished, use report tool with the markdown document as the main content.`;
  }

  private extractMarkdownPlan(summary: string, task: string, existingMarkdown?: string): { markdown: string; incomplete: boolean } {
    const text = (summary || '').trim();
    if (!text) {
      return { markdown: this.buildIncompleteMarkdown(task, existingMarkdown), incomplete: true };
    }

    // Check the raw text first — plan may contain internal code fences (```typescript, etc.)
    // that would confuse a greedy fenced-block extraction.
    if (/^#\s+/m.test(text) && /^##\s+/m.test(text)) {
      return { markdown: text, incomplete: false };
    }

    // If raw text doesn't look like a plan, try extracting from a wrapping markdown fence
    const fenced = /^```(?:markdown|md)\n([\s\S]*?)```\s*$/i.exec(text);
    const candidate = fenced?.[1]?.trim() || text;
    if (/^#\s+/m.test(candidate) && /^##\s+/m.test(candidate)) {
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
          if (bullet?.[1]) return bullet[1].trim();
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

  private emit(config: AgentConfig, event: AgentEvent): void {
    if (!config.onEvent) return;
    config.onEvent({
      ...event,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
    });
  }
}
