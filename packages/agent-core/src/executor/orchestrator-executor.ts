/**
 * Orchestrator Executor (V2 Architecture)
 *
 * Smart orchestrator that:
 * - Breaks complex tasks into subtasks
 * - Delegates subtasks to specialists
 * - Synthesizes results into coherent answer
 * - Uses LARGE tier LLM for planning/synthesis (specialists use small tier)
 *
 * Phase 2: Adaptive Feedback Loop
 * - Analyzes specialist findings
 * - Adapts execution plan dynamically
 * - Injects fix/review subtasks when needed
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM, useAnalytics, useCache, findRepoRoot } from '@kb-labs/sdk';
import type {
  SpecialistConfigV1,
  ExecutionContext,
  LLMTier,
  OrchestratorCallbacks,
} from '@kb-labs/agent-contracts';
import { SpecialistExecutor, type SpecialistContext } from './specialist-executor.js';
import { SpecialistRegistry } from '../registry/specialist-registry.js';
import { ToolDiscoverer } from '../tools/tool-discoverer.js';
import { OrchestratorAnalytics } from '../analytics/orchestrator-analytics.js';
import { FindingsStore } from './findings-store.js';
import { TaskVerifier } from '../verification/task-verifier.js';
import * as path from 'path';
import {
  createExecutionPlanTool,
  createReviseExecutionPlanTool,
  createEstimateComplexityTool,
  createDelegateSubtaskTool,
  createRequestFeedbackTool,
  createMergeResultsTool,
  createUpdateSubtaskStatusTool,
  createReportProgressTool,
  createIdentifyBlockerTool,
  createValidateOutputTool,
  createRequestRevisionTool,
  createApproveResultTool,
  createShareFindingTool,
  createRequestContextTool,
  createSummarizeLearningsTool,
  type ExecutionPlan,
} from '@kb-labs/agent-tools';
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
  private taskVerifier: TaskVerifier; // ADR-0002: Output verification
  private sessionId: string; // Phase 2: Unique session ID for cleanup
  private callbacks?: OrchestratorCallbacks; // Phase 5: Progress tracking callbacks

  constructor(private ctx: PluginContextV3) {
    this.registry = new SpecialistRegistry(ctx);
    this.toolDiscoverer = new ToolDiscoverer(ctx);
    this.specialistExecutor = new SpecialistExecutor(ctx);
    this.analytics = new OrchestratorAnalytics(useAnalytics());
    this.findingsStore = new FindingsStore(ctx);
    this.taskVerifier = new TaskVerifier(ctx);

    // Generate unique session ID for this orchestrator run
    this.sessionId = `orch-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Get all orchestrator management tools
   *
   * @param specialistIds - Array of valid specialist IDs
   * @returns Array of LLM tools for orchestration
   */
  private getOrchestratorTools(specialistIds: string[]) {
    return {
      // Planning tools
      planning: createExecutionPlanTool(specialistIds),
      revise: createReviseExecutionPlanTool(specialistIds),
      estimateComplexity: createEstimateComplexityTool(),

      // Coordination tools
      delegate: createDelegateSubtaskTool(specialistIds),
      requestFeedback: createRequestFeedbackTool(specialistIds),
      mergeResults: createMergeResultsTool(),

      // Progress tracking tools
      updateStatus: createUpdateSubtaskStatusTool(),
      reportProgress: createReportProgressTool(),
      identifyBlocker: createIdentifyBlockerTool(),

      // Quality control tools
      validateOutput: createValidateOutputTool(),
      requestRevision: createRequestRevisionTool(specialistIds),
      approveResult: createApproveResultTool(),

      // Knowledge sharing tools
      shareFinding: createShareFindingTool(),
      requestContext: createRequestContextTool(),
      summarizeLearnings: createSummarizeLearningsTool(),
    };
  }

  /**
   * Execute a complex task via delegation to specialists
   *
   * Phase 5: Accepts optional callbacks for progress tracking
   *
   * @param task - High-level task description
   * @param callbacks - Optional progress tracking callbacks
   * @returns Orchestration result with synthesized answer
   */
  async execute(task: string, callbacks?: OrchestratorCallbacks): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let totalTokens = 0;
    let plan: SubTask[] = []; // Declare at function scope for error recovery
    let delegatedResults: DelegatedResult[] = []; // Declare at function scope for error recovery

    // Phase 5: Store callbacks for use during execution
    this.callbacks = callbacks;

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

      const planResult = await this.planExecution(task);
      plan = planResult.plan;
      totalTokens += planResult.tokensUsed;

      this.analytics.trackPlanningCompleted(plan, planResult.tokensUsed, Date.now() - planStartTime);
      this.ctx.platform.logger.info('Execution plan created', {
        subtasks: plan.length,
        tokensUsed: planResult.tokensUsed,
      });

      // Phase 5: Notify plan created
      this.callbacks?.onPlanCreated?.({
        subtasks: plan,
      });

      // Step 2: Execute subtasks in order (respecting dependencies)
      this.ctx.platform.logger.info('Executing subtasks...');
      // delegatedResults already declared at function scope for error recovery
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

        // Phase 2: Update status to in-progress
        this.ctx.platform.logger.info('📋 Subtask starting', {
          subtaskId: subtask.id,
          specialist: subtask.specialistId,
          progress: `${delegatedResults.length}/${plan.length}`,
        });

        // Phase 5: Notify subtask start
        this.callbacks?.onSubtaskStart?.(subtask, {
          current: delegatedResults.length + 1,
          total: plan.length,
        });

        // Execute subtask
        this.analytics.trackSpecialistDelegated(subtask);
        const result = await this.delegateTask(subtask, delegatedResults);
        delegatedResults.push(result);
        totalTokens += result.tokensUsed;

        // Phase 2: Update status after completion
        const progressPercent = Math.round((delegatedResults.length / plan.length) * 100);
        this.ctx.platform.logger.info(result.success ? '✅ Subtask completed' : '❌ Subtask failed', {
          subtaskId: subtask.id,
          specialist: subtask.specialistId,
          progress: `${delegatedResults.length}/${plan.length} (${progressPercent}%)`,
          tokensUsed: result.tokensUsed,
        });

        // Track specialist result
        if (result.success) {
          this.analytics.trackSpecialistCompleted(subtask, result);

          // Phase 5: Notify subtask completion
          this.callbacks?.onSubtaskComplete?.(subtask, result, {
            current: delegatedResults.length,
            total: plan.length,
          });

          // Phase 2: Quality validation (optional - can be enabled later)
          // For now, we trust specialist output and check findings only
          // Future: Add LLM-based validation using validateOutput tool

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

              // Phase 5: Notify plan adaptation
              this.callbacks?.onAdaptation?.(
                adaptation.reason,
                adaptation.newSubtasks,
                {
                  current: delegatedResults.length,
                  total: plan.length - adaptation.newSubtasks.length, // Original total before adaptation
                }
              );
            } else if (adaptation.shouldAdapt && adaptation.confidence < 0.7) {
              this.ctx.platform.logger.info('⚠️  Adaptation suggested but low confidence, skipping', {
                confidence: adaptation.confidence,
                reason: adaptation.reason,
              });
            }
          }
        } else {
          this.analytics.trackSpecialistFailed(subtask, result);

          // Phase 5: Notify subtask failure
          this.callbacks?.onSubtaskFailed?.(subtask, result, {
            current: delegatedResults.length,
            total: plan.length,
          });
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

      // Phase 5: Notify completion
      const successfulSubtasks = delegatedResults.filter((r) => r.success).length;
      const failedSubtasks = delegatedResults.filter((r) => !r.success).length;

      this.callbacks?.onComplete?.(answer, {
        totalSubtasks: plan.length,
        successfulSubtasks,
        failedSubtasks,
        totalDurationMs: durationMs,
        totalTokensUsed: totalTokens,
        totalCostUsd: this.analytics.getTotalCost(),
      });

      // Phase 2: Cleanup findings when orchestrator session ends
      await this.cleanupFindings();

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.analytics.trackTaskFailed(task, errorMessage, durationMs, totalTokens);
      this.ctx.platform.logger.error('Orchestrator failed', error instanceof Error ? error : new Error(errorMessage));

      // ADR-0002: Try to recover partial results if specialists completed successfully
      const hasPartialResults = delegatedResults.length > 0;
      let fallbackAnswer = '';

      if (hasPartialResults) {
        this.ctx.platform.logger.warn('Synthesis failed, attempting fallback answer from partial results', {
          completedSubtasks: delegatedResults.length,
          totalSubtasks: plan.length,
        });

        try {
          // Simple fallback: concatenate specialist outputs
          const successfulResults = delegatedResults.filter(r => r.success);
          if (successfulResults.length > 0) {
            fallbackAnswer = '# Partial Results\n\n';
            fallbackAnswer += `**Note**: Full synthesis failed, but ${successfulResults.length} specialist(s) completed successfully.\n\n`;

            for (const result of successfulResults) {
              const subtask = plan.find(s => s.id === result.subtaskId);
              fallbackAnswer += `## ${subtask?.description || result.subtaskId}\n`;
              fallbackAnswer += `**Specialist**: ${result.specialistId}\n\n`;

              if (typeof result.output === 'string') {
                fallbackAnswer += result.output + '\n\n';
              } else if (result.output) {
                fallbackAnswer += '```json\n' + JSON.stringify(result.output, null, 2) + '\n```\n\n';
              }
            }

            this.ctx.platform.logger.info('Generated fallback answer from partial results', {
              answerLength: fallbackAnswer.length,
            });
          }
        } catch (fallbackError) {
          this.ctx.platform.logger.warn('Fallback synthesis also failed', {
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }

      // Phase 2: Cleanup findings even on failure
      await this.cleanupFindings();

      return {
        success: hasPartialResults, // True if at least some specialists completed
        answer: fallbackAnswer || `Error during synthesis: ${errorMessage}`,
        plan,
        delegatedResults,
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
    const llm = useLLM({ tier: 'large' }); // Orchestrator uses large tier
    if (!llm) {
      throw new Error('LLM not available for orchestrator planning');
    }

    // Load available specialists
    const specialists = await this.registry.list();

    // DEBUG: Log discovered specialists
    console.log('\n🔍 DEBUG: Discovered specialists:');
    console.log(`   Total: ${specialists.length}`);
    console.log(`   IDs: ${specialists.map(s => s.id).join(', ') || '(none)'}`);
    specialists.forEach(s => {
      console.log(`   - ${s.id}: valid=${s.valid}, error=${s.error || 'none'}`);
    });

    const specialistIds = specialists.map(s => s.id);
    const specialistDescriptions = specialists
      .map(
        (s) =>
          `- ${s.id}: ${s.description || 'No description'}\n  Capabilities: ${s.capabilities?.join(', ') || 'None'}`
      )
      .join('\n');

    // Get all orchestrator tools
    const tools = this.getOrchestratorTools(specialistIds);
    const planningTool = tools.planning;

    const systemPrompt = `You are an AI orchestrator that plans execution by delegating to specialist team members.

# Available Specialists:
${specialistDescriptions}

# Your Task:
1. Think about the user's request
2. Break it into logical subtasks (2-4 recommended)
3. Call the create_execution_plan tool with your plan

**Important:**
- You MUST call the create_execution_plan tool (it's mandatory)
- Do NOT return text/markdown - call the tool instead
- The tool has JSON schema validation (prevents empty array, invalid IDs, etc.)`;

    const userPrompt = `User task: ${task}\n\nAnalyze this task and create an execution plan by calling the create_execution_plan tool.`;

    console.log('[DEBUG] About to call LLM with planning tool...');
    console.log('[DEBUG] Tool name:', planningTool.name);
    console.log('[DEBUG] Valid specialist IDs:', specialistIds);

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [planningTool],
        toolChoice: { type: 'function', function: { name: 'create_execution_plan' } }, // FORCE tool call
      }
    );

    console.log('[DEBUG] LLM response received');
    console.log('[DEBUG] Tool calls:', response.toolCalls?.length || 0);
    console.log('[DEBUG] Token usage:', response.usage);

    const tokensUsed = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

    // Extract plan from tool call
    if (!response.toolCalls || response.toolCalls.length === 0) {
      throw new Error('LLM did not call create_execution_plan tool');
    }

    const toolCall = response.toolCalls.find(tc => tc.name === 'create_execution_plan');
    if (!toolCall) {
      throw new Error('create_execution_plan tool call not found');
    }

    const executionPlan = toolCall.input as ExecutionPlan;
    const plan = executionPlan.subtasks;

    console.log('[DEBUG] Extracted plan from tool:', JSON.stringify(plan, null, 2));

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
   * Extract output directory from task description (V2)
   *
   * Looks for patterns like:
   * - "output to ./results"
   * - "save in /path/to/output"
   * - "write to directory X"
   *
   * @param taskDescription - Task description
   * @param projectRoot - Project root directory
   * @returns Output directory path or undefined (use projectRoot)
   */
  private extractOutputDir(taskDescription: string, projectRoot: string): string | undefined {
    const patterns = [
      /output\s+(?:to|in|at)\s+([^\s]+)/i,
      /save\s+(?:to|in|at)\s+([^\s]+)/i,
      /write\s+(?:to|in|at)\s+([^\s]+)/i,
      /directory[:\s]+([^\s]+)/i,
    ];

    for (const pattern of patterns) {
      const match = taskDescription.match(pattern);
      if (match && match[1]) {
        // Return extracted path (can be relative or absolute)
        return match[1];
      }
    }

    // No explicit output directory → specialists work in projectRoot
    // Orchestrator can optionally create isolated output dir in Phase 2
    return undefined;
  }

  /**
   * Extract key findings from delegated results (V2)
   *
   * Creates compact summaries from previous specialists:
   * - Max 5 findings per specialist
   * - Focus on actionable/high-severity items
   * - Formatted for context injection
   *
   * @param delegatedResults - Previous specialist results
   * @returns Array of finding summaries
   */
  private async extractFindings(delegatedResults: DelegatedResult[]): Promise<string[]> {
    const findings: string[] = [];

    for (const result of delegatedResults) {
      if (!result.success || !result.findingsRef) {
        continue;
      }

      // Load full findings from store
      const fullFindings = await this.findingsStore.load(result.findingsRef);
      if (!fullFindings || fullFindings.length === 0) {
        continue;
      }

      // Filter to actionable/high-severity (max 5 per specialist)
      const keyFindings = fullFindings
        .filter((f) => f.severity === 'critical' || f.severity === 'high' || f.actionable)
        .slice(0, 5);

      // Format as compact summaries
      for (const finding of keyFindings) {
        const summary = `[${result.specialistId}] ${finding.title}: ${finding.description}`;
        findings.push(summary);
      }
    }

    return findings;
  }

  /**
   * Get project root directory (V2)
   *
   * Searches for:
   * 1. Git root (.git directory)
   * 2. package.json location
   * 3. Falls back to working directory
   *
   * @returns Project root path
   */
  private async getProjectRoot(): Promise<string> {
    const workingDir = process.cwd();

    try {
      // Try to find git root (findRepoRoot is async)
      const gitRoot = await findRepoRoot(workingDir);
      if (gitRoot) {
        return gitRoot;
      }
    } catch {
      // Git root not found, continue
    }

    // Fallback: current working directory
    return workingDir;
  }

  /**
   * Sleep for specified milliseconds (Phase 3: retry backoff)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute specialist with retry logic (Phase 3)
   *
   * Implements exponential backoff retry:
   * - Retry 1: 1s delay
   * - Retry 2: 2s delay
   *
   * Only retries if SpecialistOutcome.failure.suggestedRetry === true
   *
   * @param subtask - Subtask to execute
   * @param delegatedResults - Previously completed results
   * @param maxRetries - Max retry attempts (default: 2)
   * @returns Delegated result
   */
  private async executeWithRetry(
    subtask: SubTask,
    delegatedResults: DelegatedResult[],
    maxRetries = 2
  ): Promise<DelegatedResult> {
    const startTime = Date.now();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.ctx.platform.logger.info('Executing specialist', {
        subtaskId: subtask.id,
        specialist: subtask.specialistId,
        attempt,
        maxRetries,
      });

      try {
        // Load specialist config and tools
        const config = await this.registry.load(subtask.specialistId);
        const tools = await this.toolDiscoverer.discoverWithStrategy(config.tools);
        const context: SpecialistContext = { config, tools };

        // V2: Build ExecutionContext for specialist
        const workingDir = process.cwd();
        const projectRoot = await this.getProjectRoot();
        const outputDir = this.extractOutputDir(subtask.description, projectRoot);
        const findings = await this.extractFindings(
          delegatedResults.filter((r) => subtask.dependencies?.includes(r.subtaskId))
        );

        // Build previousResults map (Phase 5: use DelegatedResult for ExecutionContext)
        const previousResults = new Map<string, DelegatedResult>();
        for (const depId of subtask.dependencies || []) {
          const depResult = delegatedResults.find((r) => r.subtaskId === depId);
          if (depResult && depResult.success) {
            previousResults.set(depId, depResult);
          }
        }

        const availableFiles = { created: [], modified: [] };

        const executionContext: ExecutionContext = {
          workingDir,
          projectRoot,
          outputDir,
          taskDescription: subtask.description,
          subtaskId: subtask.id,
          previousResults,
          findings,
          availableFiles,
        };

        // Execute specialist
        const outcome = await this.specialistExecutor.execute(context, subtask.description, executionContext);

        // Success!
        if (outcome.ok) {
          this.ctx.platform.logger.info('Specialist succeeded', {
            subtaskId: subtask.id,
            attempt,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: outcome.meta.durationMs,
          });

          // Process findings if present
          let findingsSummary: DelegatedResult['findingsSummary'];
          let findingsRef: string | undefined;

          if (outcome.result.output && typeof outcome.result.output === 'object' && 'findings' in outcome.result.output) {
            const findings = (outcome.result.output as { findings: SpecialistFinding[] }).findings;
            if (findings && findings.length > 0) {
              findingsRef = await this.findingsStore.save(this.sessionId, subtask.id, findings);
              findingsSummary = this.findingsStore.createSummary(findings);
            }
          }

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: true,
            output: outcome.result.output,
            tokensUsed: outcome.result.tokensUsed,
            durationMs: Date.now() - startTime,
            traceRef: outcome.result.traceRef,
            findingsSummary,
            findingsRef,
          };
        }

        // Failed - check if should retry
        this.ctx.platform.logger.warn('Specialist failed', {
          subtaskId: subtask.id,
          attempt,
          kind: outcome.failure.kind,
          message: outcome.failure.message,
          hasPartial: !!outcome.partial,
          suggestedRetry: outcome.failure.suggestedRetry,
        });

        // If no retry suggested, return failure immediately
        if (outcome.failure.suggestedRetry === false) {
          this.ctx.platform.logger.info('Retry not recommended, stopping', {
            subtaskId: subtask.id,
            kind: outcome.failure.kind,
          });

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: false,
            output: outcome.partial?.output || null,
            error: outcome.failure.message,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: Date.now() - startTime,
            traceRef: outcome.partial?.traceRef,
          };
        }

        // Last attempt - return failure
        if (attempt === maxRetries) {
          this.ctx.platform.logger.warn('Max retries reached', {
            subtaskId: subtask.id,
            maxRetries,
          });

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: false,
            output: outcome.partial?.output || null,
            error: outcome.failure.message,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: Date.now() - startTime,
            traceRef: outcome.partial?.traceRef,
          };
        }

        // Exponential backoff before retry
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        this.ctx.platform.logger.info('Retrying after backoff', {
          subtaskId: subtask.id,
          backoffMs,
          nextAttempt: attempt + 1,
        });

        await this.sleep(backoffMs);
      } catch (error) {
        // Unexpected error during execution
        const errorMessage = error instanceof Error ? error.message : String(error);

        this.ctx.platform.logger.error('Unexpected error in specialist execution', new Error(
          `[${subtask.specialistId}] ${errorMessage} (attempt ${attempt})`
        ));

        // If last attempt, return error
        if (attempt === maxRetries) {
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

        // Retry after backoff
        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('executeWithRetry: unreachable code');
  }

  /**
   * Execute specialist with escalation and retry (Phase 4)
   *
   * Implements escalation ladder:
   * - Tries each tier in escalationLadder
   * - For each tier, retries up to maxRetries times
   * - Stops at first success or end of ladder
   * - Tracks cost and enforces budget limits
   *
   * @param subtask - Subtask to execute
   * @param delegatedResults - Previously completed results
   * @param maxRetries - Max retries per tier (default: 2)
   * @returns Delegated result
   */
  private async executeWithEscalation(
    subtask: SubTask,
    delegatedResults: DelegatedResult[],
    maxRetries = 2
  ): Promise<DelegatedResult> {
    // Load specialist config to get escalation ladder
    const config = await this.registry.load(subtask.specialistId);
    const ladder: LLMTier[] = config.llm.escalationLadder || [config.llm.tier];

    this.ctx.platform.logger.info('Starting execution with escalation', {
      subtaskId: subtask.id,
      specialistId: subtask.specialistId,
      escalationLadder: ladder,
      maxRetriesPerTier: maxRetries,
    });

    for (let tierIndex = 0; tierIndex < ladder.length; tierIndex++) {
      const tier = ladder[tierIndex]!; // Safe: index is within bounds

      this.ctx.platform.logger.info('Trying tier', {
        subtaskId: subtask.id,
        tier,
        tierIndex: tierIndex + 1,
        totalTiers: ladder.length,
      });

      // Execute with retry for current tier
      const result = await this.executeWithRetryAndTier(
        subtask,
        delegatedResults,
        tier,
        maxRetries
      );

      // Success!
      if (result.success) {
        this.ctx.platform.logger.info('Specialist succeeded with tier', {
          subtaskId: subtask.id,
          tier,
          tierIndex: tierIndex + 1,
        });
        return result;
      }

      // Failed - check if should escalate to next tier
      if (tierIndex < ladder.length - 1) {
        const nextTier = ladder[tierIndex + 1]!; // Safe: checked bounds above
        this.ctx.platform.logger.warn('Escalating to next tier', {
          subtaskId: subtask.id,
          fromTier: tier,
          toTier: nextTier,
          error: result.error,
        });

        this.ctx.platform.analytics.track('orchestrator.escalation', {
          subtaskId: subtask.id,
          specialistId: subtask.specialistId,
          fromTier: tier,
          toTier: nextTier,
          reason: result.error || 'unknown',
        });
      } else {
        // No more tiers to try
        this.ctx.platform.logger.error('All tiers exhausted', new Error(
          `Subtask ${subtask.id} failed even after escalating through all tiers: ${ladder.join(' → ')}`
        ));
        return result;
      }
    }

    // Should never reach here
    throw new Error('executeWithEscalation: unreachable code');
  }

  /**
   * Execute specialist with retry for specific tier (Phase 4)
   *
   * Similar to executeWithRetry but passes tier override to specialist.
   *
   * @param subtask - Subtask to execute
   * @param delegatedResults - Previously completed results
   * @param tier - Model tier to use
   * @param maxRetries - Max retry attempts
   * @returns Delegated result
   */
  private async executeWithRetryAndTier(
    subtask: SubTask,
    delegatedResults: DelegatedResult[],
    tier: LLMTier,
    maxRetries: number
  ): Promise<DelegatedResult> {
    const startTime = Date.now();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.ctx.platform.logger.info('Executing specialist with tier', {
        subtaskId: subtask.id,
        specialist: subtask.specialistId,
        tier,
        attempt,
        maxRetries,
      });

      try {
        // Load specialist config and tools
        const config = await this.registry.load(subtask.specialistId);
        const tools = await this.toolDiscoverer.discoverWithStrategy(config.tools);
        const context: SpecialistContext = { config, tools };

        // V2: Build ExecutionContext for specialist
        const workingDir = process.cwd();
        const projectRoot = await this.getProjectRoot();
        const outputDir = this.extractOutputDir(subtask.description, projectRoot);
        const findings = await this.extractFindings(
          delegatedResults.filter((r) => subtask.dependencies?.includes(r.subtaskId))
        );

        // Build previousResults map (Phase 5: use DelegatedResult for ExecutionContext)
        const previousResults = new Map<string, DelegatedResult>();
        for (const depId of subtask.dependencies || []) {
          const depResult = delegatedResults.find((r) => r.subtaskId === depId);
          if (depResult && depResult.success) {
            previousResults.set(depId, depResult);
          }
        }

        const availableFiles = { created: [], modified: [] };

        const executionContext: ExecutionContext = {
          workingDir,
          projectRoot,
          outputDir,
          taskDescription: subtask.description,
          subtaskId: subtask.id,
          previousResults,
          findings,
          availableFiles,
        };

        // Phase 4: Execute specialist with tier override
        const outcome = await this.specialistExecutor.execute(
          context,
          subtask.description,
          executionContext,
          undefined, // no progress callback
          tier // tier override
        );

        // Phase 4: Track cost
        const cost = this.analytics.trackSpecialistCost(
          tier,
          outcome.meta.tokenUsage.prompt,
          outcome.meta.tokenUsage.completion
        );

        this.ctx.platform.logger.debug('Specialist execution cost', {
          subtaskId: subtask.id,
          tier,
          promptTokens: outcome.meta.tokenUsage.prompt,
          completionTokens: outcome.meta.tokenUsage.completion,
          costUsd: cost.toFixed(6),
          totalCostUsd: this.analytics.getTotalCost().toFixed(6),
        });

        // Success!
        if (outcome.ok) {
          this.ctx.platform.logger.info('Specialist succeeded', {
            subtaskId: subtask.id,
            tier,
            attempt,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: outcome.meta.durationMs,
            costUsd: cost.toFixed(6),
          });

          // Process findings if present
          let findingsSummary: DelegatedResult['findingsSummary'];
          let findingsRef: string | undefined;

          if (outcome.result.output && typeof outcome.result.output === 'object' && 'findings' in outcome.result.output) {
            const findings = (outcome.result.output as { findings: SpecialistFinding[] }).findings;
            if (findings && findings.length > 0) {
              findingsRef = await this.findingsStore.save(this.sessionId, subtask.id, findings);
              findingsSummary = this.findingsStore.createSummary(findings);
            }
          }

          // ADR-0002: Verify specialist output (3-level validation)
          this.ctx.platform.logger.debug('Starting output verification', {
            subtaskId: subtask.id,
            hasOutput: !!outcome.result.output,
            hasTraceRef: !!outcome.result.traceRef,
          });

          const verification = await this.taskVerifier.verify(
            outcome.result.output,
            outcome.result.toolTrace, // For Level 2 validation
            workingDir,
            subtask.specialistId, // For metrics
            subtask.id // For metrics
          );

          if (!verification.valid) {
            // Verification failed - log and return failure (triggers retry)
            this.ctx.platform.logger.warn('Output verification failed', {
              subtaskId: subtask.id,
              tier,
              attempt,
              level: verification.level,
              errors: verification.errors,
            });

            // If last attempt, return final failure
            if (attempt === maxRetries) {
              return {
                subtaskId: subtask.id,
                specialistId: subtask.specialistId,
                success: false,
                output: outcome.result.output,
                error: `Verification failed: ${verification.errors?.join(', ')}`,
                tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
                durationMs: Date.now() - startTime,
                traceRef: outcome.result.traceRef,
              };
            }

            // Retry with exponential backoff
            const backoffMs = 1000 * Math.pow(2, attempt - 1);
            this.ctx.platform.logger.info('Retrying after verification failure', {
              subtaskId: subtask.id,
              tier,
              backoffMs,
              nextAttempt: attempt + 1,
            });

            await this.sleep(backoffMs);
            continue; // Retry the loop
          }

          // Verification passed!
          this.ctx.platform.logger.debug('Output verification passed', {
            subtaskId: subtask.id,
            level: verification.level,
          });

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: true,
            output: outcome.result.output,
            tokensUsed: outcome.result.tokensUsed,
            durationMs: Date.now() - startTime,
            traceRef: outcome.result.traceRef,
            findingsSummary,
            findingsRef,
          };
        }

        // Failed - check if should retry
        this.ctx.platform.logger.warn('Specialist failed', {
          subtaskId: subtask.id,
          tier,
          attempt,
          kind: outcome.failure.kind,
          message: outcome.failure.message,
          hasPartial: !!outcome.partial,
          suggestedRetry: outcome.failure.suggestedRetry,
        });

        // If no retry suggested, return failure immediately
        if (outcome.failure.suggestedRetry === false) {
          this.ctx.platform.logger.info('Retry not recommended, stopping', {
            subtaskId: subtask.id,
            kind: outcome.failure.kind,
          });

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: false,
            output: outcome.partial?.output || null,
            error: outcome.failure.message,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: Date.now() - startTime,
            traceRef: outcome.partial?.traceRef,
          };
        }

        // Last attempt - return failure
        if (attempt === maxRetries) {
          this.ctx.platform.logger.warn('Max retries reached for tier', {
            subtaskId: subtask.id,
            tier,
            maxRetries,
          });

          return {
            subtaskId: subtask.id,
            specialistId: subtask.specialistId,
            success: false,
            output: outcome.partial?.output || null,
            error: outcome.failure.message,
            tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
            durationMs: Date.now() - startTime,
            traceRef: outcome.partial?.traceRef,
          };
        }

        // Exponential backoff before retry
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        this.ctx.platform.logger.info('Retrying after backoff', {
          subtaskId: subtask.id,
          tier,
          backoffMs,
          nextAttempt: attempt + 1,
        });

        await this.sleep(backoffMs);
      } catch (error) {
        // Unexpected error during execution
        const errorMessage = error instanceof Error ? error.message : String(error);

        this.ctx.platform.logger.error('Unexpected error in specialist execution', new Error(
          `[${subtask.specialistId}] Tier: ${tier}, Attempt: ${attempt}, Error: ${errorMessage}`
        ));

        // If last attempt, return error
        if (attempt === maxRetries) {
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

        // Retry after backoff
        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('executeWithRetryAndTier: unreachable code');
  }

  /**
   * Delegate a subtask to a specialist (Phase 4)
   *
   * Simplified wrapper around executeWithEscalation.
   *
   * @param subtask - Subtask to execute
   * @param delegatedResults - Previously completed subtasks
   * @returns Delegated result
   */
  private async delegateTask(subtask: SubTask, delegatedResults: DelegatedResult[]): Promise<DelegatedResult> {
    // Phase 4: Use executeWithEscalation for automatic tier escalation + retry
    return this.executeWithEscalation(subtask, delegatedResults, 2);
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
    const llm = useLLM({ tier: 'large' }); // Orchestrator uses large tier for reasoning
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
    const llm = useLLM({ tier: 'large' }); // Orchestrator uses large tier for reasoning
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
    const llm = useLLM({ tier: 'large' }); // Orchestrator uses large tier for synthesis
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
    const llm = useLLM({ tier: 'large' }); // Orchestrator uses large tier for adaptive planning (Phase 2)
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
**Call revise_execution_plan tool if:**
- Critical or high-severity findings that MUST be addressed
- Findings have clear suggested actions that can be executed
- Findings would block remaining subtasks
- Fixing is straightforward and essential

**Do NOT call tool if:**
- Only informational findings (no action needed)
- Findings are low-priority suggestions
- Remaining plan already covers these concerns
- No clear action can be taken

**If you decide to adapt, call revise_execution_plan with:**
- action: "add" - to add new subtask for fixing issues
- subtask.id: "fix-1", "fix-2", etc. (sequential)
- subtask.description: Specific, actionable description
- subtask.specialistId: Choose from: ${availableSpecialistIds}
- subtask.dependencies: ["${currentResult.subtaskId}"] (new tasks depend on current work)
- subtask.priority: 8-10 for critical fixes, 5-7 for important improvements
- subtask.estimatedComplexity: "low", "medium", or "high"
- reason: Clear explanation of why adaptation is needed

**If you decide NOT to adapt, just respond with text explaining why.**`;

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

    // Get orchestrator tools for plan revision
    const tools = this.getOrchestratorTools(availableSpecialistIds.split(', '));
    const reviseTool = tools.revise;

    const response = await llm.chatWithTools!(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [reviseTool],
        // Don't force tool call - LLM decides if adaptation is needed
      }
    );

    // Check if LLM called revise_execution_plan tool
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // LLM decided no adaptation needed
      return {
        shouldAdapt: false,
        reason: response.content || 'No adaptation recommended by LLM',
        newSubtasks: [],
        confidence: 0.9,
      };
    }

    const toolCall = response.toolCalls.find(tc => tc.name === 'revise_execution_plan');
    if (!toolCall) {
      // LLM called different tool or no revision
      return {
        shouldAdapt: false,
        reason: 'No plan revision tool called',
        newSubtasks: [],
        confidence: 0.8,
      };
    }

    const revision = toolCall.input as { action: string; subtask?: SubTask; subtaskId?: string; reason: string };

    // Handle different revision actions
    if (revision.action === 'add' && revision.subtask) {
      return {
        shouldAdapt: true,
        reason: revision.reason,
        newSubtasks: [revision.subtask],
        confidence: 0.85,
      };
    } else if (revision.action === 'modify' && revision.subtask) {
      // Find and replace existing subtask
      const index = plan.findIndex(s => s.id === revision.subtaskId);
      if (index !== -1) {
        plan[index] = revision.subtask;
      }
      return {
        shouldAdapt: false, // Already modified in-place
        reason: revision.reason,
        newSubtasks: [],
        confidence: 0.85,
      };
    } else {
      return {
        shouldAdapt: false,
        reason: revision.reason,
        newSubtasks: [],
        confidence: 0.8,
      };
    }
  }

  /**
   * Share findings between specialists (Phase 2 - Knowledge Sharing)
   *
   * Allows specialists to communicate important discoveries that might
   * affect other subtasks or the overall execution.
   *
   * @param subtaskId - Subtask where finding was discovered
   * @param specialistId - Specialist who made the discovery
   * @param finding - The finding to share
   */
  private async shareFinding(
    subtaskId: string,
    specialistId: string,
    finding: {
      category: 'bug' | 'optimization' | 'requirement' | 'constraint' | 'insight';
      description: string;
      impact: string;
      affectedSubtasks: string[];
    }
  ): Promise<void> {
    this.ctx.platform.logger.info('🔗 Knowledge sharing: Finding shared', {
      subtaskId,
      specialistId,
      category: finding.category,
      affectedSubtasks: finding.affectedSubtasks.length,
    });

    // Store finding for potential use by other specialists
    // For now, just log it - future: store in FindingsStore or context
    this.ctx.platform.analytics.track('orchestrator.knowledge.shared', {
      subtaskId,
      specialistId,
      category: finding.category,
      impact: finding.impact.length,
      affectedCount: finding.affectedSubtasks.length,
    });
  }

  /**
   * Request context from previous specialist (Phase 2 - Knowledge Sharing)
   *
   * Allows specialist to ask questions about work done by others.
   *
   * @param requesterSubtaskId - Current subtask requesting context
   * @param sourceSubtaskId - Subtask to get context from
   * @param questions - Specific questions to ask
   * @returns Context information (for now, returns previous result summary)
   */
  private async requestContext(
    requesterSubtaskId: string,
    sourceSubtaskId: string,
    questions: string[]
  ): Promise<string> {
    this.ctx.platform.logger.info('🔍 Knowledge sharing: Context requested', {
      requester: requesterSubtaskId,
      source: sourceSubtaskId,
      questionCount: questions.length,
    });

    // Future: Use LLM to answer questions based on previous specialist's work
    // For now, return placeholder
    return `Context from ${sourceSubtaskId}: Previous work completed successfully. ${questions.length} questions noted.`;
  }

}
