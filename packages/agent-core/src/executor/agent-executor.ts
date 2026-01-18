/**
 * Agent Executor
 *
 * Main execution loop for agents - coordinates LLM, tools, and loop detection
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk';
import type {
  AgentContext,
  AgentResult,
  AgentRuntimeState,
  AgentExecutionStep,
  ToolCall,
  ToolDefinition,
  AgentProgressCallback,
} from '@kb-labs/agent-contracts';
import { LoopDetector } from './loop-detector.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { TaskClassifier, type TaskClassification } from '../planning/task-classifier.js';
import { ReActPromptBuilder } from '../planning/react-prompt-builder.js';
import { ReActParser } from './react-parser.js';
import { ContextCompressor, type Message } from './context-compressor.js';
import { ExecutionMemory, type Finding } from './execution-memory.js';
import { ProgressTracker, type ProgressEstimate } from './progress-tracker.js';
import { ErrorRecovery } from './error-recovery.js';
import { parseTerminationSignal, shouldGiveUp } from './termination-parser.js';

/**
 * Agent Executor
 *
 * Implements the main agent execution loop:
 * 1. Send prompt + tools to LLM
 * 2. LLM responds with text and/or tool calls
 * 3. Execute tool calls
 * 4. Check for loops
 * 5. Send tool results back to LLM
 * 6. Repeat until task complete or max steps reached
 */
export class AgentExecutor {
  private loopDetector: LoopDetector;
  private toolExecutor: ToolExecutor;
  private taskClassifier: TaskClassifier;
  private reactPromptBuilder: ReActPromptBuilder;
  private reactParser: ReActParser;
  private contextCompressor: ContextCompressor;
  private executionMemory: ExecutionMemory;
  private progressTracker: ProgressTracker;
  private errorRecovery: ErrorRecovery;

  // Track whether last step was tool execution (for forced reasoning)
  private lastStepWasToolExecution: boolean = false;

  // Track consecutive failures for give-up mechanism
  private consecutiveFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(private ctx: PluginContextV3) {
    this.loopDetector = new LoopDetector();
    // toolExecutor will be initialized in execute() with agent context
    this.toolExecutor = new ToolExecutor(ctx);
    this.taskClassifier = new TaskClassifier();
    this.reactPromptBuilder = new ReActPromptBuilder();
    this.reactParser = new ReActParser();
    this.contextCompressor = new ContextCompressor(ctx);
    this.executionMemory = new ExecutionMemory();
    // Use global LLM via useLLM() composable (accesses platform singleton)
    const llm = useLLM();
    if (!llm) {
      throw new Error('LLM not configured - required for ProgressTracker and ErrorRecovery');
    }
    this.progressTracker = new ProgressTracker(llm);
    this.errorRecovery = new ErrorRecovery(llm);
  }

