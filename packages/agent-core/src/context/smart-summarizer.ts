/**
 * SmartSummarizer - Fact extraction from agent history
 *
 * Replaces action-log summarization with structured fact extraction.
 * Uses LLM to extract concrete facts from recent iterations.
 *
 * Features:
 * - LLM-based fact extraction every N iterations
 * - Heuristic (no-LLM) fact extraction after each tool call
 * - Callback-based integration with FactSheet
 * - FIFO queue processing
 */

import type { LLMMessage, ILLM } from '@kb-labs/sdk';
import type { FactCategory } from '@kb-labs/agent-contracts';
import { AGENT_SUMMARIZER } from '../constants.js';

/**
 * Extracted fact from LLM summarization
 */
export interface ExtractedFact {
  category: FactCategory;
  fact: string;
  confidence: number;
  source: string;
}

/**
 * Result of a fact extraction cycle
 */
export interface FactExtractionResult {
  iterationRange: [number, number];
  messagesCount: number;
  inputChars: number;
  inputTokens: number;
  facts: ExtractedFact[];
  outputTokens: number;
  llmDurationMs: number;
}

/**
 * Callback invoked when facts are extracted (LLM-based)
 */
export type OnFactsExtracted = (result: FactExtractionResult) => void;

export interface SummarizerConfig {
  /** Trigger summarization every N iterations */
  summarizationInterval?: number;
  /** LLM tier for summarization */
  llmTier?: 'small' | 'medium';
  /** Max tokens for summary */
  maxSummaryTokens?: number;
  /** Callback when LLM extracts facts */
  onFactsExtracted: OnFactsExtracted;
  /**
   * Optional trace callback. Receives raw LLM call data for
   * memory:summarization_llm_call events.
   */
  onTrace?: (event: {
    type: 'memory:summarization_llm_call';
    iteration: number;
    prompt: string;
    rawResponse: string;
    parseSuccess: boolean;
    parseError?: string;
    durationMs: number;
    outputTokens: number;
  }) => void;
}

interface SummarizationTask {
  startIteration: number;
  endIteration: number;
  snapshot: ReadonlyArray<Readonly<LLMMessage>>;
}

/**
 * SmartSummarizer - Fact extraction from agent history
 */
export class SmartSummarizer {
  private config: {
    summarizationInterval: number;
    llmTier: 'small' | 'medium';
    maxSummaryTokens: number;
    onFactsExtracted: OnFactsExtracted;
    onTrace?: SummarizerConfig['onTrace'];
  };
  private summaries = new Map<number, string>(); // iteration -> summary (kept for context building)
  private queue: SummarizationTask[] = [];
  private isProcessing = false;
  private llm?: ILLM;

  constructor(config: SummarizerConfig) {
    this.config = {
      summarizationInterval:
        config.summarizationInterval ?? AGENT_SUMMARIZER.summarizationInterval,
      llmTier: config.llmTier ?? 'small',
      maxSummaryTokens:
        config.maxSummaryTokens ?? AGENT_SUMMARIZER.maxSummaryTokens,
      onFactsExtracted: config.onFactsExtracted,
      onTrace: config.onTrace,
    };
  }

  /**
   * Set LLM instance (must be called before triggering summarization)
   */
  setLLM(llm: ILLM): void {
    this.llm = llm;
  }

  /**
   * Trigger summarization (async, non-blocking)
   */
  async triggerSummarization(
    historySnapshot: ReadonlyArray<Readonly<LLMMessage>>,
    currentIteration: number
  ): Promise<void> {
    if (currentIteration % this.config.summarizationInterval !== 0) {
      return;
    }

    const startIter = currentIteration - this.config.summarizationInterval;
    const endIter = currentIteration;

    const rangeSnapshot = historySnapshot.filter((msg) => {
      const iter = (msg as Record<string, unknown>).iteration as
        | number
        | undefined;
      return iter !== undefined && iter >= startIter && iter < endIter;
    });

    if (rangeSnapshot.length === 0) {
      return;
    }

    const task: SummarizationTask = {
      startIteration: startIter,
      endIteration: endIter,
      snapshot: Object.freeze([...rangeSnapshot]),
    };

    this.queue.push(task);

    this.processQueue().catch((err) => {
      console.error(`[SmartSummarizer] Queue processing failed: ${err}`);
    });
  }

