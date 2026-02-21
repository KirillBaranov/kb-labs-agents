/**
 * TaskCompletionEvaluator
 *
 * Validates whether a task was successfully completed. Uses heuristics for
 * informational tasks and LLM-based validation for action tasks. Also
 * retrieves historical file changes for retry detection.
 *
 * All LLM access and file reading is injected via callbacks — the module
 * has zero dependency on Agent or tool-registry internals.
 */

import type { ILLM, LLMToolCallResponse } from '@kb-labs/sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionEvaluationContext {
  task: string;
  agentResponse?: string;
  iterationsUsed: number;
  taskIntent: 'action' | 'discovery' | 'analysis' | null;
  filesRead: ReadonlySet<string>;
  filesModified: ReadonlySet<string>;
  filesCreated: ReadonlySet<string>;
  toolsUsedCount: ReadonlyMap<string, number>;
  searchSignalHits: number;
  recentSearchEvidence: readonly string[];
  behaviorPolicy: {
    evidence: {
      minInformationalResponseChars: number;
      minFilesReadForInformational: number;
      minEvidenceDensityForInformational: number;
    };
  };
}

export interface HistoricalChanges {
  filesCreated: string[];
  filesModified: string[];
  matchingRunCount: number;
}

export interface CompletionResult {
  success: boolean;
  summary: string;
}

export type CompletionLLMProvider = () => ILLM | null;
export type FileReader = (path: string) => Promise<string | null>;
export type HistoricalChangesLoader = (task: string) => Promise<HistoricalChanges>;

// ---------------------------------------------------------------------------
// TaskCompletionEvaluator
// ---------------------------------------------------------------------------

export class TaskCompletionEvaluator {
  private readonly getLLM: CompletionLLMProvider;
  private readonly readFile: FileReader;
  private readonly loadHistoricalChanges: HistoricalChangesLoader;
  private readonly log: (msg: string) => void;

  constructor(
    getLLM: CompletionLLMProvider,
    readFile: FileReader,
    loadHistoricalChanges: HistoricalChangesLoader,
    log: (msg: string) => void,
  ) {
    this.getLLM = getLLM;
    this.readFile = readFile;
    this.loadHistoricalChanges = loadHistoricalChanges;
    this.log = log;
  }