  /**
   * Execute an agent task
   *
   * @param context - Agent context (config, prompt, tools)
   * @param task - Task description from user
   * @param progressCallback - Optional callback for progress updates
   * @returns Execution result
   */
  async execute(
    context: AgentContext,
    task: string,
    progressCallback?: AgentProgressCallback
  ): Promise<AgentResult> {
    const config = context.config;

    // Initialize tool executor with tools for adaptive input parsing
    this.toolExecutor = new ToolExecutor(this.ctx, { tools: context.tools || [] });

    // Set agent ID for cache key generation
    this.toolExecutor.setAgentId(config.id);

    // Reset forced reasoning flag for new task
    this.lastStepWasToolExecution = false;

    // Reset consecutive failures counter for new task
    this.consecutiveFailures = 0;

    // Initialize runtime state
    const state: AgentRuntimeState = {
      agentId: config.id,
      task,
      tools: context.tools || [],
      currentStep: 0,
      maxSteps: config.llm.maxToolCalls || 10, // Reduced to 10 for testing final step summary
      steps: [],
      tokensUsed: 0,
      startTime: Date.now(),
      loopDetection: {
        stateHashes: [],
        maxHistorySize: 5,
        toolCallSequences: [],
        loopThreshold: 3,
      },
    };

    // PHASE 1: Classify task to determine optimal strategy
    this.ctx.platform.logger.info('Classifying task...', { task });
    const classification = await this.taskClassifier.classify(task, context.tools || []);

    this.ctx.platform.logger.info('Task classified', {
      type: classification.type,
      complexity: classification.complexity,
      strategy: classification.suggestedStrategy,
      estimatedSteps: classification.estimatedSteps,
      reasoning: classification.reasoning,
    });

    // Categorize task for analytics correlation
    const taskCategory = this.categorizeTask(task);
    const taskHash = this.hashTask(task);

    this.ctx.platform.logger.info('Starting agent execution', {
      agentId: config.id,
      model: config.llm.tier,
      task,
      taskCategory,
      taskHash,
      maxSteps: state.maxSteps,
      classificationType: classification.type,
      classificationComplexity: classification.complexity,
    });

    // Track agent execution start
    await this.ctx.platform.analytics.track('agent.execution.started', {
      agentId: config.id,
      model: config.llm.tier,
      taskLength: task.length,
      taskCategory,
      taskHash,
      maxSteps: state.maxSteps,
      toolsAvailable: (context.tools || []).length,
      classificationType: classification.type,
      classificationComplexity: classification.complexity,
      classificationStrategy: classification.suggestedStrategy,
    });

    try {
      // PHASE 2: Clear memory from previous execution
      this.executionMemory.clear();
      // Set task goal for progress tracking
      this.executionMemory.setTaskGoal(task);

      // PHASE 3: Clear progress tracker from previous execution
      this.progressTracker.clear();

      // Initial user message
      let messages: Array<{ role: string; content: string; toolCallId?: string }> = [
        { role: 'user', content: task },
      ];

      // Main execution loop
      while (state.currentStep < state.maxSteps) {
        state.currentStep++;

        this.ctx.platform.logger.debug('Agent step', {
          step: state.currentStep,
          maxSteps: state.maxSteps,
        });

        // Notify step start
        progressCallback?.onStepStart?.(state.currentStep, state.maxSteps);

        // PHASE 3: Build system prompt dynamically on each step
        // When lastStepWasToolExecution=true, exclude tools from prompt (forced reasoning)
        // When lastStepWasToolExecution=false, include tools in prompt (allow tool calls)
        const includeToolsInPrompt = !this.lastStepWasToolExecution;
        const systemPrompt = this.buildReActSystemPrompt(
          context,
          classification,
          includeToolsInPrompt,
          state.currentStep, // Pass current step for completion reminder
          state.maxSteps      // Pass max steps for completion reminder
        );

        console.log('[DYNAMIC PROMPT]', {
          step: state.currentStep,
          lastStepWasToolExecution: this.lastStepWasToolExecution,
          includeToolsInPrompt,
          promptLength: systemPrompt.length,
        });

        // PHASE 1.5: Compress context if needed
        if (this.contextCompressor.shouldCompress(messages as Message[])) {
          this.ctx.platform.logger.info('Context window getting large, compressing...', {
            currentMessages: messages.length,
          });

          const compressionResult = await this.contextCompressor.compress(
            messages as Message[],
            systemPrompt,
            task
          );

          messages = compressionResult.compressedMessages as typeof messages;

          this.ctx.platform.logger.info('Context compressed', {
            savedTokens: compressionResult.originalTokens - compressionResult.compressedTokens,
            compressionRatio: `${(compressionResult.compressionRatio * 100).toFixed(1)}%`,
          });
        }

        // Call LLM with forced reasoning pattern
        // If last step was tool execution, force text-only response to make agent reason
        // ALSO force reasoning on final step to ensure agent provides summary instead of calling tools
        // Otherwise, allow tool calls
        const isFinalStep = !!(state.maxSteps && state.currentStep === state.maxSteps);
        const forceReasoning = this.lastStepWasToolExecution || isFinalStep;

        progressCallback?.onLLMStart?.(state.currentStep);
        const stepStartTime = Date.now();
        const llmResponse = await this.callLLM(
          systemPrompt,
          messages,
          state.tools,
          config.llm,
          forceReasoning // Force reasoning after tool execution OR on final step
        );

        const stepDuration = Date.now() - stepStartTime;
        state.tokensUsed += llmResponse.tokensUsed || 0;

        // Notify LLM complete
        progressCallback?.onLLMComplete?.(
          state.currentStep,
          llmResponse.tokensUsed || 0,
          llmResponse.content
        );

        // Create execution step
        const step: AgentExecutionStep = {
          step: state.currentStep,
          response: llmResponse.content,
          toolCalls: [],
          tokensUsed: llmResponse.tokensUsed,
          durationMs: stepDuration,
        };

        // PHASE 1: Hybrid approach - parse ReAct text if native calling didn't work
        let toolCallsToExecute = llmResponse.toolCalls || [];

        if (toolCallsToExecute.length === 0 && this.reactParser.hasReActPattern(llmResponse.content)) {
          // LLM wrote ReAct format but didn't trigger native calling
          // Parse text and extract tool call
          this.ctx.platform.logger.info('Detected ReAct pattern in text, parsing tool call', {
            step: state.currentStep,
          });

          const parsedToolCall = this.reactParser.parse(llmResponse.content);
          const toolCall = this.reactParser.toToolCall(parsedToolCall);

          if (toolCall) {
            this.ctx.platform.logger.info('Extracted tool call from ReAct text', {
              tool: toolCall.name,
              input: toolCall.input,
            });
            toolCallsToExecute = [toolCall];
          }
        }

        // Check if LLM wants to use tools (native or parsed)
        if (toolCallsToExecute.length > 0) {
          this.ctx.platform.logger.debug('LLM requested tools', {
            count: toolCallsToExecute.length,
            tools: toolCallsToExecute.map((tc) => tc.name),
          });

          // Execute tool calls and build tool ID mapping
          const toolCallIdMap = new Map<string, string>(); // name -> id

          for (const toolCall of toolCallsToExecute) {
            // Save tool call ID for native tool message format (use name as fallback)
            toolCallIdMap.set(toolCall.name, toolCall.id || toolCall.name);

            this.ctx.platform.logger.debug('Executing tool', {
              tool: toolCall.name,
              input: toolCall.input,
            });

            // Notify tool start
            progressCallback?.onToolStart?.(toolCall.name, toolCall.input, state.currentStep);

            const toolStartTime = Date.now();
            const result = await this.toolExecutor.execute(toolCall);
            const toolDuration = Date.now() - toolStartTime;

            this.ctx.platform.logger.debug('Tool execution completed', {
              tool: toolCall.name,
              success: result.success,
              durationMs: toolDuration,
            });

            // Notify tool complete
            progressCallback?.onToolComplete?.(
              toolCall.name,
              result.success,
              result.output,
              result.error?.message,
              toolDuration
            );

            // Track tool usage
            await this.ctx.platform.analytics.track('agent.tool.executed', {
              agentId: config.id,
              tool: toolCall.name,
              success: result.success,
              durationMs: toolDuration,
              step: state.currentStep,
            });

            step.toolCalls?.push({
              name: toolCall.name,
              input: toolCall.input,
              output: result.output || '',
              success: result.success,
              error: result.error?.message,
            });

            // Track failures for give-up mechanism
            if (!result.success) {
              this.consecutiveFailures++;
              console.log('[FAILURE TRACKING]', {
                consecutiveFailures: this.consecutiveFailures,
                maxAllowed: this.MAX_CONSECUTIVE_FAILURES,
                tool: toolCall.name,
              });

              // Check if should give up
              if (shouldGiveUp(this.consecutiveFailures, this.MAX_CONSECUTIVE_FAILURES)) {
                console.log('[FAILURE TRACKING] Max consecutive failures reached → forcing give-up');
                // Will be handled in reasoning step
              }
            } else {
              // Reset failure counter on success
              if (this.consecutiveFailures > 0) {
                console.log('[FAILURE TRACKING] Tool succeeded → resetting counter');
                this.consecutiveFailures = 0;
              }
            }
          }

          // Add tool results to message history
          const llm = this.ctx.platform.llm;

          // Use native tool message format if supported
          if (llm.chatWithTools && llmResponse.toolCalls) {
            // Native tool calling: add tool role messages
            messages.push({
              role: 'assistant',
              content: llmResponse.content || '',
            });

            // Add each tool result as a separate 'tool' message
            for (const toolCall of step.toolCalls || []) {
              messages.push({
                role: 'tool',
                content: toolCall.success
                  ? (toolCall.output || '')
                  : `Error: ${toolCall.error || 'Unknown error'}`,
                toolCallId: toolCallIdMap.get(toolCall.name),
              });
            }
          } else {
            // Text-based fallback: format as user message
            const toolResultsMessage = this.formatToolResults(step.toolCalls || []);
            messages.push({
              role: 'assistant',
              content: llmResponse.content || 'Using tools...',
            });
            messages.push({
              role: 'user',
              content: toolResultsMessage,
            });
          }

          // Mark that tools were executed - next step should force reasoning
          this.lastStepWasToolExecution = true;
          console.log('[FORCED REASONING] Tools executed, setting flag to TRUE → next step will be reasoning-only');

          // Notify step complete (with tools)
          progressCallback?.onStepComplete?.(
            state.currentStep,
            state.tokensUsed,
            step.toolCalls?.length || 0
          );
        } else {
          // No tools requested - could be reasoning step OR final answer

          // Check if this was a forced reasoning step (after tool execution)
          const wasReasoningStep = this.lastStepWasToolExecution;

          // Reset flag for next iteration
          this.lastStepWasToolExecution = false;

          if (wasReasoningStep) {
            // This was a reasoning step - agent is reflecting on tool results
            // Continue loop to allow agent to take action on next step
            console.log('[FORCED REASONING] Reasoning step complete, setting flag to FALSE → next step can use tools');
            console.log('[FORCED REASONING] Continuing loop to allow agent to act on reflection...');

            state.steps.push(step);

            // Notify step complete (reasoning)
            progressCallback?.onStepComplete?.(state.currentStep, state.tokensUsed, 0);

            // Add reasoning to message history as assistant response
            messages.push({
              role: 'assistant',
              content: llmResponse.content,
            });

            // Continue loop - don't return yet
          } else {
            // No tools AND wasn't a reasoning step - check for termination signals
            console.log('[FORCED REASONING] No tools and not reasoning step → checking for termination signals');

            // Parse response for termination markers
            const terminationSignal = parseTerminationSignal(llmResponse.content || '');

            if (terminationSignal.type !== 'none') {
              console.log('[TERMINATION]', {
                type: terminationSignal.type,
                reason: 'reason' in terminationSignal ? terminationSignal.reason : undefined,
              });

              state.steps.push(step);

              // Notify step complete
              progressCallback?.onStepComplete?.(state.currentStep, state.tokensUsed, 0);

              const durationMs = Date.now() - state.startTime;
              const toolStats = this.collectToolStats(state.steps);

              // Handle different termination types
              if (terminationSignal.type === 'task_complete') {
                this.ctx.platform.logger.info('Agent task completed successfully', {
                  model: config.llm.tier,
                  steps: state.currentStep,
                  tokensUsed: state.tokensUsed,
                  durationMs,
                });

                await this.ctx.platform.analytics.track('agent.execution.completed', {
                  agentId: config.id,
                  model: config.llm.tier,
                  success: true,
                  taskCategory,
                  taskHash,
                  steps: state.currentStep,
                  tokensUsed: state.tokensUsed,
                  durationMs,
                  toolsUsed: toolStats.totalCalls,
                  uniqueTools: toolStats.uniqueTools,
                  toolStats: toolStats.byTool,
                  terminationType: 'task_complete',
                });

                return {
                  success: true,
                  result: terminationSignal.response,
                  steps: state.steps,
                  totalTokens: state.tokensUsed,
                  durationMs,
                };
              } else if (terminationSignal.type === 'need_escalation') {
                this.ctx.platform.logger.warn('Agent needs escalation', {
                  reason: terminationSignal.reason,
                  steps: state.currentStep,
                });

                await this.ctx.platform.analytics.track('agent.execution.escalation', {
                  agentId: config.id,
                  reason: terminationSignal.reason,
                  steps: state.currentStep,
                  tokensUsed: state.tokensUsed,
                  durationMs,
                });

                return {
                  success: false,
                  result: terminationSignal.response,
                  error: {
                    code: 'ESCALATION_REQUIRED',
                    message: `Agent needs escalation: ${terminationSignal.reason}`,
                  },
                  steps: state.steps,
                  totalTokens: state.tokensUsed,
                  durationMs,
                };
              } else if (terminationSignal.type === 'give_up') {
                this.ctx.platform.logger.warn('Agent gave up', {
                  reason: terminationSignal.reason,
                  steps: state.currentStep,
                });

                await this.ctx.platform.analytics.track('agent.execution.give_up', {
                  agentId: config.id,
                  reason: terminationSignal.reason,
                  steps: state.currentStep,
                  tokensUsed: state.tokensUsed,
                  durationMs,
                });

                return {
                  success: false,
                  result: terminationSignal.response,
                  error: {
                    code: 'GIVE_UP',
                    message: `Agent gave up: ${terminationSignal.reason}`,
                  },
                  steps: state.steps,
                  totalTokens: state.tokensUsed,
                  durationMs,
                };
              }
            }

            // No termination marker - agent completed task implicitly
            console.log('[FORCED REASONING] No termination marker found → implicit task completion');

            state.steps.push(step);

            // Notify step complete (no tools)
            progressCallback?.onStepComplete?.(state.currentStep, state.tokensUsed, 0);

            const durationMs = Date.now() - state.startTime;
            const toolStats = this.collectToolStats(state.steps);

            this.ctx.platform.logger.info('Agent execution completed (implicit)', {
              model: config.llm.tier,
              steps: state.currentStep,
              tokensUsed: state.tokensUsed,
              durationMs,
              toolStats,
            });

            // Track successful completion
            await this.ctx.platform.analytics.track('agent.execution.completed', {
              agentId: config.id,
              model: config.llm.tier,
              success: true,
              taskCategory,
              taskHash,
              steps: state.currentStep,
              tokensUsed: state.tokensUsed,
              durationMs,
              toolsUsed: toolStats.totalCalls,
              uniqueTools: toolStats.uniqueTools,
              toolStats: toolStats.byTool,
            });

            const result: AgentResult = {
              success: true,
              result: llmResponse.content,
              steps: state.steps,
              totalTokens: state.tokensUsed,
              durationMs,
            };

            // Notify completion
            progressCallback?.onComplete?.(result);

            return result;
          }
        }

        // PHASE 2: Extract findings from this step to memory
        // (Step already added to state.steps in the if/else blocks above)
        this.executionMemory.extractFromStep(step);

        // PHASE 3: Estimate progress toward goal
        const progressEstimate = await this.progressTracker.estimateProgress(
          this.executionMemory,
          task,
          step
        );

        this.ctx.platform.logger.info('Progress estimate', {
          step: state.currentStep,
          progressPercent: progressEstimate.progressPercent,
          nextMilestone: progressEstimate.nextMilestone,
          isStuck: progressEstimate.isStuck,
          blockers: progressEstimate.blockers,
        });

        // PHASE 3: Check if agent is stuck
        if (progressEstimate.isStuck) {
          this.ctx.platform.logger.warn('Agent appears stuck (no progress)', {
            step: state.currentStep,
            progressPercent: progressEstimate.progressPercent,
            reasoning: progressEstimate.reasoning,
            blockers: progressEstimate.blockers,
          });

          // PHASE 4: Attempt error recovery
          if (this.errorRecovery.shouldAttemptRecovery(progressEstimate, this.executionMemory)) {
            this.ctx.platform.logger.info('Attempting error recovery...', {
              blockers: progressEstimate.blockers,
              progressPercent: progressEstimate.progressPercent,
            });

            const recoveryAction = await this.errorRecovery.generateRecoveryAction(
              progressEstimate,
              this.executionMemory,
              step
            );

            this.ctx.platform.logger.info('Recovery strategy generated', {
              strategy: recoveryAction.strategy,
              reasoning: recoveryAction.reasoning,
              confidence: recoveryAction.confidence,
            });

            // Execute recovery based on strategy
            if (recoveryAction.strategy === 'give-up') {
              this.ctx.platform.logger.warn('Recovery strategy: give up', {
                reasoning: recoveryAction.reasoning,
              });
              // Continue to next step (will likely hit max steps soon)
            } else if (recoveryAction.strategy === 'escalate') {
              this.ctx.platform.logger.warn('Recovery strategy: escalate to user', {
                message: recoveryAction.action.escalationMessage,
              });
              // Log escalation message for user (Phase 5 will add interactive escalation)
            } else {
              // Strategies: retry, alternative-tool, parameter-adjustment
              this.ctx.platform.logger.info('Recovery strategy: attempting alternative approach', {
                strategy: recoveryAction.strategy,
                toolName: recoveryAction.action.toolName,
              });

              // Record the recovery attempt
              this.errorRecovery.recordAttempt(recoveryAction.action.toolName);

              // For now, log the suggested recovery (Phase 5 will execute it)
              // This provides observability without risking breaking changes
              this.ctx.platform.logger.info('Suggested recovery action', {
                action: recoveryAction.action,
                expectedOutcome: recoveryAction.expectedOutcome,
              });
            }
          }
        }

        // Check for loops
        const loopResult = this.loopDetector.checkForLoop(state.steps);
        if (loopResult.detected) {
          this.ctx.platform.logger.warn('Loop detected', {
            type: loopResult.type,
            description: loopResult.description,
            confidence: loopResult.confidence,
          });

          // PHASE 4: Attempt error recovery for loop detection
          // Treat loop detection as a stuck condition
          const loopDescription = loopResult.description || 'Unknown loop pattern';
          const existingBlockers = progressEstimate.blockers || [];
          const loopBlockers: string[] = [...existingBlockers, loopDescription];
          const loopProgressEstimate: ProgressEstimate = {
            progressPercent: progressEstimate.progressPercent,
            reasoning: `Loop detected: ${loopDescription}`,
            nextMilestone: progressEstimate.nextMilestone || 'Break the loop',
            blockers: loopBlockers,
            isStuck: true, // Force stuck state
          };

          if (this.errorRecovery.shouldAttemptRecovery(loopProgressEstimate, this.executionMemory)) {
            console.log('[PHASE 4] Attempting error recovery for loop:', {
              loopType: loopResult.type,
              blockers: loopProgressEstimate.blockers,
            });
            this.ctx.platform.logger.info('Attempting error recovery for loop...', {
              loopType: loopResult.type,
              blockers: loopProgressEstimate.blockers,
            });

            const recoveryAction = await this.errorRecovery.generateRecoveryAction(
              loopProgressEstimate,
              this.executionMemory,
              step
            );

            console.log('[PHASE 4] Recovery strategy generated:', {
              strategy: recoveryAction.strategy,
              reasoning: recoveryAction.reasoning,
              confidence: recoveryAction.confidence,
            });
            this.ctx.platform.logger.info('Recovery strategy generated for loop', {
              strategy: recoveryAction.strategy,
              reasoning: recoveryAction.reasoning,
              confidence: recoveryAction.confidence,
            });

            // For Phase 4, we just log recovery strategies (observability-first)
            // Phase 5 will actually execute them
            if (recoveryAction.strategy !== 'give-up' && recoveryAction.strategy !== 'escalate') {
              this.ctx.platform.logger.info('Suggested recovery for loop', {
                action: recoveryAction.action,
                expectedOutcome: recoveryAction.expectedOutcome,
              });
            }
          }

          // After recovery logging, still fail execution (Phase 5 will break the loop)
          const durationMs = Date.now() - state.startTime;
          const toolStats = this.collectToolStats(state.steps);

          // Track loop detection
          await this.ctx.platform.analytics.track('agent.execution.completed', {
            agentId: config.id,
            model: config.llm.tier,
            success: false,
            taskCategory,
            taskHash,
            errorCode: 'LOOP_DETECTED',
            steps: state.currentStep,
            tokensUsed: state.tokensUsed,
            durationMs,
            toolsUsed: toolStats.totalCalls,
            uniqueTools: toolStats.uniqueTools,
            toolStats: toolStats.byTool,
          });

          const loopResult_final: AgentResult = {
            success: false,
            error: {
              code: 'LOOP_DETECTED',
              message: `Agent got stuck in a loop: ${loopResult.description}`,
            },
            steps: state.steps,
            totalTokens: state.tokensUsed,
            durationMs,
          };

          // Notify completion
          progressCallback?.onComplete?.(loopResult_final);

          return loopResult_final;
        }
      }

      // Reached max steps - check if LLM provided a termination marker
      const lastStep = state.steps[state.steps.length - 1];
      const lastResponse = lastStep?.response || '';

      // Check if LLM used a termination marker
      const terminationSignal = parseTerminationSignal(lastResponse);

      console.log('[MAX_STEPS_REACHED] Checking final step for termination marker', {
        hasTerminationMarker: terminationSignal.type !== 'none',
        terminationType: terminationSignal.type,
        stepCount: state.steps.length,
      });

      // If no termination marker found, auto-insert [NEED_ESCALATION] with summary
      if (terminationSignal.type === 'none') {
        console.log('[MAX_STEPS_REACHED] No termination marker found → auto-inserting [NEED_ESCALATION]');

        // Generate summary from ExecutionMemory
        const memorySummary = this.executionMemory.getSummary();

        // Build escalation message with summary
        let escalationMessage = '[NEED_ESCALATION: ran out of steps]\n\n';
        escalationMessage += 'I reached the maximum number of steps without completing the task. Here\'s what I investigated:\n\n';

        // Files read
        if (memorySummary.byCategory.filesRead.length > 0) {
          escalationMessage += '**Files I read:**\n';
          memorySummary.byCategory.filesRead.slice(0, 10).forEach((finding: Finding) => {
            escalationMessage += `- ${finding.filePath || 'unknown'}\n`;
          });
          if (memorySummary.byCategory.filesRead.length > 10) {
            escalationMessage += `- ... and ${memorySummary.byCategory.filesRead.length - 10} more files\n`;
          }
          escalationMessage += '\n';
        }

        // Key findings from search results
        if (memorySummary.byCategory.searchResults.length > 0) {
          escalationMessage += '**What I learned:**\n';
          memorySummary.byCategory.searchResults.slice(0, 5).forEach((finding: Finding) => {
            escalationMessage += `- ${finding.fact}\n`;
          });
          escalationMessage += '\n';
        } else if (memorySummary.byCategory.otherFindings.length > 0) {
          // Fallback to other findings if no search results
          escalationMessage += '**What I learned:**\n';
          memorySummary.byCategory.otherFindings.slice(0, 5).forEach((finding: Finding) => {
            escalationMessage += `- ${finding.fact}\n`;
          });
          escalationMessage += '\n';
        }

        // What's missing
        escalationMessage += '**What\'s still unclear:**\n';
        escalationMessage += `- The task required more investigation than ${state.maxSteps} steps allowed\n`;
        escalationMessage += '- I may need more specific guidance on what aspect to focus on\n\n';

        // Suggested next steps
        escalationMessage += '**Suggested next steps:**\n';
        escalationMessage += '1. Review the files I read above to understand what I learned\n';
        escalationMessage += '2. Provide more specific questions if needed\n';
        escalationMessage += '3. Consider increasing maxSteps for complex analysis tasks\n';

        // Update last step response with auto-generated escalation
        if (lastStep) {
          lastStep.response = escalationMessage;
          console.log('[MAX_STEPS_REACHED] Updated last step response with auto-generated summary');
        }

        // Now re-parse to get the escalation signal
        const autoEscalationSignal = parseTerminationSignal(escalationMessage);

        // Return as escalation (not error)
        const durationMs = Date.now() - state.startTime;
        const toolStats = this.collectToolStats(state.steps);

        this.ctx.platform.logger.warn('Agent needs escalation (auto-generated)', {
          reason: 'ran out of steps',
          steps: state.currentStep,
          filesRead: memorySummary.byCategory.filesRead.length,
        });

        await this.ctx.platform.analytics.track('agent.execution.escalation', {
          agentId: config.id,
          reason: 'ran out of steps (auto-generated)',
          steps: state.currentStep,
          tokensUsed: state.tokensUsed,
          durationMs,
          autoGenerated: true,
        });

        const escalationResult: AgentResult = {
          success: false,
          error: {
            code: 'NEED_ESCALATION',
            message: autoEscalationSignal.type === 'need_escalation'
              ? autoEscalationSignal.reason
              : 'ran out of steps',
          },
          result: escalationMessage,
          steps: state.steps,
          totalTokens: state.tokensUsed,
          durationMs,
        };

        progressCallback?.onComplete?.(escalationResult);
        return escalationResult;
      }

      // LLM provided termination marker - return appropriate error code
      const durationMs = Date.now() - state.startTime;
      const toolStats = this.collectToolStats(state.steps);

      // Determine error code based on termination signal type
      const errorCode = terminationSignal.type === 'need_escalation'
        ? 'NEED_ESCALATION'
        : terminationSignal.type === 'give_up'
        ? 'TASK_FAILED'
        : 'MAX_STEPS_REACHED';

      this.ctx.platform.logger.warn('Agent reached max steps with termination marker', {
        maxSteps: state.maxSteps,
        tokensUsed: state.tokensUsed,
        terminationType: terminationSignal.type,
        errorCode,
      });

      // Track completion
      await this.ctx.platform.analytics.track('agent.execution.completed', {
        agentId: config.id,
        model: config.llm.tier,
        success: false,
        taskCategory,
        taskHash,
        errorCode,
        steps: state.currentStep,
        tokensUsed: state.tokensUsed,
        durationMs,
        toolsUsed: toolStats.totalCalls,
        uniqueTools: toolStats.uniqueTools,
        toolStats: toolStats.byTool,
        hadTerminationMarker: true,
      });

      const result: AgentResult = {
        success: false,
        error: {
          code: errorCode,
          message:
            terminationSignal.type !== 'task_complete' && terminationSignal.reason
              ? terminationSignal.reason
              : `Agent reached maximum steps (${state.maxSteps})`,
        },
        result: lastResponse, // Include the LLM's response with termination marker
        steps: state.steps,
        totalTokens: state.tokensUsed,
        durationMs,
      };

      // Notify completion
      progressCallback?.onComplete?.(result);

      return result;
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      const durationMs = Date.now() - state.startTime;
      const toolStats = this.collectToolStats(state.steps);

      this.ctx.platform.logger.error('Agent execution failed', errorObj);

      // Track execution error
      await this.ctx.platform.analytics.track('agent.execution.completed', {
        agentId: config.id,
        model: config.llm.tier,
        success: false,
        taskCategory,
        taskHash,
        errorCode: 'EXECUTION_ERROR',
        errorMessage: errorObj.message,
        steps: state.currentStep,
        tokensUsed: state.tokensUsed,
        durationMs,
        toolsUsed: toolStats.totalCalls,
        uniqueTools: toolStats.uniqueTools,
        toolStats: toolStats.byTool,
      });

      const errorResult: AgentResult = {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: errorObj.message,
          stack: errorObj.stack,
        },
        steps: state.steps,
        totalTokens: state.tokensUsed,
        durationMs,
      };

      // Notify completion
      progressCallback?.onComplete?.(errorResult);

      return errorResult;
    }
  }

  /**
   * Build ReAct system prompt with task classification
   * (PHASE 1: Tool-first thinking)
   * (PHASE 2: Memory-aware prompting)
   * (PHASE 3: Forced reasoning - conditionally include/exclude tools)
   */
  private buildReActSystemPrompt(
    context: AgentContext,
    classification: TaskClassification,
    includeTools: boolean = true,
    currentStep?: number,
    maxSteps?: number
  ): string {
    // Start with agent's base system prompt (if any)
    const basePrompt = this.buildSystemPrompt(context);

    // PHASE 2: Get memory summary
    const memorySummary = this.executionMemory.getSummary();

    // PHASE 3: Build ReAct pattern prompt with conditional tools
    // When includeTools=false, prompt won't mention tools at all (forced reasoning)
    const reactPrompt = this.reactPromptBuilder.build(
      classification,
      context.tools || [],
      basePrompt,
      includeTools // NEW: Pass flag to conditionally include/exclude tools
    );

    // PHASE 2: Inject memory if we have findings
    let finalPrompt = reactPrompt;

    if (memorySummary.count > 0) {
      finalPrompt += '\n\n# Execution Memory\n\n' + memorySummary.formattedText;
    }

    // FINAL STEP LOGIC: Force summary if this is the last step
    if (currentStep && maxSteps && currentStep === maxSteps) {
      console.log('[FINAL STEP] 🚨 SUMMARY PROMPT INJECTED', {
        currentStep,
        maxSteps,
        promptLengthBefore: finalPrompt.length,
      });

      finalPrompt += `\n\n# 🚨 FINAL STEP - PROVIDE SUMMARY\n\n`;
      finalPrompt += `**This is your LAST step (${currentStep}/${maxSteps}).**\n\n`;
      finalPrompt += `You MUST provide a summary of your work using one of these markers:\n\n`;

      finalPrompt += `**Option 1: If you CAN answer the question** (even partially):\n`;
      finalPrompt += `\`\`\`\n`;
      finalPrompt += `[TASK_COMPLETE]\n`;
      finalPrompt += `Based on my investigation, here's what I found:\n`;
      finalPrompt += `[Your answer based on the files you read and what you learned]\n`;
      finalPrompt += `\`\`\`\n\n`;

      finalPrompt += `**Option 2: If you CANNOT complete the task:**\n`;
      finalPrompt += `\`\`\`\n`;
      finalPrompt += `[NEED_ESCALATION: ran out of steps]\n`;
      finalPrompt += `I investigated the following:\n`;
      finalPrompt += `- Files read: [list key files]\n`;
      finalPrompt += `- What I learned: [key findings]\n`;
      finalPrompt += `- What's still missing: [what you couldn't figure out]\n`;
      finalPrompt += `- Suggested next steps: [what should be done next]\n`;
      finalPrompt += `\`\`\`\n\n`;

      finalPrompt += `**Files you've read so far:**\n`;
      if (memorySummary.byCategory.filesRead.length > 0) {
        finalPrompt += `${memorySummary.byCategory.filesRead.map((f: Finding) => `- ${f.filePath || 'unknown'}`).join('\n')}\n\n`;
      } else {
        finalPrompt += `(None yet)\n\n`;
      }

      finalPrompt += `**DO NOT call any more tools** - this is the final step. Just provide your summary.\n`;
    }
    // Add completion reminder in reasoning mode when approaching deadline (but not final step)
    else if (!includeTools && currentStep && maxSteps) {
      const stepsRemaining = maxSteps - currentStep;
      const filesReadCount = memorySummary.byCategory.filesRead.length;

      // Inject reminder if:
      // - More than 2 files read (gathered substantial info)
      // - Less than 5 steps remaining (approaching deadline)
      if (filesReadCount >= 2 && stepsRemaining <= 5) {
        finalPrompt += `\n\n# ⏰ Completion Reminder\n\n`;
        finalPrompt += `**You have ${stepsRemaining} steps remaining** (Step ${currentStep}/${maxSteps}).\n\n`;
        finalPrompt += `**Files you've already read:** ${filesReadCount} files\n`;
        if (memorySummary.byCategory.filesRead.length > 0) {
          finalPrompt += `- ${memorySummary.byCategory.filesRead.map((f: Finding) => f.filePath || 'unknown').join('\n- ')}\n`;
        }
        finalPrompt += `\n**❓ Critical question:** Do you already have enough information to answer the user's question?\n\n`;
        finalPrompt += `✅ **If YES** → Use [TASK_COMPLETE] now with your answer based on what you've learned\n`;
        finalPrompt += `❌ **If NO** → Explain what specific information is still missing and plan your next tool call\n\n`;
        finalPrompt += `⚠️ **Don't waste steps re-reading files you've already read!** Use the Execution Memory above.\n`;
      }
    }

    // Add failure tracking info if in reasoning mode and have consecutive failures
    if (!includeTools && this.consecutiveFailures > 0) {
      finalPrompt += `\n\n# Failure Alert\n\n`;
      finalPrompt += `⚠️ **${this.consecutiveFailures} consecutive tool failures detected.**\n`;

      if (shouldGiveUp(this.consecutiveFailures, this.MAX_CONSECUTIVE_FAILURES)) {
        finalPrompt += `\n❌ **CRITICAL: You have reached the maximum allowed failures (${this.MAX_CONSECUTIVE_FAILURES}).**\n`;
        finalPrompt += `\nYou should strongly consider using [GIVE_UP: reason] if you cannot find a working approach.\n`;
        finalPrompt += `\nExplain what you tried and why it didn't work, then use [GIVE_UP: brief reason].\n`;
      } else {
        finalPrompt += `\n💡 **Suggestion**: Review what's failing and try a different approach in your next action.\n`;
        finalPrompt += `\nIf the next tool call also fails, consider using [GIVE_UP: reason] or [NEED_ESCALATION: reason].\n`;
      }
    }

    return finalPrompt;
  }

  /**
   * Build system prompt from agent context (legacy)
   */
  private buildSystemPrompt(context: AgentContext): string {
    let prompt = '';

    // Add system prompt from file
    if (context.systemPrompt) {
      prompt += context.systemPrompt + '\n\n';
    }

    // Add examples if available
    if (context.examples) {
      prompt += '## Examples\n\n';
      prompt += context.examples + '\n\n';
    }

    // Add context files if available
    if (context.contextFiles && context.contextFiles.length > 0) {
      prompt += '## Context Files\n\n';
      for (const file of context.contextFiles) {
        prompt += `### ${file.path}\n\n`;
        prompt += '```\n';
        prompt += file.content + '\n';
        prompt += '```\n\n';
      }
    }

    return prompt;
  }

  /**
   * Call LLM with current state
   *
   * Supports both native tool calling (OpenAI function calling, Claude tool use)
   * and fallback to text-based tool prompting for adapters without native support.
   *
   * @param forceReasoning - If true, sets tool_choice to "none" to force text-only response
   */
  private async callLLM(
    systemPrompt: string,
    messages: Array<{ role: string; content: string; toolCallId?: string }>,
    tools: ToolDefinition[],
    llmConfig: { temperature?: number; maxTokens?: number },
    forceReasoning: boolean = false
  ): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    tokensUsed?: number;
  }> {
    const llm = useLLM();

    if (!llm) {
      throw new Error('LLM adapter not available');
    }

    // Check if LLM supports native tool calling
    if (llm.chatWithTools && tools.length > 0) {
      return this.callLLMWithNativeTools(systemPrompt, messages, tools, llmConfig, forceReasoning);
    }

    // Fallback to text-based tool prompting
    return this.callLLMWithTextTools(systemPrompt, messages, tools, llmConfig);
  }

  /**
   * Call LLM using native tool calling API (preferred)
   */
  private async callLLMWithNativeTools(
    systemPrompt: string,
    messages: Array<{ role: string; content: string; toolCallId?: string }>,
    tools: ToolDefinition[],
    llmConfig: { temperature?: number; maxTokens?: number },
    forceReasoning: boolean = false
  ): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    tokensUsed?: number;
  }> {
    const llm = useLLM();

    if (!llm) {
      throw new Error('LLM adapter not available');
    }

    // Convert to LLMMessage format
    const llmMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content: msg.content,
        toolCallId: msg.toolCallId,
      })),
    ];

    // Convert to LLMTool format
    // OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$ (no colons allowed)
    // Create mapping: original name -> sanitized name
    const nameMap = new Map<string, string>();
    const llmTools = tools.map((tool) => {
      const sanitizedName = tool.name.replace(/:/g, '_');
      nameMap.set(sanitizedName, tool.name); // Store mapping for reverse lookup
      return {
        name: sanitizedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });

    // FORCED REASONING PATTERN:
    // When forceReasoning=true, pass empty tools array to guarantee text-only response
    // This is more reliable than tool_choice='none' which some providers ignore
    const toolsToPass = forceReasoning ? [] : llmTools;
    const toolChoice = forceReasoning ? undefined : 'auto';

    // DEBUG: Log forced reasoning state
    console.log('[FORCED REASONING]', {
      forceReasoning,
      toolsCount: toolsToPass.length,
      toolChoice,
      lastStepWasToolExecution: this.lastStepWasToolExecution,
    });

    this.ctx.platform.logger.debug('LLM call with forced reasoning', {
      forceReasoning,
      toolsCount: toolsToPass.length,
      toolChoice,
      lastStepWasToolExecution: this.lastStepWasToolExecution,
    });

    // Call native tool calling API
    const response = await llm.chatWithTools!(llmMessages, {
      tools: toolsToPass,
      toolChoice,
      temperature: llmConfig.temperature || 0.7,
      maxTokens: llmConfig.maxTokens || 4000,
    });

    // Convert LLMToolCall[] to ToolCall[]
    // Use mapping to restore original names: fs_read -> fs:read
    const toolCalls = response.toolCalls?.map((tc) => ({
      id: tc.id,
      name: nameMap.get(tc.name) || tc.name, // Restore original name
      input: tc.input,
    }));

    return {
      content: response.content || '',
      toolCalls,
      tokensUsed: response.usage.promptTokens + response.usage.completionTokens,
    };
  }

  /**
   * Call LLM using text-based tool prompting (fallback)
   */
  private async callLLMWithTextTools(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    llmConfig: { temperature?: number; maxTokens?: number }
  ): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    tokensUsed?: number;
  }> {
    const llm = useLLM();

    if (!llm) {
      throw new Error('LLM adapter not available');
    }

    // Build complete prompt with system prompt, tools, and messages
    let prompt = systemPrompt + '\n\n';

    // Add available tools section
    if (tools.length > 0) {
      prompt += '## Available Tools\n\n';
      prompt += 'You have access to the following tools. To use a tool, respond with:\n';
      prompt += 'TOOL: <tool_name>\n';
      prompt += 'INPUT: <json_input>\n\n';

      for (const tool of tools) {
        prompt += `### ${tool.name}\n`;
        prompt += `${tool.description}\n`;
        prompt += `Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}\n\n`;
      }
    }

    // Add conversation history
    prompt += '## Conversation\n\n';
    for (const msg of messages) {
      prompt += `${msg.role.toUpperCase()}: ${msg.content}\n\n`;
    }

    // Call LLM
    const response = await llm.complete(prompt, {
      temperature: llmConfig.temperature || 0.7,
      maxTokens: llmConfig.maxTokens || 4000,
    });

    // Parse tool calls from response (simple text parsing)
    const toolCalls: ToolCall[] = [];
    const content = response.content || '';

    // Check if response contains tool call
    const toolMatch = content.match(/TOOL:\s*(\S+)\s+INPUT:\s*(\{[\s\S]*?\})/);
    if (toolMatch && toolMatch[1] && toolMatch[2]) {
      const toolName = toolMatch[1];
      try {
        const input = JSON.parse(toolMatch[2]);
        toolCalls.push({
          id: `tool-${Date.now()}`,
          name: toolName,
          input,
        });
      } catch (error) {
        // Failed to parse tool input - treat as regular response
        this.ctx.platform.logger.warn('Failed to parse tool input', {
          toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      content: response.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: response.usage.promptTokens + response.usage.completionTokens,
    };
  }

  /**
   * Format tool results for LLM
   */
  private formatToolResults(toolCalls: Array<{
    name: string;
    input: any;
    output?: string;
    success: boolean;
    error?: any;
  }>): string {
    const results: string[] = [];

    for (const tc of toolCalls) {
      if (tc.success) {
        results.push(`✓ ${tc.name}: ${tc.output}`);
      } else {
        results.push(`✗ ${tc.name}: ${tc.error?.message || 'Unknown error'}`);
      }
    }

    return results.join('\n\n');
  }

  /**
   * Collect tool usage statistics from execution steps
   */
  private collectToolStats(steps: AgentExecutionStep[]): {
    totalCalls: number;
    uniqueTools: number;
    byTool: Record<string, { count: number; successCount: number; failCount: number }>;
  } {
    const byTool: Record<string, { count: number; successCount: number; failCount: number }> = {};
    let totalCalls = 0;

    for (const step of steps) {
      if (step.toolCalls) {
        for (const toolCall of step.toolCalls) {
          totalCalls++;

          if (!byTool[toolCall.name]) {
            byTool[toolCall.name] = { count: 0, successCount: 0, failCount: 0 };
          }

          const stats = byTool[toolCall.name];
          if (stats) {
            stats.count++;

            if (toolCall.success) {
              stats.successCount++;
            } else {
              stats.failCount++;
            }
          }
        }
      }
    }

    return {
      totalCalls,
      uniqueTools: Object.keys(byTool).length,
      byTool,
    };
  }

  /**
   * Categorize task based on keywords for analytics correlation
   *
   * Helps group similar tasks together for:
   * - Performance analysis (average duration, tokens for task type)
   * - Success rate by category
   * - Tool usage patterns
   * - Cost optimization
   */
  private categorizeTask(task: string): string {
    const lower = task.toLowerCase();

    // File operations
    if (lower.match(/\b(read|write|edit|create|delete|move|copy|rename)\b.*\b(file|directory|folder)\b/)) {
      return 'file-operations';
    }

    // Code tasks
    if (lower.match(/\b(refactor|implement|fix|debug|test|review|analyze|optimize)\b.*\b(code|function|class|method)\b/)) {
      return 'code-tasks';
    }

    // Search/discovery
    if (lower.match(/\b(find|search|locate|discover|list|show)\b/)) {
      return 'search-discovery';
    }

    // Analysis/understanding
    if (lower.match(/\b(explain|describe|summarize|analyze|understand|tell me)\b/)) {
      return 'analysis-understanding';
    }

    // Documentation
    if (lower.match(/\b(document|readme|comment|docs|documentation)\b/)) {
      return 'documentation';
    }

    // Testing
    if (lower.match(/\b(test|spec|unit test|integration test|e2e)\b/)) {
      return 'testing';
    }

    // Build/deploy
    if (lower.match(/\b(build|deploy|release|publish|install|setup)\b/)) {
      return 'build-deploy';
    }

    return 'general';
  }

  /**
   * Create a short hash of task for grouping similar tasks
   *
   * Normalizes the task to create consistent hashes for similar requests:
   * - Removes file paths, numbers, specific names
   * - Keeps only action words and structure
   * - Enables correlation: "Read foo.ts" and "Read bar.ts" get same hash
   */
  private hashTask(task: string): string {
    // Normalize task: lowercase, remove paths, numbers, specific names
    let normalized = task.toLowerCase();

    // Remove file paths (e.g., ./src/foo.ts -> FILE_PATH)
    normalized = normalized.replace(/[./\\][\w/\\.-]+\.(ts|js|json|md|tsx|jsx|yml|yaml)/g, 'FILE_PATH');

    // Remove numbers
    normalized = normalized.replace(/\d+/g, 'NUM');

    // Remove quoted strings
    normalized = normalized.replace(/"[^"]*"/g, 'STRING');
    normalized = normalized.replace(/'[^']*'/g, 'STRING');

    // Keep only letters, spaces, and basic punctuation
    normalized = normalized.replace(/[^a-z\s]/g, ' ');

    // Collapse multiple spaces
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Take first 50 chars for hash
    const hashInput = normalized.substring(0, 50);

    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) + hash) + hashInput.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }

    // Return as hex string
    return Math.abs(hash).toString(16);
  }
}
