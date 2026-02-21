/**
 * Search Signal Tracker
 *
 * Tracks search signal quality across iterations, decides when to conclude
 * "not found" early, and provides evidence summaries. LLM interaction is
 * abstracted via an injected assessor callback.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchArtifact {
  tool: string;
  content: string;
}

export interface SearchSignalState {
  consecutiveNoSignalSearchIterations: number;
  searchSignalHits: number;
  recentSearchEvidence: string[];
  lastSignalIteration: number;
}

export interface SearchSignalContext {
  task: string;
  taskIntent: 'action' | 'discovery' | 'analysis' | null;
  behaviorPolicy: {
    noResult: {
      minIterationsBeforeConclusion: number;
      maxConsecutiveNoSignalSearchByTier: Record<string, number>;
    };
  };
  currentTier: string;
  filesRead: ReadonlySet<string>;
  filesModified: ReadonlySet<string>;
  filesCreated: ReadonlySet<string>;
}

/**
 * Injected at construction time — called to assess search signal via LLM.
 * The implementation lives in Agent.ts where `useLLM` and `chooseSmartTier` are available.
 */
export type SearchSignalAssessor = (
  artifacts: SearchArtifact[],
) => Promise<{ signal: 'none' | 'partial' | 'strong'; snippets: string[] }>;

// ---------------------------------------------------------------------------
// SearchSignalTracker
// ---------------------------------------------------------------------------

export class SearchSignalTracker {
  readonly state: SearchSignalState;
  private readonly assessor: SearchSignalAssessor;

  constructor(assessor: SearchSignalAssessor, initial?: Partial<SearchSignalState>) {
    this.assessor = assessor;
    this.state = {
      consecutiveNoSignalSearchIterations: initial?.consecutiveNoSignalSearchIterations ?? 0,
      searchSignalHits: initial?.searchSignalHits ?? 0,
      recentSearchEvidence: initial?.recentSearchEvidence ?? [],
      lastSignalIteration: initial?.lastSignalIteration ?? 0,
    };
  }

  // ── Core update ────────────────────────────────────────────────────────

  async updateNoResultTracker(
    toolCalls: ReadonlyArray<{ id: string; name: string }>,
    toolResults: ReadonlyArray<{ toolCallId?: string; content?: string | unknown }>,
    iteration: number,
  ): Promise<void> {
    if (toolCalls.length === 0) {
      this.state.consecutiveNoSignalSearchIterations = 0;
      return;
    }

    const searchCalls = toolCalls.filter(
      (call) =>
        call.name === 'grep_search'
        || call.name === 'glob_search'
        || call.name === 'find_definition',
    );
    if (searchCalls.length === 0) {
      this.state.consecutiveNoSignalSearchIterations = 0;
      return;
    }

    const searchArtifacts: SearchArtifact[] = searchCalls.map((call) => {
      const result = toolResults.find((r) => r.toolCallId === call.id);
      const content = typeof result?.content === 'string' ? result.content : '';
      return {
        tool: call.name,
        content: content.slice(0, 2000),
      };
    });

    const llmJudgement = await this.assessor(searchArtifacts);

    if (llmJudgement.snippets.length > 0) {
      for (const snippet of llmJudgement.snippets) {
        if (!this.state.recentSearchEvidence.includes(snippet)) {
          this.state.recentSearchEvidence.push(snippet);
        }
      }
      this.state.recentSearchEvidence = this.state.recentSearchEvidence.slice(-8);
    }

    const positiveSignalDetected = llmJudgement.signal !== 'none';
    if (positiveSignalDetected) {
      this.state.searchSignalHits += 1;
      this.state.lastSignalIteration = iteration;
    }

    if (llmJudgement.signal === 'none') {
      this.state.consecutiveNoSignalSearchIterations += 1;
    } else {
      this.state.consecutiveNoSignalSearchIterations = 0;
    }
  }

  // ── Decision ───────────────────────────────────────────────────────────