  async evaluate(ctx: CompletionEvaluationContext): Promise<CompletionResult> {
    const historicalChanges = await this.loadHistoricalChanges(ctx.task);

    const effectiveModified = new Set<string>([
      ...Array.from(ctx.filesModified),
      ...historicalChanges.filesModified,
    ]);
    const effectiveCreated = new Set<string>([
      ...Array.from(ctx.filesCreated),
      ...historicalChanges.filesCreated,
    ]);
    const hasHistoricalFileChanges =
      historicalChanges.filesCreated.length > 0 || historicalChanges.filesModified.length > 0;
    const ranVerificationCommands = (ctx.toolsUsedCount.get('shell_exec') ?? 0) > 0;

    // Read content of modified/created files for validation
    let fileContents = '';
    if (effectiveModified.size > 0 || effectiveCreated.size > 0) {
      const filesToCheck = [
        ...Array.from(effectiveModified),
        ...Array.from(effectiveCreated),
      ].slice(0, 3);

      for (const file of filesToCheck) {
        try {
          const content = await this.readFile(file);
          if (content) {
            const truncated = content.length > 1000 ? content.slice(0, 1000) + '\n[...truncated]' : content;
            fileContents += `\n--- ${file} ---\n${truncated}\n`;
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    const infoTask = isInformationalTask(ctx.taskIntent, ctx.task);
    const hasFileChanges = effectiveCreated.size > 0 || effectiveModified.size > 0;
    const evidenceCount = ctx.filesRead.size + ctx.filesModified.size + ctx.filesCreated.size;
    const evidenceDensity = ctx.iterationsUsed > 0 ? evidenceCount / ctx.iterationsUsed : evidenceCount;
    const hasEvidence = responseHasEvidence(ctx.agentResponse || '');
    const noResultConclusion = looksLikeNoResultConclusion(ctx.agentResponse || '');
    const searchAttempts =
      (ctx.toolsUsedCount.get('grep_search') ?? 0) +
      (ctx.toolsUsedCount.get('glob_search') ?? 0) +
      (ctx.toolsUsedCount.get('find_definition') ?? 0);

    // Fast path: informational task with sufficient evidence
    if (
      infoTask &&
      ctx.agentResponse &&
      ctx.agentResponse.trim().length >= ctx.behaviorPolicy.evidence.minInformationalResponseChars &&
      hasEvidence &&
      (ctx.filesRead.size >= ctx.behaviorPolicy.evidence.minFilesReadForInformational ||
        evidenceDensity >= ctx.behaviorPolicy.evidence.minEvidenceDensityForInformational ||
        ctx.searchSignalHits > 0 ||
        ctx.recentSearchEvidence.length > 0)
    ) {
      return { success: true, summary: ctx.agentResponse };
    }

    // Fast path: no-result conclusion with sufficient search effort
    if (infoTask && ctx.agentResponse && noResultConclusion && searchAttempts >= 2) {
      return { success: true, summary: ctx.agentResponse };
    }

    // LLM validation
    const llm = this.getLLM();
    const prompt = buildValidationPrompt(ctx, effectiveModified, effectiveCreated, historicalChanges, fileContents);

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      if (llm.chatWithTools) {
        const response = await llm.chatWithTools(
          [{ role: 'user', content: prompt }],
          {
            temperature: 0,
            tools: [buildValidationTool()],
          },
        );

        const result = parseValidationResult(response);
        if (result) {
          // Historical retry override
          if (
            !result.success &&
            hasHistoricalFileChanges &&
            ctx.filesCreated.size === 0 &&
            ctx.filesModified.size === 0 &&
            ranVerificationCommands
          ) {
            return {
              success: true,
              summary: `Verified retry succeeded using artifacts from prior run(s): ${result.summary}`,
            };
          }
          return result;
        }
      } else {
        const response = await llm.complete(`${prompt}\n\nReturn concise verdict and summary.`, {
          temperature: 0,
        });
        const content = response.content || '';
        if (content.trim().length > 0) {
          return {
            success: hasFileChanges || hasEvidence || noResultConclusion,
            summary: content.trim().slice(0, 1200),
          };
        }
      }
    } catch (error) {
      this.log(`⚠️  Validation error: ${error}`);
    }

    // Fallback heuristic
    return heuristicValidation(ctx, effectiveModified, effectiveCreated, infoTask);
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function isInformationalTask(
  taskIntent: 'action' | 'discovery' | 'analysis' | null,
  task: string,
): boolean {
  if (taskIntent) {
    return taskIntent !== 'action';
  }
  // Fallback regex: question words + research verbs
  return /^(what|how|why|where|when|who|explain|tell me|describe|show|find|list|analyze|scan|inspect|review|identify|check|проанализ|найди|покажи|объясн|расскаж)/i.test(task.trim());
}

export function looksLikeNoResultConclusion(text: string): boolean {
  return /(not found|не найден|no matches|no results|не удалось найти|не содержит)/i.test(text);
}

export function responseHasEvidence(text: string): boolean {
  return /\.(ts|js|tsx|jsx|md|json|py|go|rs|yaml|yml)|\/[a-z]|```|:\d+/.test(text);
}

export function buildValidationPrompt(
  ctx: CompletionEvaluationContext,
  effectiveModified: ReadonlySet<string>,
  effectiveCreated: ReadonlySet<string>,
  historicalChanges: HistoricalChanges,
  fileContents: string,
): string {
  const ranVerificationCommands = (ctx.toolsUsedCount.get('shell_exec') ?? 0) > 0;

  return `You are validating if an agent task was successfully completed.

**Original Task:** ${ctx.task}

**Files Created (current run):** ${Array.from(ctx.filesCreated).join(', ') || 'None'}
**Files Modified (current run):** ${Array.from(ctx.filesModified).join(', ') || 'None'}
**Files Created (including prior matching runs):** ${Array.from(effectiveCreated).join(', ') || 'None'}
**Files Modified (including prior matching runs):** ${Array.from(effectiveModified).join(', ') || 'None'}
**Historical matching runs with file changes:** ${historicalChanges.matchingRunCount}
**Verification commands in current run:** ${ranVerificationCommands ? 'Yes' : 'No'}
**Files Read:** ${Array.from(ctx.filesRead).join(', ') || 'None'}

**Modified/Created Files Content:**${fileContents || '\n(No files to show)'}

${ctx.agentResponse ? `**Agent Response:**\n${ctx.agentResponse}\n` : ''}

**Validation Rules:**

1. **For informational/question tasks** (starting with "What", "How", "Why", "Explain", "Tell me", etc.):
   - SUCCESS only if response includes concrete evidence from current run.
   - Require at least one concrete reference (file path/symbol/line/code detail) grounded in tool outputs.
   - If response is generic or not evidence-backed, mark as FAILED.

2. **For action tasks** (create, edit, delete, run, etc.):
   - SUCCESS if appropriate files were created/modified/read.
   - IMPORTANT for retries: if current run mostly verifies/tests but prior matching runs already changed files, this can still be SUCCESS when verification evidence exists.
   - Example: "Create file.txt" → file.txt created = SUCCESS

IMPORTANT: Do NOT mark question tasks as success only because text exists. Evidence-grounded answer is required.

**CRITICAL for summary field:**
- For research/informational tasks: Include ACTUAL FINDINGS - specific file paths, package names, code details discovered
- For action tasks: Describe what was done specifically
- NEVER write meta-descriptions like "The agent successfully provided..." - include the actual discovered content
- If Agent Response exists, extract and include the key information from it`;
}

export function buildValidationTool(): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: 'set_validation_result',
    description: 'Set final validation result and summary.',
    inputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['success', 'summary'],
    },
  };
}

export function parseValidationResult(
  response: Pick<LLMToolCallResponse, 'toolCalls'>,
): CompletionResult | null {
  const call = response.toolCalls?.find((tc) => tc.name === 'set_validation_result');
  const input = (call?.input ?? {}) as { success?: boolean; summary?: string };
  if (typeof input.success === 'boolean' && typeof input.summary === 'string' && input.summary.trim()) {
    return { success: input.success, summary: input.summary };
  }
  return null;
}

export function heuristicValidation(
  ctx: CompletionEvaluationContext,
  effectiveModified: ReadonlySet<string>,
  effectiveCreated: ReadonlySet<string>,
  infoTask: boolean,
): CompletionResult {
  const hasFileChanges = effectiveCreated.size > 0 || effectiveModified.size > 0;
  const hasEvidence = responseHasEvidence(ctx.agentResponse || '');
  const noResultConclusion = looksLikeNoResultConclusion(ctx.agentResponse || '');

  return {
    success:
      hasFileChanges ||
      (infoTask &&
        (hasEvidence ||
          noResultConclusion ||
          ctx.searchSignalHits > 0 ||
          ctx.recentSearchEvidence.length > 0)),
    summary: hasFileChanges
      ? `Modified ${effectiveModified.size} file(s), created ${effectiveCreated.size} file(s)`
      : ctx.agentResponse?.slice(0, 200) || 'Task did not produce concrete results',
  };
}

// ---------------------------------------------------------------------------
// getHistoricalChangesForSimilarTask — standalone function
// ---------------------------------------------------------------------------

export interface HistoricalChangesConfig {
  sessionId: string | undefined;
  sessionRootDir: string | undefined;
  agentId: string;
}

export async function getHistoricalChangesForSimilarTask(
  task: string,
  config: HistoricalChangesConfig,
  SessionManagerClass: new (rootDir: string) => {
    getSessionEvents(
      sessionId: string,
      opts: { types: string[] },
    ): Promise<Array<{
      type: string;
      parentAgentId?: string;
      agentId?: string;
      data?: Record<string, unknown>;
    }>>;
  },
): Promise<HistoricalChanges> {
  if (!config.sessionId || !config.sessionRootDir) {
    return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
  }

  try {
    const sessionManager = new SessionManagerClass(config.sessionRootDir);
    const events = await sessionManager.getSessionEvents(config.sessionId, {
      types: ['agent:start', 'agent:end'],
    });
    if (events.length === 0) {
      return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
    }

    const normalizeTask = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const currentTaskNorm = normalizeTask(task);
    const taskByAgentId = new Map<string, string>();

    for (const event of events) {
      if (event.type !== 'agent:start' || event.parentAgentId || !event.agentId) {
        continue;
      }
      const candidate = typeof event.data?.task === 'string' ? event.data.task : '';
      if (candidate.trim()) {
        taskByAgentId.set(event.agentId, candidate);
      }
    }

    const filesCreated = new Set<string>();
    const filesModified = new Set<string>();
    let matchingRunCount = 0;

    for (const event of events) {
      if (event.type !== 'agent:end' || event.parentAgentId || !event.agentId) {
        continue;
      }
      if (event.agentId === config.agentId) {
        continue;
      }
      const priorTask = taskByAgentId.get(event.agentId);
      if (!priorTask || normalizeTask(priorTask) !== currentTaskNorm) {
        continue;
      }

      const created = Array.isArray(event.data?.filesCreated) ? event.data.filesCreated : [];
      const modified = Array.isArray(event.data?.filesModified) ? event.data.filesModified : [];
      if (created.length === 0 && modified.length === 0) {
        continue;
      }

      matchingRunCount += 1;
      for (const file of created) {
        if (typeof file === 'string' && file.trim()) {
          filesCreated.add(file);
        }
      }
      for (const file of modified) {
        if (typeof file === 'string' && file.trim()) {
          filesModified.add(file);
        }
      }
    }

    return {
      filesCreated: Array.from(filesCreated),
      filesModified: Array.from(filesModified),
      matchingRunCount,
    };
  } catch {
    return { filesCreated: [], filesModified: [], matchingRunCount: 0 };
  }
}