  /**
   * Process summarization queue (FIFO)
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;

        if (this.summaries.has(task.startIteration)) {
          continue;
        }

        const result = await this.extractFacts(task);

        // Build summary text from extracted facts
        const summaryText = result.facts
          .map((f) => `[${f.category}] ${f.fact}`)
          .join('\n');
        this.summaries.set(
          task.startIteration,
          summaryText || '(No facts extracted)'
        );

        // Notify callback
        this.config.onFactsExtracted(result);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Extract facts from a history range using LLM
   */
  private async extractFacts(
    task: SummarizationTask
  ): Promise<FactExtractionResult> {
    if (!this.llm) {
      throw new Error(
        'LLM not set. Call setLLM() before triggering summarization.'
      );
    }

    const { startIteration, endIteration, snapshot } = task;

    // Build compressed context from tool calls and results
    const compressedContext = snapshot
      .map((msg) => {
        if (msg.role === 'tool') {
          const toolName =
            (msg as Record<string, unknown>).name || 'unknown';
          // fs_list shows directory structure — navigation noise, not knowledge
          if (toolName === 'fs_list') return null;
          const content = msg.content || '';
          const preview = content.slice(0, 2000);
          return `Tool: ${toolName}\nResult: ${preview}${content.length > 2000 ? '...' : ''}`;
        }
        if (msg.role === 'assistant') {
          const toolCalls = (msg as Record<string, unknown>).tool_calls as
            | Array<{ function?: { name?: string } }>
            | undefined;
          const lines: string[] = [];
          // Always include agent's reasoning text — this is where decisions and findings live
          if (msg.content && msg.content.trim()) {
            const preview = msg.content.slice(0, 600);
            lines.push(`Agent reasoning: ${preview}${msg.content.length > 600 ? '...' : ''}`);
          }
          if (toolCalls && toolCalls.length > 0) {
            lines.push(`Agent called: ${toolCalls.map((tc) => tc.function?.name).join(', ')}`);
          }
          return lines.length > 0 ? lines.join('\n') : null;
        }
        return null;
      })
      .filter((line): line is string => line !== null)
      .join('\n\n');

    const inputChars = compressedContext.length;
    const inputTokens = Math.ceil(inputChars / 4);

    // Fact extraction prompt
    const prompt = `Extract concrete FACTS from agent work during iterations ${startIteration} to ${endIteration}.

${compressedContext}

Output a JSON array of facts. Each fact must be:
- category: one of "file_content", "architecture", "finding", "decision", "blocker", "correction", "tool_result", "environment"
- fact: a concrete, specific fact (not vague action descriptions)
- confidence: 0.0-1.0 how certain you are
- source: "agent_reasoning" if extracted from Agent reasoning lines, or tool name otherwise

Categories:
- "finding": discovered facts about code structure, behavior, or design (most valuable)
- "architecture": how components connect, data flow, patterns
- "decision": what the agent decided to do and why (from Agent reasoning lines)
- "file_content": what a specific file contains or exports
- "tool_result": grep/search results worth remembering
- "blocker": problems or errors encountered
- "correction": something previously believed that turned out wrong

GOOD facts:
- "Agent decided to focus on agent.ts as the main orchestrator since it exports the Agent class" [decision, from reasoning]
- "src/index.ts exports 8 items: Agent, FileMemory, FactSheet, ArchiveMemory, SessionManager..." [file_content]
- "Agent class uses StateMachine for lifecycle and TaskLedger for step tracking" [architecture]
- "grep found 5 files importing FactSheet" [tool_result]

BAD facts: "Agent searched for files", "Tool was called", "File exists"

Pay special attention to "Agent reasoning:" lines — they contain decisions and findings worth preserving.

Output ONLY the JSON array, no markdown or explanations:`;

    const startTime = Date.now();
    const response = await this.llm.complete(prompt, {
      temperature: 0.1,
      maxTokens: this.config.maxSummaryTokens,
    });
    const llmDurationMs = Date.now() - startTime;
    const rawResponse = (response.content || '').trim();
    const outputTokens = response.usage?.completionTokens ?? Math.ceil(rawResponse.length / 4);

    // Parse extracted facts
    let facts: ExtractedFact[] = [];
    let parseSuccess = false;
    let parseError: string | undefined;
    try {
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          category?: string;
          fact?: string;
          confidence?: number;
          source?: string;
        }>;
        facts = parsed
          .filter((f) => f.category && f.fact)
          .map((f) => ({
            category: (f.category as FactCategory) || 'finding',
            fact: f.fact!,
            confidence: Math.min(1.0, Math.max(0.0, f.confidence ?? 0.5)),
            source: f.source || 'llm_extraction',
          }));
        parseSuccess = true;
      } else {
        parseError = 'No JSON array found in response';
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    // Emit raw LLM call trace for debugging
    this.config.onTrace?.({
      type: 'memory:summarization_llm_call',
      iteration: endIteration,
      prompt,
      rawResponse,
      parseSuccess,
      parseError,
      durationMs: llmDurationMs,
      outputTokens,
    });

    return {
      iterationRange: [startIteration, endIteration],
      messagesCount: snapshot.length,
      inputChars,
      inputTokens,
      facts,
      outputTokens,
      llmDurationMs,
    };
  }

