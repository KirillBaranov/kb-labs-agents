/**
 * Result processor that enhances summary with LLM
 */

import { useLLM } from '@kb-labs/sdk';
import type { ResultProcessor, TaskResult } from '@kb-labs/agent-contracts';

/**
 * Uses LLM to generate human-readable summary
 */
export class SummaryEnhancerProcessor implements ResultProcessor {
  async process(result: TaskResult): Promise<TaskResult> {
    const llm = useLLM({ tier: 'small' });

    if (!llm) {
      return result;
    }

    const prompt = this.buildPrompt(result);

    try {
      const response = await llm.complete(prompt, { temperature: 0 });

      return {
        ...result,
        enhancedSummary: response.content || result.summary,
      };
    } catch {
      // Fallback to original summary
      return result;
    }
  }

  private buildPrompt(result: TaskResult): string {
    return `Generate a concise human-readable summary of this agent execution.

**Success:** ${result.success}
**Original Summary:** ${result.summary}
**Files Created:** ${result.filesCreated.length}
**Files Modified:** ${result.filesModified.length}
**Iterations:** ${result.iterations}
**Tokens Used:** ${result.tokensUsed}

Provide a 2-3 sentence summary that explains what the agent accomplished. Be specific and informative.

Response format: Plain text summary (no markdown, no quotes).`;
  }
}
