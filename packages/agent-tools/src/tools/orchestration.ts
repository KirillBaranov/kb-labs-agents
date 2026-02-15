/**
 * Orchestration tools - for child agents to report back to orchestrator
 */

import type { Tool, ToolContext } from '../types.js';

/**
 * Ask orchestrator for help when stuck or uncertain
 *
 * Phase 1: Agent ↔ Orchestrator communication
 * Allows child agents to ask orchestrator for guidance during execution
 */
export function createAskOrchestratorTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'ask_orchestrator',
        description: `Ask the orchestrator for help when stuck, uncertain, or need clarification.

**When to use:**
- You're stuck in a loop (same tools repeatedly)
- You're uncertain about the approach
- You encountered a blocker (missing file, error, etc.)
- You need clarification about the task

**What to include:**
- Clear question about what you need help with
- What you've tried so far
- What's blocking you
- Current iteration and subtask context

**The orchestrator will:**
- Analyze your question + current execution plan
- Provide guidance, hints, or alternative approach
- Possibly skip current subtask or reorder plan`,
        parameters: {
          type: 'object' as const,
          properties: {
            question: {
              type: 'string' as const,
              description: 'Your question for the orchestrator. Be specific about what you need help with.',
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

      // This tool signals orchestrator to provide help
      // The orchestrator will intercept this and return guidance
      return {
        success: true,
        output: '', // Will be populated by orchestrator
        metadata: {
          question,
          reason,
          context,
          needsOrchestratorHelp: true,
        },
      };
    },
  };
}

/**
 * Report findings to orchestrator (early exit from research)
 *
 * This tool allows child agents to:
 * 1. Exit early when they have sufficient information
 * 2. Provide synthesized answer on last iteration
 *
 * The orchestrator will use this synthesized answer instead of just "Max iterations reached"
 */
export function createReportToOrchestratorTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'report_to_orchestrator',
        description: `Report synthesized findings to orchestrator and exit.

**When to use:**
- You've gathered sufficient information to answer the question
- You're on the last iteration and need to synthesize what you found
- You want to stop early instead of continuing to search

**What to include:**
- Direct answer to the question (be specific!)
- Key findings with file references (e.g., "In src/auth/service.ts, the AuthService...")
- Code snippets if relevant
- What you found vs what you couldn't find

**CRITICAL:** This is your ONLY chance to report. Make the answer complete and actionable.`,
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

      // This tool has NO output to the agent - it's a signal to exit
      // The orchestrator will extract the answer from tool call input
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
 * Reflection tool - agent reflects on progress and decides whether to continue
 *
 * This tool allows agents to:
 * 1. Summarize what they've found so far
 * 2. Assess confidence in their current answer
 * 3. Decide whether to continue searching or report findings
 *
 * The agent runtime can use this to auto-trigger report_to_orchestrator
 * when confidence is high and shouldContinue is false.
 */
export function createReflectOnProgressTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'reflect_on_progress',
        description: `Reflect on your current progress and decide if you should continue or report findings.

**When to use:**
- After completing several actions (reading files, creating files, running commands)
- When you think you might have enough progress to report
- Periodically (every 3-4 iterations) to check if you should stop

**What to include:**
- findings_summary: Brief summary of what you've accomplished (2-3 sentences)
- confidence: How confident you are that the task is complete (0.0 = no progress, 1.0 = fully done)
- questions_remaining: What aspects are still incomplete (empty array if all done)
- should_continue: true if more work needed, false if ready to report
- reason: Why you should continue or why you're done
- evidence_of_completion: What concrete evidence shows task completion (e.g., "Created 15 files", "Tests passing", "Service deployed")

**Important for implementation tasks:**
For tasks that require creating artifacts (code, files, deployments, API calls):
- confidence should be <0.7 if you haven't created the required artifacts yet
- evidence_of_completion should list what you created/deployed/changed
- Example: "Created package.json, src/index.ts, and 12 other files. Tests pass."

**Effect:**
If confidence >= 0.7 and should_continue = false, the system will automatically
call report_to_orchestrator with your findings_summary.`,
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
        // Agent claims high confidence and done, but no concrete evidence
        adjustedConfidence = 0.3;
        adjustedShouldContinue = true;
        warningMessage = ' [ADJUSTED: No concrete evidence of completion - lowered confidence to 0.30, continue required]';
      }

      // Return reflection for agent to process
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
