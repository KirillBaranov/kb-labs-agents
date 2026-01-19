/**
 * Orchestrator Executor (V2 Architecture)
 *
 * Smart orchestrator that:
 * - Breaks complex tasks into subtasks
 * - Delegates subtasks to specialists
 * - Synthesizes results into coherent answer
 * - Uses smart tier LLM (e.g., GPT-4) for planning/synthesis
 *
 * Phase 2: Adaptive Feedback Loop
 * - Analyzes specialist findings
 * - Adapts execution plan dynamically
 * - Injects fix/review subtasks when needed
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM, useAnalytics } from '@kb-labs/sdk';
import type { SpecialistConfigV1 } from '@kb-labs/agent-contracts';
import { SpecialistExecutor, type SpecialistContext, type SpecialistResult } from './specialist-executor.js';
import { SpecialistRegistry } from '../registry/specialist-registry.js';
import { ToolDiscoverer } from '../tools/tool-discoverer.js';
import { OrchestratorAnalytics } from '../analytics/orchestrator-analytics.js';
import { FindingsStore } from './findings-store.js';
import type {
  SubTask,
  DelegatedResult,
  OrchestratorResult,
  SpecialistFinding,
  AdaptationDecision,
} from './types.js';

// Types moved to ./types.ts (Phase 2)

/**
 * Orchestrator Executor
 *
 * Manages task delegation to specialists:
 * 1. planExecution() - Break task into subtasks using smart LLM
 * 2. selectSpecialist() - Match subtasks to specialist capabilities
 * 3. delegateTask() - Execute subtask via SpecialistExecutor
 * 4. synthesizeResults() - Combine specialist outputs into final answer
 */
export class OrchestratorExecutor {
  private registry: SpecialistRegistry;
  private toolDiscoverer: ToolDiscoverer;
  private specialistExecutor: SpecialistExecutor;
  private analytics: OrchestratorAnalytics;
  private findingsStore: FindingsStore; // Phase 2: Findings management
  private sessionId: string; // Phase 2: Unique session ID for cleanup

