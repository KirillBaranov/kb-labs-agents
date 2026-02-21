/**
 * Phase 3: Universal Task Runner - Verifier
 *
 * Uses Opus to verify step results and decide proceed/retry/escalate
 */

import { useLLM } from '@kb-labs/sdk';
import type { PlanStep, StepResult, VerificationDecision, TaskCheckpoint } from './types.js';

export interface VerifierConfig {
  /**
   * Min confidence to proceed (0.0-1.0)
   */
  minConfidence?: number;

  /**
   * Verbose logging
   */
  verbose?: boolean;
}

export class Verifier {
  private config: Required<VerifierConfig>;

  constructor(config: VerifierConfig = {}) {
    this.config = {
      minConfidence: config.minConfidence ?? 0.7,
      verbose: config.verbose ?? false,
    };
  }

  /**
   * Verify step result and decide next action
   */
  async verify(step: PlanStep, result: StepResult, checkpoint: TaskCheckpoint): Promise<VerificationDecision> {
    this.log(`\n🔍 Verifying Step ${step.stepNumber} result...`);

    const llm = useLLM({ tier: 'large' }); // Opus for verification

    if (!llm || !llm.chatWithTools) {
      throw new Error('LLM not available or does not support chatWithTools');
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(step, result, checkpoint);

    const response = await llm.chatWithTools(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for verification
        temperature: 0.1,
      }
    );

    const decision = this.parseDecisionFromResponse(response.content);

    this.log(`✅ Verification complete: ${decision.verdict} (confidence: ${decision.confidence})`);

    return decision;
  }

  /**
   * Build system prompt for verification
   */
  private buildSystemPrompt(): string {
    return `You are an expert result verifier. Your job is to assess step execution results and decide the next action.

**Decisions:**

1. **proceed** - Step succeeded, continue to next step
   - All success criteria met
   - Confidence ≥ ${this.config.minConfidence}
   - No critical errors

2. **retry** - Step partially succeeded or failed, try again with modifications
   - Some success criteria not met
   - Fixable errors (wrong approach, missing context, etc.)
   - Haven't exceeded max retries (typically 2-3)

3. **escalate** - Uncertain result, need human judgment
   - Unclear if success criteria met
   - Low confidence (< ${this.config.minConfidence})
   - Ambiguous output

4. **abort** - Critical failure, cannot proceed
   - Unrecoverable errors
   - Maximum retries exceeded
   - Task fundamentally impossible

**Assessment criteria:**

- Did the step accomplish what it set out to do?
- Were all success criteria met?
- Are there errors or warnings that need attention?
- Does the output make sense given the step description?
- Should the plan be adjusted based on what we learned?

**Output format:** JSON object:
\`\`\`json
{
  "verdict": "proceed",
  "confidence": 0.85,
  "reasoning": "Step completed successfully. All files created and tests pass.",
  "planAdjustments": {
    "skipSteps": [5],
    "modifySteps": [
      {
        "stepNumber": 4,
        "changes": {
          "description": "Updated based on new findings"
        }
      }
    ]
  }
}
\`\`\`

**Be conservative:** When in doubt, escalate to human rather than making risky assumptions.`;
  }

  /**
   * Build user prompt with step details
   */
  private buildUserPrompt(step: PlanStep, result: StepResult, checkpoint: TaskCheckpoint): string {
    const parts: string[] = [];

    parts.push(`**Step ${step.stepNumber}: ${step.description}**\n`);

    parts.push('**Expected Actions:**');
    for (const action of step.actions) {
      parts.push(`- ${action}`);
    }
    parts.push('');

    parts.push('**Success Criteria:**');
    for (const criterion of step.successCriteria) {
      parts.push(`- ${criterion}`);
    }
    parts.push('');

    parts.push(`**Execution Result:**`);
    parts.push(`- Status: ${result.status}`);
    parts.push(`- Duration: ${result.durationMs}ms`);
    if (result.costUsd) {
      parts.push(`- Cost: $${result.costUsd}`);
    }
    parts.push('');

    parts.push(`**Output:**`);
    parts.push(result.output);
    parts.push('');

    if (result.filesAffected && result.filesAffected.length > 0) {
      parts.push(`**Files Affected:**`);
      for (const file of result.filesAffected) {
        parts.push(`- ${file}`);
      }
      parts.push('');
    }

    if (result.errors && result.errors.length > 0) {
      parts.push(`**Errors:**`);
      for (const error of result.errors) {
        parts.push(`- ${error}`);
      }
      parts.push('');
    }

    if (result.warnings && result.warnings.length > 0) {
      parts.push(`**Warnings:**`);
      for (const warning of result.warnings) {
        parts.push(`- ${warning}`);
      }
      parts.push('');
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      parts.push(`**Tool Calls Made:** ${result.toolCalls.length}`);
      parts.push('');
    }

    parts.push(`**Remaining Steps in Plan:**`);
    const remaining = checkpoint.plan.steps.filter((s) => s.stepNumber > step.stepNumber);
    for (const s of remaining) {
      parts.push(`- Step ${s.stepNumber}: ${s.description}`);
    }
    parts.push('');

    parts.push(
      'Assess this result and decide: proceed, retry, escalate, or abort. Output valid JSON only (no markdown, no explanation).'
    );

    return parts.join('\n');
  }

  /**
   * Parse verification decision from LLM response
   */
  private parseDecisionFromResponse(response: string): VerificationDecision {
    try {
      // Strip markdown code blocks if present
      const cleaned = response.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      const decision: VerificationDecision = {
        verdict: parsed.verdict,
        confidence: Number(parsed.confidence),
        reasoning: String(parsed.reasoning),
      };

      if (parsed.retryStrategy) {
        decision.retryStrategy = {
          modifications: Array.isArray(parsed.retryStrategy.modifications)
            ? parsed.retryStrategy.modifications.map(String)
            : [],
          maxRetries: Number(parsed.retryStrategy.maxRetries ?? 3),
        };
      }

      if (parsed.escalationReason) {
        decision.escalationReason = String(parsed.escalationReason);
      }

      if (parsed.planAdjustments) {
        decision.planAdjustments = {
          skipSteps: Array.isArray(parsed.planAdjustments.skipSteps)
            ? parsed.planAdjustments.skipSteps.map(Number)
            : undefined,
          addSteps: Array.isArray(parsed.planAdjustments.addSteps) ? parsed.planAdjustments.addSteps : undefined,
          modifySteps: Array.isArray(parsed.planAdjustments.modifySteps)
            ? parsed.planAdjustments.modifySteps
            : undefined,
        };
      }

      return decision;
    } catch (error) {
      throw new Error(
        `Failed to parse verification decision: ${error instanceof Error ? error.message : String(error)}\n\nResponse:\n${response}`
      );
    }
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }
}
