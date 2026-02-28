/**
 * TaskClassifier
 *
 * LLM-based task classification: determines intent (action / discovery / analysis)
 * and initial iteration budget. Also extracts scope (subdirectory narrowing) via LLM.
 *
 * Stateless — each call is independent. LLM access is injected via callbacks.
 */

import * as fs from 'node:fs';
import type { ILLM, LLMTool, LLMToolCallResponse } from '@kb-labs/sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  intent: 'action' | 'discovery' | 'analysis';
  budget: number;
}

export interface TaskClassifierConfig {
  maxIterations: number;
  parentAgentId?: string;
  workingDir: string;
}

export type ClassifierLLMProvider = (tier: string) => ILLM | null;

// ---------------------------------------------------------------------------
// TaskClassifier
// ---------------------------------------------------------------------------

export class TaskClassifier {
  private readonly getLLM: ClassifierLLMProvider;
  private readonly log: (msg: string) => void;

  constructor(getLLM: ClassifierLLMProvider, log: (msg: string) => void) {
    this.getLLM = getLLM;
    this.log = log;
  }

  // ── Classification ──────────────────────────────────────────────────────

  async classifyTask(task: string, config: TaskClassifierConfig): Promise<ClassificationResult> {
    const configured = config.maxIterations || 25;
    const cap = Math.min(configured, 20);

    const llm = this.getLLM('small');

    if (llm?.chatWithTools) {
      try {
        const response = await llm.chatWithTools(
          [{ role: 'user', content: buildClassifyPrompt(task, cap) }],
          { temperature: 0, tools: [buildClassifyTaskTool(cap)] },
        );

        const result = parseClassificationResult(response, cap, configured);
        if (result) {
          this.log(`🧠 Task classified: intent=${result.intent} budget=${result.budget}`);
          return result;
        }
      } catch {
        // Fall through to defaults.
      }
    }

    this.log('⚠️ LLM classification failed, using default budget');
    return { intent: 'action', budget: Math.min(configured, 12) };
  }

  // ── Scope extraction ────────────────────────────────────────────────────

  async extractScope(task: string, config: TaskClassifierConfig): Promise<string | null> {
    if (config.parentAgentId) {
      return null;
    }

    const llm = this.getLLM('small');
    if (!llm?.chatWithTools) {
      return null;
    }

    let availableDirs: string[];
    try {
      const entries = fs.readdirSync(config.workingDir, { withFileTypes: true });
      availableDirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => e.name);
    } catch {
      return null;
    }

    if (availableDirs.length === 0) {
      return null;
    }

    const scopeTool = buildSelectScopeTool(availableDirs);
    const prompt = `Analyze this task and determine if it refers to a specific subdirectory/repository.

**Task:** ${task}

**Available directories:**
${availableDirs.map((d) => `- ${d}`).join('\n')}

If the task explicitly mentions or is clearly about ONE of these directories, select it.
If the task is general or mentions multiple directories, select "none".

Call select_scope with your choice.`;

    try {
      const response = await llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        { tools: [scopeTool], temperature: 0 },
      );

      const result = parseScopeResult(response, availableDirs);
      if (result) {
        this.log(`🎯 Extracted scope: ${result}`);
        return result;
      }
    } catch (error) {
      this.log(`⚠️ Scope extraction error: ${error}`);
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function buildClassifyPrompt(task: string, cap: number): string {
  return `You are a task planner. Analyze the user task and return:
1. intent — what kind of task it is
2. budget — how many agent iterations (tool calls) are needed to complete it

Intent options:
- "action": task requires making changes (implement, fix, add, refactor, delete, write)
- "discovery": task requires finding/locating something (where is X, what is Y, show me Z)
- "analysis": task requires understanding/explaining/analyzing

Budget guidelines (these are starting values; more may be granted if progress is made):
- discovery (simple lookup): 6–8
- analysis (explain/summarize): 8–12
- action (small change, 1-2 files): 10–14
- action (medium feature/fix, 3-10 files): 14–18
- action (large refactor/architecture, many files): 18–${cap}

User task:
${task}`;
}

export function buildClassifyTaskTool(_cap: number): LLMTool {
  return {
    name: 'classify_task',
    description: 'Classify the task and set initial iteration budget.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['action', 'discovery', 'analysis'],
          description: 'Task intent category',
        },
        budget: {
          type: 'number',
          description: 'Initial iteration budget (number of steps)',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence explaining the classification',
        },
      },
      required: ['intent', 'budget'],
    },
  };
}

export function buildSelectScopeTool(dirs: string[]): LLMTool {
  return {
    name: 'select_scope',
    description: 'Select the specific subdirectory/repository that this task is about, or indicate no specific scope',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: [...dirs, 'none'],
          description: 'The directory name if task is about a specific one, or "none" if task is general',
        },
      },
      required: ['scope'],
    },
  };
}

export function parseClassificationResult(
  response: Pick<LLMToolCallResponse, 'toolCalls'>,
  cap: number,
  _configured: number,
): ClassificationResult | null {
  const call = response.toolCalls?.find((tc) => tc.name === 'classify_task');
  const input = (call?.input ?? {}) as { intent?: string; budget?: number; reasoning?: string };
  const intent =
    input.intent === 'action' || input.intent === 'discovery' || input.intent === 'analysis'
      ? input.intent
      : null;
  const budget =
    typeof input.budget === 'number' && input.budget > 0
      ? Math.min(Math.max(input.budget, 4), cap)
      : null;

  if (intent && budget) {
    return { intent, budget };
  }
  return null;
}

export function parseScopeResult(
  response: Pick<LLMToolCallResponse, 'toolCalls'>,
  availableDirs: string[],
): string | null {
  const toolCall = response.toolCalls?.[0];
  if (toolCall && toolCall.name === 'select_scope') {
    const input = toolCall.input as { scope: string };
    const scope = input.scope;
    if (scope && scope !== 'none' && availableDirs.includes(scope)) {
      return scope;
    }
  }
  return null;
}