  constructor(private ctx: PluginContextV3) {
    this.registry = new SpecialistRegistry(ctx);
    this.toolDiscoverer = new ToolDiscoverer(ctx);
    this.specialistExecutor = new SpecialistExecutor(ctx);
    this.analytics = new OrchestratorAnalytics(useAnalytics());
    this.findingsStore = new FindingsStore(ctx);

    // Generate unique session ID for this orchestrator run
    this.sessionId = `orch-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Execute a complex task via delegation to specialists
   *
   * @param task - High-level task description
   * @returns Orchestration result with synthesized answer
   */
  async execute(task: string): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    this.ctx.platform.logger.info('Orchestrator started', {
      task,
      sessionId: this.sessionId,
    });
    this.analytics.trackTaskStarted(task);

    try {
      // Step 1: Plan execution (decompose task into subtasks)
      this.ctx.platform.logger.info('Planning execution...');
      this.analytics.trackPlanningStarted(task);
      const planStartTime = Date.now();

      const { plan, tokensUsed: planTokens } = await this.planExecution(task);
      totalTokens += planTokens;

      this.analytics.trackPlanningCompleted(plan, planTokens, Date.now() - planStartTime);
      this.ctx.platform.logger.info('Execution plan created', {
        subtasks: plan.length,
        tokensUsed: planTokens,
      });

      // Step 2: Execute subtasks in order (respecting dependencies)
      this.ctx.platform.logger.info('Executing subtasks...');
      const delegatedResults: DelegatedResult[] = [];
      let taskSolved = false; // Track if task is already solved

      for (const subtask of plan) {
        // Check dependencies
        if (subtask.dependencies && subtask.dependencies.length > 0) {
          const dependenciesMet = subtask.dependencies.every((depId) =>
            delegatedResults.some((r) => r.subtaskId === depId && r.success)
          );

          if (!dependenciesMet) {
            this.ctx.platform.logger.warn('Subtask dependencies not met, skipping', {
              subtaskId: subtask.id,
              dependencies: subtask.dependencies,
            });
            continue;
          }
        }

        // Execute subtask
        this.analytics.trackSpecialistDelegated(subtask);
        const result = await this.delegateTask(subtask);
        delegatedResults.push(result);
        totalTokens += result.tokensUsed;

        // Track specialist result
        if (result.success) {
          this.analytics.trackSpecialistCompleted(subtask, result);

          // Phase 2: Check for findings and potentially adapt plan
          if (result.findingsSummary && result.findingsSummary.actionable > 0) {
            this.ctx.platform.logger.info('Specialist reported actionable findings', {
              subtaskId: subtask.id,
              specialistId: subtask.specialistId,
              total: result.findingsSummary.total,
              actionable: result.findingsSummary.actionable,
              critical: result.findingsSummary.bySeverity.critical,
              high: result.findingsSummary.bySeverity.high,
            });

            // Analyze and potentially adapt plan
            const adaptation = await this.analyzeAndAdapt(task, plan, delegatedResults, result);

            if (adaptation.shouldAdapt && adaptation.confidence >= 0.7) {
              // Inject new subtasks after current position
              const insertIndex = plan.findIndex((s) => s.id === subtask.id) + 1;
              plan.splice(insertIndex, 0, ...adaptation.newSubtasks);

              this.ctx.platform.logger.info('✨ Plan adapted based on findings', {
                reason: adaptation.reason,
                confidence: adaptation.confidence,
                addedSubtasks: adaptation.newSubtasks.map((s: SubTask) => s.id),
                newTotalSubtasks: plan.length,
              });

              this.ctx.platform.analytics.track('orchestrator.plan.adapted', {
                trigger: subtask.specialistId,
                reason: adaptation.reason,
                confidence: adaptation.confidence,
                addedCount: adaptation.newSubtasks.length,
              });
            } else if (adaptation.shouldAdapt && adaptation.confidence < 0.7) {
              this.ctx.platform.logger.info('⚠️  Adaptation suggested but low confidence, skipping', {
                confidence: adaptation.confidence,
                reason: adaptation.reason,
              });
            }
          }
        } else {
          this.analytics.trackSpecialistFailed(subtask, result);
        }

        // Verify tool trace if available (anti-hallucination check)
        if (result.success && result.traceRef) {
          const verificationResult = await this.verifyToolTrace(result.traceRef, subtask.description);
          if (!verificationResult.verified) {
            this.ctx.platform.logger.warn('Tool trace verification failed', {
              subtaskId: subtask.id,
              traceRef: result.traceRef,
              reason: verificationResult.reason,
            });
            // Track verification failure
            this.ctx.platform.analytics.track('orchestrator.verification.failed', {
              subtaskId: subtask.id,
              specialistId: subtask.specialistId,
              reason: verificationResult.reason,
            });
          } else {
            this.ctx.platform.logger.debug('Tool trace verified', {
              subtaskId: subtask.id,
              traceRef: result.traceRef,
            });
          }
        }

        this.ctx.platform.logger.info('Subtask completed', {
          subtaskId: subtask.id,
          specialistId: subtask.specialistId,
          success: result.success,
          tokensUsed: result.tokensUsed,
        });

        // Stop if critical subtask failed
        if (!result.success && subtask.priority && subtask.priority >= 8) {
          this.ctx.platform.logger.error('Critical subtask failed, aborting', new Error(
            `Subtask ${subtask.id} failed: ${result.error || 'unknown error'}`
          ));
          break;
        }

        // Smart optimization: Only check early stopping/cancellation if we have significant work remaining
        // This avoids expensive LLM calls for simple 2-3 task plans
        const remainingCount = plan.length - delegatedResults.length;
        const shouldCheckOptimization = remainingCount >= 2; // Only if ≥2 tasks remain

        if (result.success && shouldCheckOptimization) {
          this.ctx.platform.logger.debug('Checking if task can be optimized', {
            completed: delegatedResults.length,
            remaining: remainingCount,
          });

          // Check if task is already solved (early stopping)
          const earlyStopCheck = await this.checkTaskCompletion(task, plan, delegatedResults);

          if (earlyStopCheck.isSolved) {
            taskSolved = true;
            this.ctx.platform.logger.info('✅ Task already solved, early stopping', {
              completedSubtasks: delegatedResults.length,
              skippedSubtasks: remainingCount,
              totalSubtasks: plan.length,
              confidence: earlyStopCheck.confidence,
              reason: earlyStopCheck.reason,
            });
            break; // Early exit - task is solved!
          }

          // If not solved, check if remaining work can be cancelled
          const remainingSubtasks = plan.slice(delegatedResults.length);
          const cancellationCheck = await this.shouldCancelRemaining(
            task,
            plan,
            delegatedResults,
            remainingSubtasks
          );

          if (cancellationCheck.shouldCancel) {
            this.ctx.platform.logger.info('🚫 Cancelling remaining specialists', {
              completedSubtasks: delegatedResults.length,
              cancelledSubtasks: remainingSubtasks.length,
              confidence: cancellationCheck.confidence,
              reason: cancellationCheck.reason,
            });
            // Track cancellation in analytics
            this.ctx.platform.analytics.track('orchestrator.specialists.cancelled', {
              completedCount: delegatedResults.length,
              cancelledCount: remainingSubtasks.length,
              confidence: cancellationCheck.confidence,
              reason: cancellationCheck.reason,
            });
            break; // Cancel remaining specialists
          }
        }
      }

      // Step 3: Synthesize results into final answer
      this.ctx.platform.logger.info('Synthesizing results...');
      this.analytics.trackSynthesisStarted(delegatedResults.length);
      const synthesisStartTime = Date.now();

      const { answer, tokensUsed: synthesisTokens } = await this.synthesizeResults(
        task,
        plan,
        delegatedResults
      );
      totalTokens += synthesisTokens;

      this.analytics.trackSynthesisCompleted(answer.length, synthesisTokens, Date.now() - synthesisStartTime);

      const durationMs = Date.now() - startTime;

      const result: OrchestratorResult = {
        success: true,
        answer,
        plan,
        delegatedResults,
        tokensUsed: totalTokens,
        durationMs,
      };

      this.analytics.trackTaskCompleted(task, result);
      this.ctx.platform.logger.info('Orchestrator completed', {
        success: true,
        subtasks: plan.length,
        tokensUsed: totalTokens,
        durationMs,
        sessionId: this.sessionId,
      });

      // Phase 2: Cleanup findings when orchestrator session ends
      await this.cleanupFindings();

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.analytics.trackTaskFailed(task, errorMessage, durationMs, totalTokens);
      this.ctx.platform.logger.error('Orchestrator failed', error instanceof Error ? error : new Error(errorMessage));

      // Phase 2: Cleanup findings even on failure
      await this.cleanupFindings();

      return {
        success: false,
        answer: '',
        plan: [],
        delegatedResults: [],
        tokensUsed: totalTokens,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Cleanup findings when orchestrator session ends (Phase 2)
   *
   * Best-effort cleanup - doesn't fail orchestrator if cleanup fails
   */
  private async cleanupFindings(): Promise<void> {
    try {
      const cleaned = await this.findingsStore.cleanupSession(this.sessionId);

      if (cleaned > 0) {
        this.ctx.platform.logger.debug('Findings cleanup completed', {
          sessionId: this.sessionId,
          findingsCleaned: cleaned,
        });
      }
    } catch (error) {
      this.ctx.platform.logger.warn('Failed to cleanup findings', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - cleanup failure shouldn't fail the orchestrator
    }
  }

  /**
   * Plan execution by decomposing task into subtasks
   *
   * Uses smart tier LLM to analyze task and create execution plan.
   * Considers available specialists and their capabilities.
   *
   * @param task - High-level task description
   * @returns Execution plan with subtasks
   */
  private async planExecution(
    task: string
  ): Promise<{ plan: SubTask[]; tokensUsed: number }> {
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not available for orchestrator planning');
    }

    // Load available specialists
    const specialists = await this.registry.list();
    const specialistDescriptions = specialists
      .map(
        (s) =>
          `- ${s.id}: ${s.description || 'No description'}\n  Capabilities: ${s.capabilities?.join(', ') || 'None'}`
      )
      .join('\n');

    // Get first specialist ID for example (or fallback)
    const exampleSpecialistId = specialists.length > 0 ? specialists[0]!.id : 'coding-agent';

    const systemPrompt = `You are an AI orchestrator that breaks complex tasks into subtasks.

# Available Specialists:
${specialistDescriptions}

**CRITICAL: You MUST use specialist IDs from the list above. Do NOT invent new specialist IDs!**

# Your Role:
1. Analyze the task
2. Break it into logical subtasks (keep it simple - prefer 2-3 subtasks over many)
3. Assign each subtask to the most appropriate specialist **from the list above**
4. Define dependencies between subtasks
5. Assign priority (1-10, higher = more critical)

# Output Format:
Return a JSON array of subtasks in this exact format:

\`\`\`json
[
  {
    "id": "subtask-1",
    "description": "Clear description of what to do",
    "specialistId": "${exampleSpecialistId}",
    "dependencies": [],
    "priority": 8,
    "estimatedComplexity": "medium"
  }
]
\`\`\`

**Rules:**
1. Each subtask must have a unique id (subtask-1, subtask-2, etc.)
2. **CRITICAL**: Use ONLY specialist IDs from the "Available Specialists" list - never invent IDs!
3. Keep plans simple - prefer fewer, well-defined subtasks
4. Keep subtask descriptions clear and actionable
5. Priority: 10 = critical, 1 = optional
6. Dependencies: array of subtask IDs that must complete first
7. Return ONLY the JSON array, no extra text

**Available specialist IDs**: ${specialists.map(s => s.id).join(', ')}`;

    const userPrompt = `Task: ${task}\n\nCreate an execution plan by breaking this task into subtasks and assigning them to specialists.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for planning
      }
    );

    const content = response.content || '';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    // Extract JSON from response
    const plan = this.extractPlan(content);

    return { plan, tokensUsed };
  }

  /**
   * Extract execution plan from LLM response
   *
   * Tries multiple strategies to parse JSON array of subtasks.
   *
   * @param content - LLM response content
   * @returns Parsed subtasks
   */
  private extractPlan(content: string): SubTask[] {
    // Strategy 1: Extract from ```json ... ``` code block
    const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed as SubTask[];
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON code block', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 2: Find JSON array anywhere in content
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed as SubTask[];
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON array', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 3: Fallback - try to parse entire content
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as SubTask[];
      }
    } catch {
      // Silent fail, will throw below
    }

    throw new Error('Failed to extract execution plan from LLM response');
  }

  /**
   * Delegate a subtask to a specialist
   *
   * Loads specialist configuration, discovers tools, and executes via SpecialistExecutor.
   *
   * @param subtask - Subtask to execute
   * @returns Delegated result
   */
  private async delegateTask(subtask: SubTask): Promise<DelegatedResult> {
    const startTime = Date.now();

    try {
      // Load specialist configuration
      const config = await this.registry.load(subtask.specialistId);

      // Discover tools for specialist using new strategy
      const tools = await this.toolDiscoverer.discoverWithStrategy(config.tools);

      // Create specialist context
      const context: SpecialistContext = { config, tools };

      // Execute via SpecialistExecutor
      const result = await this.specialistExecutor.execute(context, subtask.description);

      // Phase 2: Process findings if specialist returned them
      let findingsSummary: DelegatedResult['findingsSummary'];
      let findingsRef: string | undefined;

      if (result.output && typeof result.output === 'object' && 'findings' in result.output) {
        const findings = (result.output as { findings: SpecialistFinding[] }).findings;

        if (findings && findings.length > 0) {
          // Store full findings separately (not in orchestrator context)
          findingsRef = await this.findingsStore.save(this.sessionId, subtask.id, findings);

          // Create compact summary for context (max 3 findings + stats)
          findingsSummary = this.findingsStore.createSummary(findings);

          this.ctx.platform.logger.debug('Findings processed', {
            subtaskId: subtask.id,
            totalFindings: findings.length,
            findingsRef,
          });
        }
      }

      return {
        subtaskId: subtask.id,
        specialistId: subtask.specialistId,
        success: result.success,
        output: result.output,
        error: result.error,
        tokensUsed: result.tokensUsed,
        durationMs: Date.now() - startTime,
        traceRef: result.traceRef,
        findingsSummary, // Compact summary in context
        findingsRef, // Reference to full findings
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error('Subtask delegation failed', new Error(
        `[${subtask.specialistId}] Subtask ${subtask.id}: ${errorMessage}`
      ));

      return {
        subtaskId: subtask.id,
        specialistId: subtask.specialistId,
        success: false,
        output: null,
        error: errorMessage,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Verify tool trace for anti-hallucination check
   *
   * Basic verification (Phase 1):
   * - Check trace exists
   * - Check trace has invocations
   * - Check trace is complete
   *
   * Future (Phase 2): Deep verification with evidence refs
   *
   * @param traceRef - Tool trace reference (format: "trace:<traceId>")
   * @param taskDescription - Task description for context
   * @returns Verification result
   */
  private async verifyToolTrace(
    traceRef: string,
    taskDescription: string
  ): Promise<{ verified: boolean; reason?: string }> {
    // Extract trace ID from reference
    const traceId = traceRef.replace(/^trace:/, '');

    // For Phase 1: Just log that verification would happen here
    // In Phase 2: Actually load and verify the trace
    this.ctx.platform.logger.debug('Tool trace verification (placeholder)', {
      traceId,
      taskDescription,
    });

    // TODO Phase 2: Implement actual verification
    // - Load trace from ToolTraceStore
    // - Check invocations have evidence refs
    // - Verify evidence refs point to real data
    // - Check for hallucination patterns

    // For now, assume verified (optimistic)
    return {
      verified: true,
    };
  }

  /**
   * Check if task is already solved based on completed results
   *
   * Uses smart tier LLM to assess whether the original task
   * is already fully solved, enabling early stopping.
   *
   * @param task - Original task
   * @param plan - Execution plan
   * @param delegatedResults - Completed specialist results
   * @returns Completion assessment
   */
  private async checkTaskCompletion(
    task: string,
    plan: SubTask[],
    delegatedResults: DelegatedResult[]
  ): Promise<{ isSolved: boolean; confidence: number; reason: string }> {
    const llm = useLLM();
    if (!llm) {
      return { isSolved: false, confidence: 0, reason: 'LLM not available' };
    }

    // Build summary of completed work
    const completedWork = delegatedResults
      .map((r, i) => {
        const subtask = plan.find((s) => s.id === r.subtaskId);
        const status = r.success ? '✅ SUCCESS' : '❌ FAILED';
        let output = '';

        if (r.success && r.output) {
          if (typeof r.output === 'string') {
            output = r.output.substring(0, 500); // Limit output length
          } else {
            output = JSON.stringify(r.output, null, 2).substring(0, 500);
          }
        } else if (r.error) {
          output = `Error: ${r.error}`;
        }

        return `${i + 1}. [${subtask?.id}] ${subtask?.description || '(unknown)'}\n   Status: ${status}\n   Specialist: ${r.specialistId}\n   Output: ${output}`;
      })
      .join('\n\n');

    // Build list of remaining subtasks
    const remainingSubtasks = plan
      .slice(delegatedResults.length)
      .map((s) => `- [${s.id}] ${s.description} (assigned to: ${s.specialistId})`)
      .join('\n');

    const systemPrompt = `You are an AI orchestrator evaluating task completion.

# Your Role:
Determine if the original task is ALREADY FULLY SOLVED based on completed subtasks.

**Be conservative**: Only mark as solved if the task is COMPLETELY done.
- If key information is still missing → NOT solved
- If remaining subtasks add critical value → NOT solved
- If task is 90% done but needs finishing touches → NOT solved

# Response Format:
Return ONLY a JSON object in this exact format:

\`\`\`json
{
  "isSolved": true,
  "confidence": 0.95,
  "reason": "All requirements met. User authentication implemented and tested."
}
\`\`\`

**Rules:**
- isSolved: true only if task is COMPLETELY solved
- confidence: 0.0-1.0 (how certain are you?)
- reason: brief explanation (1-2 sentences)
- Return ONLY the JSON, no extra text`;

    const userPrompt = `# Original Task:
${task}

# Execution Plan:
Total subtasks: ${plan.length}
Completed: ${delegatedResults.length}
Remaining: ${plan.length - delegatedResults.length}

# Completed Subtasks (${delegatedResults.length}/${plan.length}):
${completedWork}

${remainingSubtasks ? `\n# Remaining Subtasks:\n${remainingSubtasks}\n` : ''}

**Question**: Is the original task ALREADY FULLY SOLVED based on the completed subtasks?

Consider:
1. Does the completed work satisfy ALL requirements of the original task?
2. Would the remaining subtasks add essential information or just refinement?
3. Is there enough evidence that the task is done?

Return your assessment as JSON.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for assessment
      }
    );

    const content = response.content || '';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    this.ctx.platform.logger.debug('Task completion check', {
      tokensUsed,
      responseLength: content.length,
    });

    // Parse JSON response
    const result = this.parseCompletionCheck(content);
    return result;
  }

  /**
   * Check if remaining specialists should be cancelled
   *
   * Uses smart tier LLM to assess whether remaining subtasks
   * add meaningful value or can be safely skipped.
   *
   * @param task - Original task
   * @param plan - Full execution plan
   * @param delegatedResults - Completed results so far
   * @param remainingSubtasks - Subtasks not yet executed
   * @returns Cancellation decision
   */
  private async shouldCancelRemaining(
    task: string,
    plan: SubTask[],
    delegatedResults: DelegatedResult[],
    remainingSubtasks: SubTask[]
  ): Promise<{ shouldCancel: boolean; confidence: number; reason: string }> {
    const llm = useLLM();
    if (!llm) {
      return { shouldCancel: false, confidence: 0, reason: 'LLM not available' };
    }

    // Build summary of completed work
    const completedWork = delegatedResults
      .map((r, i) => {
        const subtask = plan.find((s) => s.id === r.subtaskId);
        const status = r.success ? '✅ SUCCESS' : '❌ FAILED';
        return `${i + 1}. [${subtask?.id}] ${subtask?.description}\n   Status: ${status}\n   Specialist: ${r.specialistId}`;
      })
      .join('\n\n');

    // Build list of remaining subtasks with details
    const remainingWork = remainingSubtasks
      .map((s, i) => `${i + 1}. [${s.id}] ${s.description}\n   Priority: ${s.priority || 5}/10\n   Specialist: ${s.specialistId}`)
      .join('\n\n');

    const systemPrompt = `You are an AI orchestrator deciding whether to cancel remaining specialists.

# Your Role:
Determine if the remaining subtasks add MEANINGFUL VALUE or can be safely skipped.

**Be pragmatic**:
- If remaining work is low-priority refinement → CANCEL
- If remaining work duplicates what's already done → CANCEL
- If remaining work adds critical missing information → DO NOT CANCEL
- If remaining work is high-priority (≥8) → DO NOT CANCEL

# Response Format:
Return ONLY a JSON object:

\`\`\`json
{
  "shouldCancel": true,
  "confidence": 0.85,
  "reason": "Remaining tasks are low-priority refinements. Core task already solved."
}
\`\`\`

**Rules:**
- shouldCancel: true only if remaining work is NOT essential
- confidence: 0.0-1.0 (how certain are you?)
- reason: brief explanation (1-2 sentences)`;

    const userPrompt = `# Original Task:
${task}

# Completed Subtasks (${delegatedResults.length}/${plan.length}):
${completedWork}

# Remaining Subtasks (${remainingSubtasks.length}):
${remainingWork}

**Question**: Should we CANCEL the remaining subtasks and synthesize results now?

Consider:
1. Does the completed work already provide enough value?
2. Are the remaining tasks just refinements or duplicates?
3. Are any remaining tasks high-priority (≥8) or critical?

Return your decision as JSON.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [],
      }
    );

    const content = response.content || '';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    this.ctx.platform.logger.debug('Specialist cancellation check', {
      tokensUsed,
      responseLength: content.length,
    });

    // Parse JSON response (reuse parseCompletionCheck logic)
    const parsed = this.parseCancellationCheck(content);
    return parsed;
  }

  /**
   * Parse cancellation check from LLM response
   */
  private parseCancellationCheck(content: string): {
    shouldCancel: boolean;
    confidence: number;
    reason: string;
  } {
    // Strategy 1: Extract from ```json ... ``` code block
    const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (typeof parsed.shouldCancel === 'boolean') {
          return {
            shouldCancel: parsed.shouldCancel,
            confidence: parsed.confidence || 0.5,
            reason: parsed.reason || 'No reason provided',
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse cancellation JSON', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 2: Find JSON object anywhere
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (typeof parsed.shouldCancel === 'boolean') {
          return {
            shouldCancel: parsed.shouldCancel,
            confidence: parsed.confidence || 0.5,
            reason: parsed.reason || 'No reason provided',
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse cancellation object', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: assume do not cancel (conservative)
    this.ctx.platform.logger.warn('Failed to parse cancellation check, assuming continue');
    return {
      shouldCancel: false,
      confidence: 0,
      reason: 'Failed to parse LLM response',
    };
  }

  /**
   * Parse task completion check from LLM response
   *
   * Tries multiple strategies to extract JSON assessment.
   *
   * @param content - LLM response content
   * @returns Parsed completion check
   */
  private parseCompletionCheck(content: string): {
    isSolved: boolean;
    confidence: number;
    reason: string;
  } {
    // Strategy 1: Extract from ```json ... ``` code block
    const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (typeof parsed.isSolved === 'boolean') {
          return {
            isSolved: parsed.isSolved,
            confidence: parsed.confidence || 0.5,
            reason: parsed.reason || 'No reason provided',
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON code block', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 2: Find JSON object anywhere in content
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (typeof parsed.isSolved === 'boolean') {
          return {
            isSolved: parsed.isSolved,
            confidence: parsed.confidence || 0.5,
            reason: parsed.reason || 'No reason provided',
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON object', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 3: Fallback - try to parse entire content
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.isSolved === 'boolean') {
        return {
          isSolved: parsed.isSolved,
          confidence: parsed.confidence || 0.5,
          reason: parsed.reason || 'No reason provided',
        };
      }
    } catch {
      // Silent fail, will return default below
    }

    // Default fallback: assume not solved
    this.ctx.platform.logger.warn('Failed to parse task completion check, assuming not solved');
    return {
      isSolved: false,
      confidence: 0,
      reason: 'Failed to parse LLM response',
    };
  }

  /**
   * Synthesize specialist results into final answer
   *
   * Uses smart tier LLM to combine outputs from multiple specialists
   * into a coherent, comprehensive answer.
   *
   * @param task - Original task
   * @param plan - Execution plan
   * @param results - Results from specialists
   * @returns Synthesized answer
   */
  private async synthesizeResults(
    task: string,
    plan: SubTask[],
    results: DelegatedResult[]
  ): Promise<{ answer: string; tokensUsed: number }> {
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not available for result synthesis');
    }

    // Build synthesis prompt with all specialist outputs
    let resultsText = '';
    for (const result of results) {
      const subtask = plan.find((s) => s.id === result.subtaskId);
      if (!subtask) continue;

      resultsText += `## ${subtask.description}\n`;
      resultsText += `**Specialist**: ${result.specialistId}\n`;
      resultsText += `**Status**: ${result.success ? 'Success' : 'Failed'}\n`;

      if (result.success && result.output) {
        if (typeof result.output === 'string') {
          resultsText += `**Output**:\n${result.output}\n\n`;
        } else {
          resultsText += `**Output**:\n${JSON.stringify(result.output, null, 2)}\n\n`;
        }
      } else if (result.error) {
        resultsText += `**Error**: ${result.error}\n\n`;
      }
    }

    const systemPrompt = `You are an AI orchestrator synthesizing results from multiple specialists.

# Your Role:
1. Review all specialist outputs
2. Identify key findings and insights
3. Combine information into a coherent answer
4. Resolve any conflicts or inconsistencies
5. Provide a comprehensive response to the original task

# Output Format:
Provide a clear, well-structured answer that:
- Directly addresses the original task
- Incorporates insights from all specialists
- Is easy to understand and actionable
- Cites which specialist provided which information (when relevant)`;

    const userPrompt = `# Original Task:
${task}

# Specialist Results:
${resultsText}

Synthesize these results into a comprehensive answer to the original task.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [], // No tools needed for synthesis
      }
    );

    const answer = response.content || '(no answer generated)';
    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    return { answer, tokensUsed };
  }

  /**
   * Analyze specialist result and decide how to adapt plan (Phase 2)
   *
   * Uses smart tier LLM to:
   * 1. Review findings from specialist
   * 2. Determine if fixes are needed
   * 3. Generate new subtasks for fixes
   * 4. Set up dependencies (e.g., re-review after fixes)
   *
   * @param task - Original task
   * @param plan - Current execution plan
   * @param delegatedResults - Results so far
   * @param currentResult - Current result with findings
   * @returns Adaptation decision
   */
  private async analyzeAndAdapt(
    task: string,
    plan: SubTask[],
    delegatedResults: DelegatedResult[],
    currentResult: DelegatedResult
  ): Promise<AdaptationDecision> {
    const llm = useLLM();
    if (!llm) {
      return {
        shouldAdapt: false,
        reason: 'LLM not available',
        newSubtasks: [],
        confidence: 0,
      };
    }

    // If no findings, no adaptation needed
    if (!currentResult.findingsSummary || currentResult.findingsSummary.total === 0) {
      return {
        shouldAdapt: false,
        reason: 'No findings to act on',
        newSubtasks: [],
        confidence: 1,
      };
    }

    const summary = currentResult.findingsSummary;

    // Build COMPACT summary for LLM
    const findingsSummaryText = `