  /**
   * Get summary for iteration range
   */
  getSummary(startIteration: number): string | null {
    return this.summaries.get(startIteration) || null;
  }

  /**
   * Check if summary exists for iteration
   */
  hasSummary(iteration: number): boolean {
    for (const key of this.summaries.keys()) {
      if (
        iteration >= key &&
        iteration < key + this.config.summarizationInterval
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all summaries in chronological order
   */
  getAllSummaries(): Array<{ startIteration: number; summary: string }> {
    const result: Array<{ startIteration: number; summary: string }> = [];
    for (const [startIter, summary] of this.summaries.entries()) {
      result.push({ startIteration: startIter, summary });
    }
    result.sort((a, b) => a.startIteration - b.startIteration);
    return result;
  }

  /**
   * Clear all summaries
   */
  clearSummaries(): void {
    this.summaries.clear();
    this.queue = [];
  }

  /**
   * Get summarization stats
   */
  getStats(): {
    totalSummaries: number;
    queueLength: number;
    isProcessing: boolean;
    summaryRanges: Array<{ start: number; end: number }>;
  } {
    const ranges = Array.from(this.summaries.keys()).map((start) => ({
      start,
      end: start + this.config.summarizationInterval,
    }));

    return {
      totalSummaries: this.summaries.size,
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      summaryRanges: ranges.sort((a, b) => a.start - b.start),
    };
  }
}

// ── Heuristic fact extraction (no LLM) ──────────────────────────────

/**
 * Extract facts heuristically from a tool result (no LLM needed).
 * Called after every tool execution for instant fact accumulation.
 */
export function extractHeuristicFacts(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  success: boolean
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  if (!success) {
    return facts; // Don't extract facts from failed tool calls
  }

  switch (toolName) {
    case 'fs_read': {
      const filePath = toolInput.path as string;
      const lines = (toolOutput.match(/\n/g) || []).length + 1;
      const firstLine = toolOutput.split('\n').find((l) => l.trim().length > 0) || '';
      const preview = firstLine.slice(0, 80);
      facts.push({
        category: 'file_content',
        fact: `Read ${filePath} (${lines} lines). Starts with: ${preview}`,
        confidence: 0.9,
        source: toolName,
      });
      break;
    }
    case 'grep_search': {
      const pattern = toolInput.pattern as string;
      const matchCount = (toolOutput.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `grep '${pattern}' found ~${matchCount} matches`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }
    case 'glob_search': {
      const globPattern = toolInput.pattern as string;
      const fileCount = (toolOutput.match(/\n/g) || []).length;
      facts.push({
        category: 'tool_result',
        fact: `glob '${globPattern}' found ~${fileCount} files`,
        confidence: 0.8,
        source: toolName,
      });
      break;
    }
    case 'find_definition': {
      const name = toolInput.name as string;
      const preview = toolOutput.slice(0, 120).replace(/\n/g, ' ');
      facts.push({
        category: 'finding',
        fact: `Definition of '${name}': ${preview}`,
        confidence: 0.85,
        source: toolName,
      });
      break;
    }
    case 'shell_exec': {
      const cmd = (toolInput.command as string || '').slice(0, 60);
      const status = success ? 'succeeded' : 'failed';
      const preview = toolOutput.slice(0, 100).replace(/\n/g, ' ');
      facts.push({
        category: 'tool_result',
        fact: `shell '${cmd}': ${status}. Output: ${preview}`,
        confidence: 0.7,
        source: toolName,
      });
      break;
    }
  }

  return facts;
}
