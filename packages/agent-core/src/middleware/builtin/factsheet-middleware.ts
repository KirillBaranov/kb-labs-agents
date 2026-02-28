/**
 * FactSheetMiddleware — structured working memory via SDK middleware hooks.
 *
 * Replaces 15 integration points in legacy Agent with 4 clean hooks:
 *
 *   afterToolExec   → heuristic fact extraction (instant, no LLM)
 *   afterIteration  → trigger LLM summarization every N iterations
 *   beforeLLMCall   → inject FactSheet into system message
 *   onStop          → persist to disk (non-critical)
 *
 * order = 20 (after Budget=10, ContextFilter=15; before Progress=50)
 *
 * Heuristic extraction runs after every tool call — zero latency, zero cost.
 * LLM extraction runs every N iterations — uses a separate small-tier LLM call
 * to extract structured facts from recent agent reasoning and tool results.
 */

import { useLLM, type ILLM, type LLMMessage } from '@kb-labs/sdk';
import type {
  AgentMiddleware,
  RunContext,
  LLMCtx,
  LLMCallPatch,
  ToolExecCtx,
  ToolOutput,
} from '@kb-labs/agent-sdk';
import type { FactCategory } from '@kb-labs/agent-contracts';
import { FactSheet, type FactSheetConfig } from '../../memory/fact-sheet.js';

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FactSheetMiddlewareConfig {
  /** FactSheet config (maxTokens, maxEntries, minConfidence) */
  factSheet?: FactSheetConfig;
  /** LLM summarization every N iterations. 0 = disabled. Default: 5 */
  summarizationInterval?: number;
  /** Max tokens for LLM summary response. Default: 800 */
  maxSummaryTokens?: number;
  /** Directory for cross-session persistence. undefined = no persistence */
  persistDir?: string;
}

const DEFAULT_INTERVAL = 5;
const DEFAULT_MAX_SUMMARY_TOKENS = 800;

// ─── Extracted fact type ─────────────────────────────────────────────────────

interface ExtractedFact {
  category: FactCategory;
  fact: string;
  confidence: number;
  source: string;
}

// ─── FactSheetMiddleware ─────────────────────────────────────────────────────

export class FactSheetMiddleware implements AgentMiddleware {
  readonly name = 'factsheet';
  readonly order = 20;
  readonly config = { failPolicy: 'fail-open' as const };

  private sheet: FactSheet;
  private readonly factSheetConfig: FactSheetConfig;
  private readonly interval: number;
  private readonly maxSummaryTokens: number;
  private readonly persistDir?: string;
  private llm: ILLM | null = null;
  private pendingSummarization: Promise<void> | null = null;

  constructor(cfg: FactSheetMiddlewareConfig = {}) {
    this.factSheetConfig = cfg.factSheet ?? {};
    this.sheet = new FactSheet(this.factSheetConfig);
    this.interval = cfg.summarizationInterval ?? DEFAULT_INTERVAL;
    this.maxSummaryTokens = cfg.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
    this.persistDir = cfg.persistDir;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onStart(ctx: RunContext): Promise<void> {
    // Load persisted facts from prior session
    if (this.persistDir) {
      this.sheet = await this.loadFromDisk(this.persistDir);
    }

    // Acquire small-tier LLM for summarization
    if (this.interval > 0) {
      this.llm = useLLM({ tier: 'small' }) ?? null;
    }

    // Expose sheet stats via meta for other middlewares / tracing
    ctx.meta.set('factsheet', 'enabled', true);
  }

  async onStop(ctx: RunContext, _reason: string): Promise<void> {
    // Wait for any in-flight summarization
    if (this.pendingSummarization) {
      try { await this.pendingSummarization; } catch { /* non-critical */ }
    }

    // Persist facts to disk
    if (this.persistDir) {
      await this.saveToDisk(this.persistDir);
    }

    // Final stats for tracing
    ctx.meta.set('factsheet', 'finalStats', this.sheet.getStats());
  }

  // ── beforeLLMCall: inject FactSheet into context ───────────────────────────

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    const rendered = this.sheet.render();
    if (!rendered) {return undefined;}

    // Find system message and append FactSheet
    const messages = [...ctx.messages];
    const sysIdx = messages.findIndex(m => m.role === 'system');

    if (sysIdx >= 0) {
      const sys = messages[sysIdx]!;
      messages[sysIdx] = {
        ...sys,
        content: sys.content + `\n\n# Working Memory (${this.sheet.size} facts)\n${rendered}`,
      };
    } else {
      // No system message — prepend one
      messages.unshift({
        role: 'system',
        content: `# Working Memory (${this.sheet.size} facts)\n${rendered}`,
      });
    }

    return { messages };
  }

  // ── afterToolExec: heuristic fact extraction ───────────────────────────────

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    if (!result.success) {return;}