  shouldConcludeNoResultEarly(
    iteration: number,
    ctx: SearchSignalContext,
    isActionTask: boolean,
  ): boolean {
    if (isActionTask) {
      return false;
    }
    if (!isLikelyDiscoveryTask(ctx.task, ctx.taskIntent)) {
      return false;
    }

    if (iteration < ctx.behaviorPolicy.noResult.minIterationsBeforeConclusion) {
      return false;
    }

    const maxNoSignal =
      ctx.behaviorPolicy.noResult.maxConsecutiveNoSignalSearchByTier[ctx.currentTier] ?? 3;
    if (this.state.consecutiveNoSignalSearchIterations < maxNoSignal) {
      return false;
    }

    if (this.state.searchSignalHits > 0) {
      return false;
    }

    const evidenceCount =
      ctx.filesRead.size + ctx.filesModified.size + ctx.filesCreated.size;
    return evidenceCount <= 1;
  }

  // ── Summary ────────────────────────────────────────────────────────────

  buildNoResultConclusionSummary(
    toolsUsedCount: ReadonlyMap<string, number>,
  ): string {
    const searchTools = ['grep_search', 'glob_search', 'find_definition']
      .map((name) => ({ name, count: toolsUsedCount.get(name) ?? 0 }))
      .filter((item) => item.count > 0);

    const attempts =
      searchTools.length > 0
        ? searchTools.map((item) => `${item.name}×${item.count}`).join(', ')
        : 'search tools';

    if (this.state.recentSearchEvidence.length > 0) {
      const evidence = this.state.recentSearchEvidence
        .slice(0, 5)
        .map((item) => `- ${item}`)
        .join('\n');
      return `Partial signal found after repeated search attempts (${attempts}), but evidence was insufficient for a high-confidence final claim.\nObserved matches:\n${evidence}\n\nProvide a narrower symbol/path or expected module to continue with a focused verification pass.`;
    }

    return `Insufficient evidence found after repeated search attempts (${attempts}). I could not locate reliable matches for the requested target in the current workspace scope.`;
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  reset(): void {
    this.state.consecutiveNoSignalSearchIterations = 0;
    this.state.searchSignalHits = 0;
    this.state.recentSearchEvidence = [];
    this.state.lastSignalIteration = 0;
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function isLikelyDiscoveryTask(
  task: string,
  taskIntent: 'action' | 'discovery' | 'analysis' | null,
): boolean {
  if (taskIntent) {
    return taskIntent === 'discovery';
  }
  return /(find|search|locate|where|which|what exports|usage|symbol|definition|найди|поиск|где|какой|какие|экспорт|используется|определение)/i.test(
    task,
  );
}

export function extractSearchEvidenceSnippets(content: string): string[] {
  if (!content.trim()) {
    return [];
  }

  const snippets: string[] = [];
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (
      /[a-z0-9_\-./]+\.(ts|tsx|js|jsx|json|md|py|go|rs|yml|yaml)(:\d+)?/i.test(line)
    ) {
      snippets.push(line.length > 180 ? `${line.slice(0, 177)}...` : line);
    }
    if (snippets.length >= 6) {
      break;
    }
  }

  return snippets;
}

export function assessSearchSignalHeuristic(
  artifacts: SearchArtifact[],
): { signal: 'none' | 'partial' | 'strong'; snippets: string[] } {
  const snippets = artifacts
    .flatMap((a) => extractSearchEvidenceSnippets(a.content))
    .slice(0, 6);

  if (snippets.length > 0) {
    return { signal: 'partial', snippets };
  }

  const hasNegative = artifacts.every((a) => {
    const content = a.content.toLowerCase();
    return (
      content.includes('no result')
      || content.includes('no matches')
      || content.includes('not found')
      || content.includes('не найден')
      || content.includes('нет совпад')
    );
  });

  return {
    signal: hasNegative ? 'none' : 'partial',
    snippets: [],
  };
}
