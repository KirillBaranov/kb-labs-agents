/**
 * Cross-Tier Verifier
 *
 * Uses a DIFFERENT (smarter) model to verify agent responses.
 * This avoids self-assessment bias where LLM overestimates itself.
 *
 * Key insight: verification is 1 API call vs 50+ tool calls for execution.
 * Using medium tier for verification is cost-effective and more reliable.
 */

import { useLLM, type LLMTool } from '@kb-labs/sdk';
import type {
  VerificationInput,
  VerificationOutput,
  VerificationResult,
  VerificationWarning,
} from '@kb-labs/agent-contracts';

// ═══════════════════════════════════════════════════════════════════════
// Verification Tool Definition
// ═══════════════════════════════════════════════════════════════════════

/**
 * Tool definition for verification.
 * Verifier MUST call this tool to submit assessment.
 */
export const VERIFICATION_TOOL: LLMTool = {
  name: 'submit_verification',
  description: 'Submit your verification of the agent response. You MUST call this tool with your assessment.',
  inputSchema: {
    type: 'object',
    properties: {
      mentions: {
        type: 'array',
        items: { type: 'string' },
        description: 'All file paths, package names, class names mentioned in the answer',
      },
      verified: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mentions that appear in tool results (confirmed to exist)',
      },
      unverified: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mentions NOT found in tool results (potential hallucinations)',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How confident the answer is correct. 1.0=certain, 0.7=fairly sure, 0.5=uncertain, 0.3=likely wrong',
      },
      completeness: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How completely the answer addresses the question. 1.0=fully, 0.7=mostly, 0.5=partially, 0.3=barely',
      },
      gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Aspects of the question that remain unanswered',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Potential issues: hallucinations, contradictions, missing context',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of your assessment',
      },
    },
    required: ['mentions', 'verified', 'unverified', 'confidence', 'completeness', 'gaps', 'warnings', 'reasoning'],
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Verification Prompt
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build prompt for cross-tier verification
 */
function buildVerificationPrompt(input: VerificationInput): string {
  return `You are a VERIFICATION agent. Your job is to check another agent's response for accuracy.

## Original Task
${input.task}

## Agent's Answer
${input.answer}

## Tool Results Summary (what agent actually found)
${input.toolResultsSummary}

## Files Actually Read
${input.filesRead?.join('\n') || 'None listed'}

---

## Your Task

1. **Extract mentions**: Find all file paths, package names, class/function names mentioned in the answer
2. **Verify mentions**: Check which mentions appear in the tool results (verified) vs not (unverified)
3. **Assess confidence**: How likely is the answer correct? (unverified mentions = lower confidence)
4. **Assess completeness**: Does the answer fully address the original task?
5. **Identify gaps**: What parts of the question weren't answered?
6. **Flag warnings**: Any contradictions, hallucinations, or issues?

Call submit_verification with your assessment.`;
}

// ═══════════════════════════════════════════════════════════════════════
// Cross-Tier Verification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request verification from a higher-tier model.
 *
 * @param input - Verification input (task, answer, tool results)
 * @returns Verification output with confidence, gaps, warnings
 */
export async function requestVerification(
  input: VerificationInput,
): Promise<VerificationOutput> {
  // Determine verifier tier (one level above executor)
  const executorTier = input.executorTier ?? 'small';
  const verifierTier = executorTier === 'small' ? 'medium' : 'large';

  const llm = useLLM({ tier: verifierTier });

  if (!llm) {
    return createFallbackVerification('LLM not available');
  }

  // Check if LLM supports chatWithTools
  if (!llm.chatWithTools) {
    return createFallbackVerification('LLM does not support chatWithTools');
  }

  const prompt = buildVerificationPrompt(input);

  try {
    // Add 60s timeout to prevent verification from hanging indefinitely
    const response = await Promise.race([
      llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        {
          tools: [VERIFICATION_TOOL],
          toolChoice: { type: 'function', function: { name: 'submit_verification' } },
          temperature: 0.1, // Low temperature for consistent verification
        },
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Verification timeout after 60s')), 60000);
      }),
    ]) as Awaited<ReturnType<typeof llm.chatWithTools>>;

    const toolCall = response.toolCalls?.[0];
    if (toolCall && toolCall.name === 'submit_verification') {
      const result = toolCall.input as VerificationOutput;
      return {
        mentions: result.mentions || [],
        verified: result.verified || [],
        unverified: result.unverified || [],
        confidence: clamp(result.confidence ?? 0.5, 0, 1),
        completeness: clamp(result.completeness ?? 0.5, 0, 1),
        gaps: result.gaps || [],
        warnings: result.warnings || [],
        reasoning: result.reasoning || '',
      };
    }

    return createFallbackVerification('No tool call received from verifier');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return createFallbackVerification(`Verification failed: ${errorMsg}`);
  }
}

/**
 * Convert raw VerificationOutput to VerificationResult with warnings
 */
export function toVerificationResult(output: VerificationOutput): VerificationResult {
  const warnings: VerificationWarning[] = [];

  // Convert string warnings to structured warnings
  for (const warning of output.warnings) {
    warnings.push({
      code: 'VERIFICATION_FAILED',
      message: warning,
    });
  }

  // Add warnings for unverified mentions
  for (const mention of output.unverified) {
    // Determine warning type based on mention format
    let code: VerificationWarning['code'] = 'UNVERIFIED_FILE';
    if (mention.includes('/') || mention.includes('.ts') || mention.includes('.js')) {
      code = 'UNVERIFIED_FILE';
    } else if (mention.startsWith('@') || mention.includes('-')) {
      code = 'UNVERIFIED_PACKAGE';
    } else if (mention[0] && mention[0] === mention[0].toUpperCase()) {
      code = 'UNVERIFIED_CLASS';
    } else {
      code = 'UNVERIFIED_FUNCTION';
    }

    warnings.push({
      code,
      message: `Could not verify: ${mention}`,
      details: { mention },
    });
  }

  // Add low confidence warning
  if (output.confidence < 0.5) {
    warnings.push({
      code: 'LOW_CONFIDENCE',
      message: `Low confidence response: ${(output.confidence * 100).toFixed(0)}%`,
      details: { confidence: output.confidence },
    });
  }

  // Add incomplete warning
  if (output.completeness < 0.6) {
    warnings.push({
      code: 'INCOMPLETE_ANSWER',
      message: `Incomplete answer: ${(output.completeness * 100).toFixed(0)}% complete`,
      details: { completeness: output.completeness, gaps: output.gaps },
    });
  }

  return {
    mentions: output.mentions,
    verifiedMentions: output.verified,
    unverifiedMentions: output.unverified,
    confidence: output.confidence,
    completeness: output.completeness,
    gaps: output.gaps,
    warnings,
    reasoning: output.reasoning,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createFallbackVerification(reason: string): VerificationOutput {
  return {
    mentions: [],
    verified: [],
    unverified: [],
    confidence: 0.5,
    completeness: 0.5,
    gaps: ['Verification could not be completed'],
    warnings: [reason],
    reasoning: reason,
  };
}

/**
 * Verify an agent response using cross-tier verification.
 *
 * Convenience function that combines requestVerification and toVerificationResult.
 *
 * @param input - Verification input
 * @returns Verification result with warnings
 */
export async function verifyResponse(input: VerificationInput): Promise<VerificationResult> {
  const output = await requestVerification(input);
  return toVerificationResult(output);
}