    const facts = extractHeuristicFacts(ctx.toolName, ctx.input, result.output);
    for (const f of facts) {
      this.sheet.add({
        ...f,
        iteration: ctx.iteration,
      });
    }
  }

  // ── afterIteration: trigger LLM summarization ─────────────────────────────

  async afterIteration(ctx: RunContext): Promise<void> {
    if (this.interval <= 0 || !this.llm) {return;}
    if (ctx.iteration % this.interval !== 0) {return;}

    // Non-blocking: fire and track
    this.pendingSummarization = this.runSummarization(ctx).catch(() => { /* fail-open */ });
  }

  // ── LLM Summarization ─────────────────────────────────────────────────────

  private async runSummarization(ctx: RunContext): Promise<void> {
    if (!this.llm?.complete) {return;}

    // Build compressed context from recent messages
    const recentMessages = ctx.messages.slice(-this.interval * 4); // ~4 messages per iteration
    const compressed = compressMessages(recentMessages as LLMMessage[]);
    if (!compressed) {return;}

    const prompt = buildExtractionPrompt(compressed, ctx.iteration - this.interval, ctx.iteration);

    const response = await this.llm.complete(prompt, {
      temperature: 0.1,
      maxTokens: this.maxSummaryTokens,
    });

    const raw = (response.content || '').trim();
    const facts = parseExtractedFacts(raw);

    for (const f of facts) {
      this.sheet.add({
        ...f,
        iteration: ctx.iteration,
      });
    }

    ctx.meta.set('factsheet', 'lastSummarization', {
      iteration: ctx.iteration,
      factsExtracted: facts.length,
      stats: this.sheet.getStats(),
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async loadFromDisk(dir: string): Promise<FactSheet> {
    const filePath = path.join(dir, 'fact-sheet.json');
    try {
      if (!fs.existsSync(filePath)) {return this.sheet;}
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return FactSheet.fromJSON(data, this.factSheetConfig);
    } catch {
      return this.sheet;
    }
  }

  private async saveToDisk(dir: string): Promise<void> {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'fact-sheet.json'),
        JSON.stringify(this.sheet.toJSON()),
        'utf-8',
      );
    } catch { /* non-critical */ }
  }
}

// ─── Heuristic fact extraction (no LLM) ──────────────────────────────────────

function extractHeuristicFacts(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  switch (toolName) {
    case 'fs_read': {
      const filePath = input.path as string;
      const lines = (output.match(/\n/g) || []).length + 1;
      const firstLine = output.split('\n').find(l => l.trim().length > 0) || '';
      facts.push({
        category: 'file_content',
        fact: `Read ${filePath} (${lines} lines). Starts with: ${firstLine.slice(0, 80)}`,
        confidence: 0.9,
        source: toolName,
      });
      break;
    }

    case 'grep_search': {
      const pattern = input.pattern as string;
      const matchCount = (output.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `grep '${pattern}' found ~${matchCount} matches`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }

    case 'glob_search': {
      const globPattern = input.pattern as string;
      const fileCount = (output.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `glob '${globPattern}' found ~${fileCount} files`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }

    case 'find_definition': {
      const name = input.name as string;
      const preview = output.slice(0, 120).replace(/\n/g, ' ');
      facts.push({
        category: 'finding',
        fact: `Definition of '${name}': ${preview}`,
        confidence: 0.85,
        source: toolName,
      });
      break;
    }

    case 'shell_exec': {
      const cmd = (input.command as string || '').slice(0, 60);
      const preview = output.slice(0, 100).replace(/\n/g, ' ');
      facts.push({
        category: 'tool_result',
        fact: `shell '${cmd}': succeeded. Output: ${preview}`,
        confidence: 0.7,
        source: toolName,
      });
      break;
    }
  }

  return facts;
}

// ─── LLM summarization helpers ───────────────────────────────────────────────

function compressMessages(messages: LLMMessage[]): string | null {
  const lines = messages
    .map(msg => {
      if (msg.role === 'tool') {
        const content = msg.content || '';
        const preview = content.slice(0, 2000);
        return `Tool result: ${preview}${content.length > 2000 ? '...' : ''}`;
      }
      if (msg.role === 'assistant') {
        const parts: string[] = [];
        if (msg.content?.trim()) {
          parts.push(`Agent: ${msg.content.slice(0, 600)}${(msg.content.length > 600) ? '...' : ''}`);
        }
        if (msg.toolCalls?.length) {
          parts.push(`Calls: ${msg.toolCalls.map(tc => tc.name ?? (tc as any).function?.name).join(', ')}`);
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
      return null;
    })
    .filter((l): l is string => l !== null);

  return lines.length > 0 ? lines.join('\n\n') : null;
}

function buildExtractionPrompt(context: string, fromIter: number, toIter: number): string {
  return `Extract concrete FACTS from agent work during iterations ${fromIter} to ${toIter}.

${context}

Output a JSON array of facts. Each fact:
- category: "file_content" | "architecture" | "finding" | "decision" | "blocker" | "correction" | "tool_result" | "environment"
- fact: concrete, specific fact (not vague descriptions)
- confidence: 0.0-1.0
- source: "agent_reasoning" or tool name

GOOD: "src/index.ts exports Agent, FileMemory, FactSheet" [file_content]
GOOD: "Agent uses StateMachine for lifecycle" [architecture]
BAD: "Agent searched for files", "Tool was called"

Output ONLY the JSON array:`;
}

function parseExtractedFacts(raw: string): ExtractedFact[] {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {return [];}

    const parsed = JSON.parse(match[0]) as Array<{
      category?: string;
      fact?: string;
      confidence?: number;
      source?: string;
    }>;

    return parsed
      .filter(f => f.category && f.fact)
      .map(f => ({
        category: (f.category as FactCategory) || 'finding',
        fact: f.fact!,
        confidence: Math.min(1.0, Math.max(0.0, f.confidence ?? 0.5)),
        source: f.source || 'llm_extraction',
      }));
  } catch {
    return [];
  }
}
