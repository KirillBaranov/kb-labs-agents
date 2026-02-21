/**
 * Smart tier selection logic.
 *
 * Decides which LLM tier (small/medium/large) to use for
 * internal agent nodes (intent inference, search assessment, task validation)
 * and whether to escalate to a larger tier mid-run.
 */

import type { LLMTier, AgentSmartTieringConfig } from '@kb-labs/agent-contracts';

export const DEFAULT_SMART_TIERING_CONFIG: Required<AgentSmartTieringConfig> = {
  enabled: true,
  nodes: {
    intentInference: false,
    searchAssessment: true,
    taskValidation: true,
  },
  auditTasksPreferMedium: true,
  minEvidenceDensityForSmallValidation: 0.9,
  maxIterationsWithoutProgressForMediumSearch: 2,
  intentInferenceMinTaskCharsForMedium: 180,
};

export interface TierSelectorContext {
  smartTiering?: AgentSmartTieringConfig;
  currentIterationBudget: number;
  maxIterations: number;
  progressIterationsSinceProgress: number;
  currentTask?: string;
}

export class TierSelector {
  /**
   * Resolve full tiering config (fill defaults).
   */
  resolveConfig(raw?: AgentSmartTieringConfig): Required<AgentSmartTieringConfig> {
    const r = raw ?? {};
    return {
      enabled: r.enabled ?? DEFAULT_SMART_TIERING_CONFIG.enabled,
      nodes: {
        intentInference: r.nodes?.intentInference ?? DEFAULT_SMART_TIERING_CONFIG.nodes.intentInference,
        searchAssessment: r.nodes?.searchAssessment ?? DEFAULT_SMART_TIERING_CONFIG.nodes.searchAssessment,
        taskValidation: r.nodes?.taskValidation ?? DEFAULT_SMART_TIERING_CONFIG.nodes.taskValidation,
      },
      auditTasksPreferMedium: r.auditTasksPreferMedium ?? DEFAULT_SMART_TIERING_CONFIG.auditTasksPreferMedium,
      minEvidenceDensityForSmallValidation:
        r.minEvidenceDensityForSmallValidation ?? DEFAULT_SMART_TIERING_CONFIG.minEvidenceDensityForSmallValidation,
      maxIterationsWithoutProgressForMediumSearch:
        r.maxIterationsWithoutProgressForMediumSearch
          ?? DEFAULT_SMART_TIERING_CONFIG.maxIterationsWithoutProgressForMediumSearch,
      intentInferenceMinTaskCharsForMedium:
        r.intentInferenceMinTaskCharsForMedium ?? DEFAULT_SMART_TIERING_CONFIG.intentInferenceMinTaskCharsForMedium,
    };
  }

  /**
   * Choose tier for an internal agent node.
   */
  chooseSmartTier(
    node: 'intentInference' | 'searchAssessment' | 'taskValidation',
    ctx: TierSelectorContext,
    nodeContext?: {
      task?: string;
      hasDiscoveryCue?: boolean;
      hasActionCue?: boolean;
      artifactCount?: number;
      evidenceDensity?: number;
      iterationsUsed?: number;
      isInformationalTask?: boolean;
    }
  ): LLMTier {
    const config = this.resolveConfig(ctx.smartTiering);
    if (!config.enabled || !config.nodes[node]) {
      return 'small';
    }

    const task = nodeContext?.task ?? ctx.currentTask ?? '';
    if (config.auditTasksPreferMedium && isAuditOrAnalysisTask(task)) {
      return 'medium';
    }

    if (node === 'intentInference') {
      const taskLength = task.trim().length;
      const mixedIntent = Boolean(nodeContext?.hasDiscoveryCue && nodeContext?.hasActionCue);
      if (mixedIntent && taskLength >= config.intentInferenceMinTaskCharsForMedium) {
        return 'medium';
      }
      return 'small';
    }

    if (node === 'searchAssessment') {
      if (ctx.progressIterationsSinceProgress >= config.maxIterationsWithoutProgressForMediumSearch) {
        return 'medium';
      }
      if ((nodeContext?.artifactCount ?? 0) >= 3) {
        return 'medium';
      }
      return 'small';
    }

    // taskValidation
    const evidenceDensity = nodeContext?.evidenceDensity ?? 0;
    const iterationsUsed = nodeContext?.iterationsUsed ?? 0;
    const isInformationalTask = nodeContext?.isInformationalTask ?? false;
    if (isInformationalTask && evidenceDensity < config.minEvidenceDensityForSmallValidation) {
      return 'medium';
    }
    if (iterationsUsed >= Math.max(6, Math.floor((ctx.currentIterationBudget || ctx.maxIterations || 8) * 0.7))) {
      return 'medium';
    }
    return 'small';
  }

  /**
   * Evaluate whether the agent should escalate to a higher tier mid-run.
   */
  evaluateEscalationNeed(input: {
    tier: LLMTier;
    iteration: number;
    maxIterations: number;
    enableEscalation: boolean;
    hasOnAskParent: boolean;
    progressIterationsSinceProgress: number;
    progressStuckThreshold: number;
    lastSignalIteration: number;
    lastProgressIteration: number;
    lastToolCalls: readonly string[];
    filesRead: ReadonlySet<string>;
    filesModified: ReadonlySet<string>;
    filesCreated: ReadonlySet<string>;
  }): { shouldEscalate: boolean; reason: string } {
    if (!input.enableEscalation || input.hasOnAskParent || input.tier === 'large') {
      return { shouldEscalate: false, reason: '' };
    }

    const minIterationsBeforeEscalation = Math.max(3, Math.ceil(input.maxIterations * 0.25));
    if (input.iteration < minIterationsBeforeEscalation) {
      return { shouldEscalate: false, reason: '' };
    }

    const noProgress = input.progressIterationsSinceProgress >= input.progressStuckThreshold;
    if (!noProgress) {
      return { shouldEscalate: false, reason: '' };
    }

    const hasRecentSignal =
      input.lastSignalIteration > 0 && input.iteration - input.lastSignalIteration <= 3;
    const hasRecentProgress =
      input.lastProgressIteration > 0 && input.iteration - input.lastProgressIteration <= 2;
    if (hasRecentSignal || hasRecentProgress) {
      return { shouldEscalate: false, reason: '' };
    }

    const repeatedSingleTool =
      input.lastToolCalls.length >= 3 &&
      new Set(input.lastToolCalls.slice(-3)).size === 1;
    if (repeatedSingleTool) {
      return { shouldEscalate: true, reason: 'repeating same tool calls without new signal' };
    }

    const iterationUtilization =
      input.maxIterations > 0 ? input.iteration / input.maxIterations : 1;
    const evidenceCount =
      input.filesRead.size + input.filesModified.size + input.filesCreated.size;
    if (iterationUtilization >= 0.45 && evidenceCount <= 2) {
      return { shouldEscalate: true, reason: 'low evidence accumulation and stalled progress' };
    }

    return { shouldEscalate: false, reason: '' };
  }
}

export function isAuditOrAnalysisTask(task: string): boolean {
  return /(audit|architecture|error handling|failure|reliability|resilience|retry|rate.?limit|timeout|anthropic|openai|llm|анализ|аудит|архитектур|ошибк|надежн|ретра|таймаут|лимит)/i.test(task);
}

export function isLikelyActionTask(
  task: string,
  taskIntent: 'action' | 'discovery' | 'analysis' | null
): boolean {
  if (taskIntent) {
    return taskIntent === 'action';
  }
  return /(create|implement|fix|patch|write|edit|add|remove|rename|refactor|удали|создай|исправ|добав|переимен|рефактор)/i.test(task);
}
