/**
 * Reporting tools - for sub-agents to communicate with parent agent
 */

import type { Tool, ToolContext } from '../types.js';

/**
 * Ask parent agent for help when stuck or uncertain.
 * Sub-agents use this to escalate to the main agent for guidance.
 */
export function createAskParentTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'ask_parent',
        description: `Ask the parent agent for help when stuck or need clarification.`,
        parameters: {
          type: 'object' as const,
          properties: {
            question: {
              type: 'string' as const,
              description: 'Your question for the parent agent. Be specific about what you need help with.',
            },
            reason: {
              type: 'string' as const,
              enum: ['stuck', 'uncertain', 'blocker', 'clarification'],
              description: 'Why are you asking? stuck=repeating tools, uncertain=unclear approach, blocker=cannot proceed, clarification=need more info',
            },
            context: {
              type: 'object' as const,
              description: 'Relevant context: tools tried, iteration number, what you attempted',
            },
          },
          required: ['question', 'reason'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const question = input.question as string;
      const reason = input.reason as string;
      const context = input.context as Record<string, unknown> | undefined;

      return {
        success: true,
        output: '', // Will be populated by parent agent
        metadata: {
          question,
          reason,
          context,
          needsParentHelp: true,
        },
      };
    },
  };
}

/**
 * Report findings and exit. Used by agents to provide synthesized answer
 * and signal early exit when task is complete.
 */
export function createReportTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'report',
        description: `Report your answer and exit. Include specific findings with file paths and code snippets as evidence.`,
        parameters: {
          type: 'object' as const,
          properties: {
            answer: {
              type: 'string' as const,
              description: 'Synthesized answer with specific details, file references, and code snippets. Be concise but complete.',
            },
            confidence: {
              type: 'number' as const,
              description: 'How confident you are in this answer (0.0-1.0). Use 0.8+ if you found concrete evidence, 0.5-0.7 if partial, <0.5 if uncertain.',
            },
          },
          required: ['answer', 'confidence'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const answer = input.answer as string;
      const confidence = input.confidence as number;

      return {
        success: true,
        output: '', // Intentionally empty - agent should exit after calling this
        metadata: {
          answer,
          confidence,
          earlyExit: true,
        },
      };
    },
  };
}

/**
 * Reflection tool - agent reflects on progress and decides whether to continue.
 * Auto-triggers report when confidence is high and shouldContinue is false.
 */
export function createReflectOnProgressTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'reflect_on_progress',
        description: `Reflect on progress and decide whether to continue or report. If confidence >= 0.7 and should_continue = false, auto-reports findings.`,
        parameters: {
          type: 'object' as const,
          properties: {
            findings_summary: {
              type: 'string' as const,
              description: 'Brief summary of what you accomplished so far (2-3 sentences)',
            },
            confidence: {
              type: 'number' as const,
              description: 'Confidence that task is complete (0.0-1.0). For implementation: 0.8+ only if artifacts created. For research: 0.8+ if answers found.',
              minimum: 0,
              maximum: 1,
            },
            questions_remaining: {
              type: 'array' as const,
              items: { type: 'string' as const },
              description: 'List of aspects still incomplete. Empty array if all done.',
            },
            should_continue: {
              type: 'boolean' as const,
              description: 'true = need more work, false = ready to report completion',
            },
            reason: {
              type: 'string' as const,
              description: 'Explanation for your continue/stop decision (1 sentence)',
            },
            evidence_of_completion: {
              type: 'string' as const,
              description: 'Concrete evidence of task completion (e.g., "Created 15 files", "Tests passing", "Found answer in 3 sources"). Required for high confidence.',
            },
          },
          required: ['findings_summary', 'confidence', 'questions_remaining', 'should_continue', 'reason', 'evidence_of_completion'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const reflection = {
        findingsSummary: input.findings_summary as string,
        confidence: input.confidence as number,
        questionsRemaining: input.questions_remaining as string[],
        shouldContinue: input.should_continue as boolean,
        reason: input.reason as string,
        evidenceOfCompletion: input.evidence_of_completion as string,
      };

      // Anti-hallucination check: If agent claims completion without evidence, reduce confidence
      const hasNoEvidence = !reflection.evidenceOfCompletion ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('need to') ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('will create') ||
                           reflection.evidenceOfCompletion.toLowerCase().includes('plan to');

      let adjustedConfidence = reflection.confidence;
      let adjustedShouldContinue = reflection.shouldContinue;
      let warningMessage = '';

      if (reflection.confidence >= 0.7 && !reflection.shouldContinue && hasNoEvidence) {
        adjustedConfidence = 0.3;
        adjustedShouldContinue = true;
        warningMessage = ' [ADJUSTED: No concrete evidence of completion - lowered confidence to 0.30, continue required]';
      }

      return {
        success: true,
        output: `Reflection recorded: confidence=${adjustedConfidence.toFixed(2)}, should_continue=${adjustedShouldContinue}${warningMessage}`,
        metadata: {
          reflection: {
            ...reflection,
            confidence: adjustedConfidence,
            shouldContinue: adjustedShouldContinue,
          },
          shouldAutoReport: adjustedConfidence >= 0.7 && !adjustedShouldContinue,
          adjusted: adjustedConfidence !== reflection.confidence,
        },
      };
    },
  };
}