Total findings: ${summary.total}
Breakdown:
  - Critical: ${summary.bySeverity.critical}
  - High: ${summary.bySeverity.high}
  - Medium: ${summary.bySeverity.medium}
  - Low: ${summary.bySeverity.low}
  - Info: ${summary.bySeverity.info}

Actionable: ${summary.actionable}/${summary.total}

Top 3 findings:
${summary.topFindings
  .map(
    (f, i) => `
${i + 1}. [${f.severity.toUpperCase()}] ${f.category}: ${f.title}
   ${f.description}
   ${f.suggestedAction ? `→ Suggested: ${f.suggestedAction.type} - ${f.suggestedAction.description}` : '→ No suggested action'}
`
  )
  .join('\n')}
`.trim();

    // Get available specialists for targetSpecialist suggestions
    const specialists = await this.registry.list();
    const availableSpecialistIds = specialists.map((s) => s.id).join(', ');

    // UNIVERSAL prompt - works for any specialist type
    const systemPrompt = `You are an AI orchestrator deciding whether to adapt an execution plan based on specialist findings.

# Context:
A specialist (${currentResult.specialistId}) completed a subtask and reported findings.
Findings can be:
- Code issues (type errors, bugs, security vulnerabilities)
- Log patterns (errors, warnings, performance issues)
- Architecture problems (anti-patterns, design flaws)
- Performance bottlenecks (slow queries, memory leaks)
- Security risks (vulnerabilities, exposed secrets)
- Any other analysis results

# Decision Criteria:
**Adapt the plan if:**
- Critical or high-severity findings that MUST be addressed
- Findings have clear suggested actions that can be executed
- Findings would block remaining subtasks
- Fixing is straightforward and essential

**Do NOT adapt if:**
- Only informational findings (no action needed)
- Findings are low-priority suggestions
- Remaining plan already covers these concerns
- No clear action can be taken

# Response Format:
Return ONLY a JSON object:

\`\`\`json
{
  "shouldAdapt": true,
  "confidence": 0.85,
  "reason": "Found 3 critical issues that must be addressed before continuing",
  "newSubtasks": [
    {
      "id": "fix-1",
      "description": "Fix critical type errors in user.ts",
      "specialistId": "implementer",
      "dependencies": ["${currentResult.subtaskId}"],
      "priority": 9,
      "estimatedComplexity": "low"
    }
  ]
}
\`\`\`

**Rules:**
- Only create subtasks for essential actions
- Use suggested actions from findings when available
- Set correct dependencies (new tasks depend on current work: ["${currentResult.subtaskId}"])
- Use appropriate specialist IDs from: ${availableSpecialistIds}
- Keep descriptions specific and actionable
- Priority 8-10 for critical fixes, 5-7 for important improvements
- Return ONLY the JSON, no extra text`;

    const userPrompt = `# Original Task:
${task}

# Current Subtask:
[${currentResult.subtaskId}] Completed by ${currentResult.specialistId}

# Findings Summary:
${findingsSummaryText}

# Current Progress:
Completed: ${delegatedResults.length}/${plan.length} subtasks

**Question**: Should we adapt the plan to address these findings?

If YES, generate specific subtasks based on suggested actions.
If NO, explain why findings don't warrant plan changes.`;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [],
      }
    );

    const content = response.content || '';
    const parsed = this.parseAdaptationDecision(content);

    return parsed;
  }

  /**
   * Parse adaptation decision from LLM response (Phase 2)
   *
   * @param content - LLM response content
   * @returns Parsed adaptation decision
   */
  private parseAdaptationDecision(content: string): AdaptationDecision {
    // Try to extract JSON (similar to parseCompletionCheck)
    const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (typeof parsed.shouldAdapt === 'boolean') {
          return {
            shouldAdapt: parsed.shouldAdapt,
            reason: parsed.reason || 'No reason provided',
            newSubtasks: parsed.newSubtasks || [],
            confidence: parsed.confidence || 0.5,
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse adaptation JSON', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Strategy 2: Find JSON object anywhere
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (typeof parsed.shouldAdapt === 'boolean') {
          return {
            shouldAdapt: parsed.shouldAdapt,
            reason: parsed.reason || 'No reason provided',
            newSubtasks: parsed.newSubtasks || [],
            confidence: parsed.confidence || 0.5,
          };
        }
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse adaptation object', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: conservative - don't adapt
    this.ctx.platform.logger.warn('Failed to parse adaptation decision, assuming no adaptation');
    return {
      shouldAdapt: false,
      reason: 'Failed to parse LLM response',
      newSubtasks: [],
      confidence: 0,
    };
  }
}
