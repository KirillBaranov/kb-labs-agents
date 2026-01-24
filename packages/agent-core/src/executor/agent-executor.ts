/**
 * Agent Executor (V2 Architecture)
 *
 * Simplified executor for agents:
 * - No task classification (agent already knows domain)
 * - Configurable forced reasoning interval (from YAML)
 * - Static context injection
 * - Structured output validation
 */

import type { PluginContextV3 } from "@kb-labs/sdk";
import { useLLM, useCache } from "@kb-labs/sdk";
import type {
  AgentConfigV1 as AgentConfigV1,
  ExecutionContext,
  AgentOutcome,
  RunMeta,
  FailureReport,
  LLMTier,
} from "@kb-labs/agent-contracts";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  AgentExecutionStep,
  ToolCall,
  ToolDefinition,
  AgentProgressCallback,
} from "@kb-labs/agent-contracts";
import { ToolExecutor } from "../tools/tool-executor.js";
import { LoopDetector } from "./loop-detector.js";
import { ExecutionMemory } from "./execution-memory.js";
import { ContextCompressor, type Message } from "./context-compressor.js";
import { SessionStateManager } from "./session-state-manager.js";
import {
  sanitizeToolName,
  createToolNameMapping,
  restoreToolName,
} from "./tool-name-sanitizer.js";
import {
  createToolTraceStore,
  createToolTraceRecorder,
  createSchemaValidator,
  type IToolTraceStore,
} from "../trace/index.js";
import { buildOutputTool } from "../output-tool-builder.js";

/**
 * Agent execution context
 */
export interface AgentContext {
  config: AgentConfigV1;
  tools: ToolDefinition[];
}

/**
 * Agent execution result
 */
export interface AgentResult {
  success: boolean;
  output: unknown;
  steps: AgentExecutionStep[];
  tokensUsed: number;
  durationMs: number;
  error?: string;
  /**
   * Tool trace reference (for verification)
   * Format: "trace:<traceId>"
   * Points to ToolTrace containing all tool invocations during execution.
   */
  traceRef?: string;
  /**
   * Tool trace object (for Level 2 validation)
   * Contains all tool invocations with inputs/outputs for schema validation.
   */
  toolTrace?: import("@kb-labs/agent-contracts").ToolTrace;
}

/**
 * Agent Runtime State
 */
interface AgentRuntimeState {
  agentId: string;
  task: string;
  tools: ToolDefinition[];
  currentStep: number;
  maxSteps: number;
  steps: AgentExecutionStep[];
  tokensUsed: number;
  startTime: number;
  messages: Message[];

  // Forced reasoning tracking
  toolCallsSinceReasoning: number;
  forcedReasoningInterval: number;
}

/**
 * Agent Executor
 *
 * Simpler than AgentExecutor:
 * - Uses agent's configured forcedReasoningInterval
 * - Injects static context from YAML
 * - No task classification (agent knows its domain)
 * - Validates structured output
 */
export class AgentExecutor {
  private loopDetector: LoopDetector;
  private toolExecutor: ToolExecutor;
  private contextCompressor: ContextCompressor;
  private executionMemory: ExecutionMemory;
  private toolTraceStore: IToolTraceStore;

  constructor(private ctx: PluginContextV3) {
    this.loopDetector = new LoopDetector();
    this.toolExecutor = new ToolExecutor(ctx);
    this.contextCompressor = new ContextCompressor(ctx);
    this.executionMemory = new ExecutionMemory();
    // Initialize tool trace store (in-memory for Phase 1)
    this.toolTraceStore = createToolTraceStore();
  }

  /**
   * Execute a agent task (V2 with ExecutionContext)
   *
   * Phase 3: Returns AgentOutcome with failure classification and partial results
   * Phase 4: Supports tier override for model escalation
   *
   * @param context - Agent context (config, tools)
   * @param task - Task description from orchestrator
   * @param executionContext - Execution context from orchestrator
   * @param progressCallback - Optional progress callback
   * @param tierOverride - Override LLM tier for escalation (Phase 4)
   * @returns Execution outcome (success with result OR failure with partial result)
   */
  async execute(
    context: AgentContext,
    task: string,
    executionContext?: ExecutionContext,
    progressCallback?: AgentProgressCallback,
    tierOverride?: LLMTier,
  ): Promise<AgentOutcome<AgentResult>> {
    const config = context.config;
    const startTime = Date.now();

    // Phase 4: Use tier override if provided (for escalation)
    const effectiveTier = tierOverride || config.llm.tier;

    // Initialize tool executor with tools
    this.toolExecutor = new ToolExecutor(this.ctx, { tools: context.tools });
    this.toolExecutor.setAgentId(config.id);

    // Initialize session state manager
    const sessionId = `${config.id}:${Date.now()}`;
    const sessionState = new SessionStateManager(this.ctx, sessionId);

    // Create tool trace for this agent execution
    const trace = await this.toolTraceStore.create(sessionId, config.id);

    // Setup trace recorder and schema validator
    const traceRecorder = createToolTraceRecorder({
      traceId: trace.traceId,
      store: this.toolTraceStore,
      purpose: "execution",
    });
    const schemaValidator = createSchemaValidator();

    // Inject recorder and validator into tool executor
    this.toolExecutor.setTraceRecorder(traceRecorder);
    this.toolExecutor.setSchemaValidator(schemaValidator);

    // Get forced reasoning interval from config (default: 3)
    const forcedReasoningInterval = config.limits.forcedReasoningInterval ?? 3;

    // Build output tool if agent has output schema
    const outputToolWithValidation = buildOutputTool(config);

    // Combine input tools with output tool (if exists)
    const allTools = outputToolWithValidation
      ? [...context.tools, outputToolWithValidation.definition]
      : context.tools;

    // Create tool name mapping for sanitization (OpenAI doesn't allow colons)
    const toolNameMapping = createToolNameMapping(allTools.map((t) => t.name));
    const sanitizedTools = allTools.map((tool) => ({
      ...tool,
      name: sanitizeToolName(tool.name),
    }));

    // Initialize runtime state
    const state: AgentRuntimeState = {
      agentId: config.id,
      task,
      tools: context.tools,
      currentStep: 0,
      maxSteps: config.limits.maxSteps,
      steps: [],
      tokensUsed: 0,
      startTime,
      messages: [],
      toolCallsSinceReasoning: 0,
      forcedReasoningInterval,
    };

    this.ctx.platform.logger.info("Starting agent execution", {
      agentId: config.id,
      task,
      tier: effectiveTier,
      maxSteps: state.maxSteps,
      forcedReasoningInterval,
    });

    // V2: Build system prompt with ExecutionContext (Phase 4: with tier)
    const systemPrompt = await this.buildSystemPromptWithContext(
      config,
      task,
      effectiveTier,
      executionContext,
    );

    // Add system message
    state.messages.push({
      role: "system",
      content: systemPrompt,
    });

    // Add user message with task
    state.messages.push({
      role: "user",
      content: this.buildUserPrompt(task),
    });

    // Track submitted result (structured output mode)
    let submittedResult: unknown = null;

    // Main execution loop
    try {
      while (state.currentStep < state.maxSteps) {
        state.currentStep++;

        this.ctx.platform.logger.debug(
          `Agent step ${state.currentStep}/${state.maxSteps}`,
          {
            agentId: config.id,
            toolCallsSinceReasoning: state.toolCallsSinceReasoning,
          },
        );

        // Add reminders as we approach max steps
        if (config.output?.schema) {
          // Halfway reminder
          if (state.currentStep === Math.floor(state.maxSteps / 2)) {
            state.messages.push({
              role: "user",
              content: `⚠️ REMINDER: Don't forget to call submit_result() when you complete the task. Your text responses won't be captured!`,
            });
          }

          // Final reminder
          if (state.currentStep === state.maxSteps - 1) {
            state.messages.push({
              role: "user",
              content: `🚨 URGENT: This is your LAST step! You MUST call submit_result() NOW with the required schema:\n\`\`\`json\n${JSON.stringify(config.output.schema, null, 2)}\n\`\`\`\n\nIf you don't call it now, all your work will be LOST!`,
            });
          }
        }

        // Check if we should compress context (by message count OR estimated tokens)
        const estimatedTokens = state.messages.reduce((sum, m) => {
          // Safety: handle undefined/null content (shouldn't happen but defensive)
          const contentLength = m.content?.length ?? 0;
          return sum + Math.ceil(contentLength / 4);
        }, 0);
        const TOKEN_COMPRESSION_THRESHOLD = 8000; // Compress if context exceeds ~8k tokens

        if (
          state.messages.length > 5 ||
          estimatedTokens > TOKEN_COMPRESSION_THRESHOLD
        ) {
          const compressed = await this.contextCompressor.compress(
            state.messages,
            task,
            state.agentId,
          );
          state.messages = compressed.compressedMessages;
          state.tokensUsed += compressed.compressedTokens;

          this.ctx.platform.logger.info("Context compressed", {
            reason: state.messages.length > 5 ? "message count" : "token count",
            originalMessages: state.messages.length,
            originalTokens: compressed.originalTokens,
            compressedTokens: compressed.compressedTokens,
            compressionRatio: compressed.compressionRatio,
            tokensSaved:
              compressed.originalTokens - compressed.compressedTokens,
          });
        }

        // Check if forced reasoning step is needed
        const isForcedReasoning =
          state.toolCallsSinceReasoning >= forcedReasoningInterval &&
          state.toolCallsSinceReasoning > 0;

        if (isForcedReasoning) {
          this.ctx.platform.logger.debug("Forced reasoning step", {
            toolCallsSinceReasoning: state.toolCallsSinceReasoning,
            forcedReasoningInterval,
          });
        }

        // Call LLM
        const llm = useLLM({ tier: effectiveTier });
        if (!llm || !llm.chatWithTools) {
          throw new Error(
            "LLM not configured or does not support tool calling",
          );
        }

        const llmResponse = await llm.chatWithTools(state.messages, {
          tools: isForcedReasoning ? [] : sanitizedTools, // No tools on forced reasoning, use sanitized names
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
        });

        // Update token usage
        const tokensUsed =
          llmResponse.usage.promptTokens + llmResponse.usage.completionTokens;
        state.tokensUsed += tokensUsed;

        // Add assistant message to history (only if has content - empty content breaks some APIs)
        const assistantContent = llmResponse.content || "";
        if (assistantContent.trim()) {
          state.messages.push({
            role: "assistant",
            content: assistantContent,
          });
        }

        // Create step record
        const step: AgentExecutionStep = {
          step: state.currentStep,
          response: llmResponse.content || "",
          tokensUsed,
        };

        // If forced reasoning, reset counter and continue
        if (isForcedReasoning) {
          state.toolCallsSinceReasoning = 0;
          state.steps.push(step);

          // Check for completion signals in reasoning
          if (this.isComplete(llmResponse.content || "")) {
            this.ctx.platform.logger.info(
              "Agent completed task (detected in reasoning)",
              {
                agentId: config.id,
                steps: state.currentStep,
              },
            );
            break;
          }

          // After forced reasoning, provide session state summary and remind about output format
          let reminderContent = "";

          // Add session state context
          const sessionStateSummary = sessionState.serializeForLLM();
          if (sessionStateSummary.trim()) {
            reminderContent += `# Current Session State\n${sessionStateSummary}\n`;
          }

          // Add output format reminder
          if (config.output?.schema) {
            reminderContent += `# Output Reminder\nWhen ready to complete, return JSON in this format:\n\`\`\`json\n${JSON.stringify(config.output.schema, null, 2)}\n\`\`\`\n\nSay "TASK COMPLETE" followed by the JSON block.`;
          }

          if (reminderContent) {
            state.messages.push({
              role: "system",
              content: reminderContent,
            });
          }

          continue;
        }

        // Execute tools
        const toolCalls = llmResponse.toolCalls || [];

        if (toolCalls.length === 0) {
          // No tools called - check if complete
          if (this.isComplete(llmResponse.content || "")) {
            state.steps.push(step);
            this.ctx.platform.logger.info(
              "Agent completed task (no more tools)",
              {
                agentId: config.id,
                steps: state.currentStep,
              },
            );
            break;
          }

          // No tools and not complete - add step and continue
          state.steps.push(step);
          continue;
        }

        // Execute tool calls
        step.toolCalls = [];

        for (const llmToolCall of toolCalls) {
          // Restore original tool name (mind_rag_query → mind:rag-query)
          const originalName = restoreToolName(
            llmToolCall.name,
            toolNameMapping,
          );

          // Check if this is submit_result call (structured output mode)
          if (originalName === "submit_result" && outputToolWithValidation) {
            // Validate input against Zod schema
            const parseResult = outputToolWithValidation.zodSchema.safeParse(
              llmToolCall.input,
            );

            if (!parseResult.success) {
              // Validation failed - add error to messages and continue
              const errorMessage = `submit_result validation failed: ${parseResult.error.message}`;
              this.ctx.platform.logger.warn(errorMessage, {
                agentId: config.id,
                step: state.currentStep,
                errors: parseResult.error.errors,
              });

              state.messages.push({
                role: "user",
                content: `❌ ${errorMessage}\n\nPlease fix the output and call submit_result again.`,
              });

              step.toolCalls.push({
                name: "submit_result",
                input: llmToolCall.input,
                output: "",
                success: false,
                error: errorMessage,
              });

              continue;
            }

            // Validation succeeded - store result and break
            submittedResult = parseResult.data;

            step.toolCalls.push({
              name: "submit_result",
              input: llmToolCall.input,
              output: JSON.stringify(parseResult.data),
              success: true,
            });

            this.ctx.platform.logger.info("Agent submitted structured result", {
              agentId: config.id,
              step: state.currentStep,
            });

            // Don't execute submit_result through tool executor
            continue;
          }

          const toolCall = {
            id: llmToolCall.id,
            name: originalName,
            input: llmToolCall.input,
          };
          const result = await this.toolExecutor.execute(toolCall);

          step.toolCalls.push({
            name: toolCall.name,
            input: toolCall.input,
            output: result.output || "",
            success: result.success,
            error: result.error
              ? typeof result.error === "string"
                ? result.error
                : result.error.message
              : undefined,
          });

          // Add tool result to messages (with aggressive truncation to prevent context explosion)
          const rawOutput =
            JSON.stringify(result.output ?? null, null, 2) ?? ""; // Safety: handle undefined output
          const MAX_TOOL_RESULT_LENGTH = 800; // Aggressive limit - prevents 77k token explosions

          let truncatedOutput = rawOutput;
          if (rawOutput && rawOutput.length > MAX_TOOL_RESULT_LENGTH) {
            truncatedOutput =
              rawOutput.slice(0, MAX_TOOL_RESULT_LENGTH) +
              `\n\n...[truncated ${rawOutput.length - MAX_TOOL_RESULT_LENGTH} chars to save ~${Math.floor((rawOutput.length - MAX_TOOL_RESULT_LENGTH) / 4)} tokens]\n\n` +
              `💡 Full result stored in session artifacts. Use findings and context from previous messages.`;
          }

          state.messages.push({
            role: "user",
            content: `Tool result (${toolCall.name}):\n${truncatedOutput}`,
          });

          // Extract findings for memory (legacy)
          if (result.success && result.output) {
            this.executionMemory.addFinding({
              tool: toolCall.name,
              query: JSON.stringify(toolCall.input),
              fact:
                typeof result.output === "string"
                  ? result.output
                  : JSON.stringify(result.output),
              step: state.currentStep,
              success: true,
            });

            // Add to session state (V2)
            const factSummary =
              typeof result.output === "string"
                ? result.output.slice(0, 100)
                : `${toolCall.name} completed successfully`;

            sessionState.addFinding({
              step: state.currentStep,
              tool: toolCall.name,
              fact: factSummary,
            });

            // Store large outputs as artifacts
            const outputSize = (JSON.stringify(result.output ?? null) ?? "")
              .length;
            if (outputSize > 500) {
              // Store as artifact if large
              await sessionState.storeArtifact({
                type: toolCall.name.startsWith("fs:")
                  ? "file-content"
                  : "search-result",
                name: `${toolCall.name}-step-${state.currentStep}`,
                content: result.output,
                metadata: {
                  tool: toolCall.name,
                  step: state.currentStep,
                  input: toolCall.input,
                },
              });
            }
          }
        }

        state.toolCallsSinceReasoning += toolCalls.length;
        state.steps.push(step);

        // If agent submitted structured result, break immediately
        if (submittedResult !== null) {
          this.ctx.platform.logger.info(
            "Agent completed task with structured output",
            {
              agentId: config.id,
              steps: state.currentStep,
            },
          );
          break;
        }

        // Check for loops
        const loopDetection = this.loopDetector.checkForLoop(state.steps);

        if (loopDetection.detected) {
          this.ctx.platform.logger.warn("Loop detected in agent execution", {
            agentId: config.id,
            type: loopDetection.type,
            description: loopDetection.description,
            confidence: loopDetection.confidence,
          });

          // Add warning to messages
          state.messages.push({
            role: "system",
            content: `⚠️ Warning: Loop detected (${loopDetection.type}). ${loopDetection.description}. Try a different approach.`,
          });
        }

        // Notify progress
        if (progressCallback?.onStepStart) {
          progressCallback.onStepStart(state.currentStep, state.maxSteps);
        }
      }

      // Execution completed
      const durationMs = Date.now() - startTime;

      // Extract output based on mode
      let rawOutput: unknown;
      if (submittedResult !== null) {
        // Structured output mode: use submitted result
        rawOutput = submittedResult;
        this.ctx.platform.logger.info(
          "Using structured output from submit_result",
          {
            agentId: config.id,
          },
        );
      } else {
        // Legacy mode: extract from text
        const lastMessage = state.messages
          .filter((m) => m.role === "assistant")
          .pop();
        rawOutput = this.extractOutput(lastMessage?.content || "", config);
        this.ctx.platform.logger.info("Using legacy text-based output", {
          agentId: config.id,
        });
      }

      // ADR-0002: Ensure output includes traceRef for verification
      // If extracted output is an object, inject traceRef. Otherwise wrap in AgentOutput structure.
      const output =
        typeof rawOutput === "object" && rawOutput !== null
          ? { ...rawOutput, traceRef: `trace:${trace.traceId}` }
          : {
              summary:
                typeof rawOutput === "string"
                  ? rawOutput
                  : JSON.stringify(rawOutput),
              traceRef: `trace:${trace.traceId}`,
            };

      // Log session state metrics
      const sessionTokens = sessionState.getTokenEstimate();
      const sessionStats = sessionState.getState();

      this.ctx.platform.logger.info("Agent execution completed", {
        agentId: config.id,
        success: true,
        steps: state.currentStep,
        tokensUsed: state.tokensUsed,
        durationMs,
        sessionState: {
          findings: sessionStats.findings.length,
          artifacts: sessionStats.artifacts.length,
          tokensEstimate: sessionTokens,
        },
      });

      // Cleanup session state (optional - can keep for debugging)
      // await sessionState.clear();

      // Complete tool trace
      await this.toolTraceStore.complete(trace.traceId);

      // Retrieve tool trace for verification (ADR-0002 Level 2)
      const toolTrace = await this.toolTraceStore.load(
        `trace:${trace.traceId}`,
      );

      // Phase 3: Return AgentOutcome with success
      const result: AgentResult = {
        success: true,
        output,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
        traceRef: `trace:${trace.traceId}`,
        toolTrace: toolTrace || undefined,
      };

      const meta: RunMeta = {
        durationMs,
        tokenUsage: {
          prompt: Math.floor(state.tokensUsed * 0.4), // Rough estimate (40% prompt, 60% completion)
          completion: Math.floor(state.tokensUsed * 0.6),
        },
        toolCalls: state.steps.reduce(
          (sum, step) => sum + (step.toolCalls?.length || 0),
          0,
        ),
        modelTier: effectiveTier,
      };

      return {
        ok: true,
        result,
        meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error(
        "Agent execution failed",
        new Error(
          `[${config.id}] ${errorMessage} (steps: ${state.currentStep}, duration: ${durationMs}ms)`,
        ),
      );

      // Complete tool trace even on error
      await this.toolTraceStore.complete(trace.traceId);

      // Retrieve tool trace for verification (ADR-0002 Level 2)
      let toolTrace: import("@kb-labs/agent-contracts").ToolTrace | undefined;
      try {
        toolTrace = await this.toolTraceStore.load(`trace:${trace.traceId}`);
      } catch (loadError) {
        // Trace load failed - not critical in error path
        this.ctx.platform.logger.warn(
          "Failed to load tool trace in error path",
          {
            error:
              loadError instanceof Error
                ? loadError.message
                : String(loadError),
          },
        );
      }

      // Phase 3: Classify error and build failure report
      const failure: FailureReport = {
        kind: this.classifyError(error),
        message: errorMessage,
        lastToolCalls: this.getLastToolCalls(state.steps, 5),
        suggestedRetry: this.shouldRetry(error),
      };

      // Phase 3: Build partial result (preserve work done so far!)
      const partial: AgentResult = {
        success: false,
        output: null,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
        error: errorMessage,
        traceRef: `trace:${trace.traceId}`,
        toolTrace,
      };

      const meta: RunMeta = {
        durationMs,
        tokenUsage: {
          prompt: Math.floor(state.tokensUsed * 0.4),
          completion: Math.floor(state.tokensUsed * 0.6),
        },
        toolCalls: state.steps.reduce(
          (sum, step) => sum + (step.toolCalls?.length || 0),
          0,
        ),
        modelTier: effectiveTier,
      };

      // Phase 3: Return AgentOutcome with failure + partial result
      return {
        ok: false,
        failure,
        partial,
        meta,
      };
    }
  }

  /**
   * Build system prompt with static context
   *
   * Phase 4: Accepts tier parameter for context adaptation
   */
  private buildSystemPrompt(
    config: AgentConfigV1,
    task: string,
    tier: LLMTier,
    inputData?: unknown,
  ): string {
    let prompt = "";

    // Add static context if provided
    if (config.context?.static?.system) {
      prompt += config.context.static.system + "\n\n";
    }

    // Add capabilities
    if (config.capabilities && config.capabilities.length > 0) {
      prompt += `## Your Capabilities\n`;
      for (const capability of config.capabilities) {
        prompt += `- ${capability}\n`;
      }
      prompt += "\n";
    }

    // Add constraints
    if (config.constraints && config.constraints.length > 0) {
      prompt += `## Constraints\n`;
      for (const constraint of config.constraints) {
        prompt += `${constraint}\n`;
      }
      prompt += "\n";
    }

    // SYSTEM: Add structured output instructions (auto-injected, not user-defined)
    if (config.output?.schema) {
      prompt += `## ⚠️ SYSTEM: Structured Output Mode\n\n`;
      prompt += `**CRITICAL INSTRUCTION (Auto-injected by system):**\n`;
      prompt += `You MUST call the \`submit_result()\` tool when you finish the task!\n\n`;
      prompt += `The orchestrator will NOT see your text responses - only tool call results are captured.\n\n`;
      prompt += `**Workflow:**\n`;
      prompt += `1. Use your available tools (fs:read, fs:write, mind:rag-query, etc.) to complete the task\n`;
      prompt += `2. Analyze and process the information\n`;
      prompt += `3. **Call submit_result() with structured output** matching the required schema\n\n`;
      prompt += `**Required Output Schema:**\n`;
      prompt += `\`\`\`json\n`;
      prompt += JSON.stringify(config.output.schema, null, 2);
      prompt += `\n\`\`\`\n\n`;
      prompt += `If you forget step 3, your work will be LOST and the task will FAIL!\n\n`;
    }

    return prompt;
  }

  /**
   * Build system prompt with ExecutionContext (V2)
   *
   * Loads context.md and examples.yml from agent directory.
   * Uses cache with 1 hour TTL for static files.
   *
   * Phase 4: Accepts tier parameter for context adaptation
   *
   * @param config - Agent configuration
   * @param task - Task description
   * @param tier - Model tier for context adaptation
   * @param executionContext - Execution context from orchestrator
   * @returns System prompt with full context
   */
  private async buildSystemPromptWithContext(
    config: AgentConfigV1,
    task: string,
    tier: LLMTier,
    executionContext?: ExecutionContext,
  ): Promise<string> {
    let prompt = "";

    // CRITICAL: Add structured output instructions FIRST (most important)
    if (config.output?.schema) {
      prompt += `🚨 CRITICAL REQUIREMENT 🚨\n\n`;
      prompt += `You MUST call the submit_result() tool when you complete the task.\n`;
      prompt += `This is NOT optional - the orchestrator ONLY captures tool call results.\n`;
      prompt += `Your text responses will be IGNORED and your work will be LOST if you don't call submit_result()!\n\n`;
      prompt += `Required Output Schema:\n`;
      prompt += `\`\`\`json\n`;
      prompt += JSON.stringify(config.output.schema, null, 2);
      prompt += `\n\`\`\`\n\n`;
      prompt += `Workflow: Use tools → Complete task → Call submit_result() with above schema → DONE\n\n`;
      prompt += `─`.repeat(60) + "\n\n";
    }

    // Add static context from config (backward compatibility)
    if (config.context?.static?.system) {
      prompt += config.context.static.system + "\n\n";
    }

    // V2: Load context.md from agent directory
    const contextMd = await this.loadContextMarkdown(config.id);
    if (contextMd) {
      // V2.5: Adapt context size based on model tier (Phase 4: uses tier param)
      const adaptedContext = this.adaptContextForTier(contextMd, tier);
      prompt += `# Agent Context\n\n${adaptedContext}\n\n`;
    }

    // V2: Add ExecutionContext information
    if (executionContext) {
      prompt += `# Execution Context\n\n`;
      prompt += `**Project Root:** ${executionContext.projectRoot}\n`;
      prompt += `**Working Directory:** ${executionContext.workingDir}\n`;

      if (executionContext.outputDir) {
        prompt += `**Output Directory:** ${executionContext.outputDir}\n`;
        prompt += `*Note: Write generated artifacts to output directory*\n`;
      } else {
        prompt += `**Working Mode:** Direct project modification\n`;
        prompt += `*Note: Edit files directly in projectRoot*\n`;
      }

      prompt += "\n";

      // Add findings from previous agents
      if (executionContext.findings && executionContext.findings.length > 0) {
        prompt += `## Findings from Previous Agents\n\n`;
        for (const finding of executionContext.findings) {
          prompt += `- ${finding}\n`;
        }
        prompt += "\n";
      }

      // Add available files
      if (executionContext.availableFiles.created.length > 0) {
        prompt += `## Files Created by Previous Agents\n\n`;
        for (const file of executionContext.availableFiles.created) {
          prompt += `- ${file}\n`;
        }
        prompt += "\n";
      }

      if (executionContext.availableFiles.modified.length > 0) {
        prompt += `## Files Modified by Previous Agents\n\n`;
        for (const file of executionContext.availableFiles.modified) {
          prompt += `- ${file}\n`;
        }
        prompt += "\n";
      }
    }

    // V2: Load examples.yml from agent directory
    const examples = await this.loadExamples(config.id);
    if (examples && examples.length > 0) {
      prompt += `# Example Approaches\n\n`;
      for (const example of examples) {
        prompt += `## Example: ${example.task}\n\n`;
        prompt += `**Approach:**\n${example.approach}\n\n`;
        prompt += `**Outcome:** ${example.outcome}\n\n`;
      }
    }

    // Add capabilities
    if (config.capabilities && config.capabilities.length > 0) {
      prompt += `## Your Capabilities\n`;
      for (const capability of config.capabilities) {
        prompt += `- ${capability}\n`;
      }
      prompt += "\n";
    }

    // Add constraints
    if (config.constraints && config.constraints.length > 0) {
      prompt += `## Constraints\n`;
      for (const constraint of config.constraints) {
        prompt += `${constraint}\n`;
      }
      prompt += "\n";
    }

    // SYSTEM: Add structured output instructions (auto-injected, not user-defined)
    if (config.output?.schema) {
      prompt += `## ⚠️ SYSTEM: Structured Output Mode\n\n`;
      prompt += `**CRITICAL INSTRUCTION (Auto-injected by system):**\n`;
      prompt += `You MUST call the \`submit_result()\` tool when you finish the task!\n\n`;
      prompt += `The orchestrator will NOT see your text responses - only tool call results are captured.\n\n`;
      prompt += `**Workflow:**\n`;
      prompt += `1. Use your available tools (fs:read, fs:write, mind:rag-query, etc.) to complete the task\n`;
      prompt += `2. Analyze and process the information\n`;
      prompt += `3. **Call submit_result() with structured output** matching the required schema\n\n`;
      prompt += `**Required Output Schema:**\n`;
      prompt += `\`\`\`json\n`;
      prompt += JSON.stringify(config.output.schema, null, 2);
      prompt += `\n\`\`\`\n\n`;
      prompt += `If you forget step 3, your work will be LOST and the task will FAIL!\n\n`;
    }

    return prompt;
  }

  /**
   * Adapt context.md size based on model tier (V2.5)
   *
   * - small (haiku): 2KB max (~500 tokens)
   * - medium (sonnet): 5KB max (~1200 tokens)
   * - large (opus): unlimited
   *
   * Truncates with marker when context exceeds tier limit.
   *
   * @param contextMd - Full context markdown
   * @param tier - Model tier
   * @returns Adapted context
   */
  private adaptContextForTier(contextMd: string, tier: LLMTier): string {
    const limits = {
      small: 2048, // 2KB (~500 tokens)
      medium: 5120, // 5KB (~1200 tokens)
      large: Infinity, // No limit
    } as const;

    const maxChars = limits[tier];

    if (contextMd.length <= maxChars) {
      return contextMd;
    }

    // Truncate with marker
    const truncated = contextMd.slice(0, maxChars - 120);
    return `${truncated}\n\n...(truncated for ${tier} tier model - full context available on escalation)\n`;
  }

  /**
   * Load context.md for agent (V2)
   *
   * Cached with 1 hour TTL using useCache() from SDK.
   *
   * @param agentId - Agent ID
   * @returns Context markdown content or undefined
   */
  private async loadContextMarkdown(
    agentId: string,
  ): Promise<string | undefined> {
    const cache = useCache();
    const cacheKey = `agent:${agentId}:context`;

    // Try cache first
    if (cache) {
      const cached = await cache.get<string>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Load from filesystem
    try {
      const contextPath = path.join(
        process.cwd(),
        ".kb/agents",
        agentId,
        "context.md",
      );
      const content = await fs.readFile(contextPath, "utf-8");

      // Cache for 1 hour (3600000ms)
      if (cache) {
        await cache.set(cacheKey, content, 3600000);
      }

      return content;
    } catch (error) {
      // File not found or read error - not critical
      this.ctx.platform.logger.debug("Failed to load context.md", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Load examples.yml for agent (V2)
   *
   * Cached with 1 hour TTL using useCache() from SDK.
   *
   * @param agentId - Agent ID
   * @returns Array of examples or undefined
   */
  private async loadExamples(
    agentId: string,
  ): Promise<
    Array<{ task: string; approach: string; outcome: string }> | undefined
  > {
    const cache = useCache();
    const cacheKey = `agent:${agentId}:examples`;

    // Try cache first
    if (cache) {
      const cached =
        await cache.get<
          Array<{ task: string; approach: string; outcome: string }>
        >(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Load from filesystem
    try {
      const examplesPath = path.join(
        process.cwd(),
        ".kb/agents",
        agentId,
        "examples.yml",
      );
      const content = await fs.readFile(examplesPath, "utf-8");

      // Simple YAML parsing (examples is an array)
      const examples = this.parseExamplesYaml(content);

      // Cache for 1 hour (3600000ms)
      if (cache) {
        await cache.set(cacheKey, examples, 3600000);
      }

      return examples;
    } catch (error) {
      // File not found or read error - not critical
      this.ctx.platform.logger.debug("Failed to load examples.yml", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Parse examples.yml content (simple parser)
   *
   * Format:
   * examples:
   *   - task: "..."
   *     approach: |
   *       ...
   *     outcome: "..."
   *
   * @param content - YAML content
   * @returns Parsed examples
   */
  private parseExamplesYaml(
    content: string,
  ): Array<{ task: string; approach: string; outcome: string }> {
    const examples: Array<{ task: string; approach: string; outcome: string }> =
      [];

    // Simple regex-based parsing for our specific format
    const exampleBlocks = content.split(/^  - task:/m).slice(1);

    for (const block of exampleBlocks) {
      const taskMatch = block.match(/^\s*"([^"]+)"/);
      const approachMatch = block.match(
        /approach:\s*\|\s*\n((?:(?:      .+|\s*)\n)+)/,
      );
      const outcomeMatch = block.match(/outcome:\s*"([^"]+)"/);

      if (taskMatch?.[1] && approachMatch?.[1] && outcomeMatch?.[1]) {
        examples.push({
          task: taskMatch[1],
          approach: approachMatch[1].replace(/^      /gm, "").trim(),
          outcome: outcomeMatch[1],
        });
      }
    }

    return examples;
  }

  /**
   * Build user prompt with task
   */
  private buildUserPrompt(task: string): string {
    return `Task: ${task}\n`;
  }

  /**
   * Classify error kind (Phase 3)
   *
   * Maps error messages to failure kinds for retry logic
   */
  private classifyError(error: unknown): FailureReport["kind"] {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      if (msg.includes("timeout") || msg.includes("timed out")) {
        return "timeout";
      }
      if (msg.includes("tool") || msg.includes("execution failed")) {
        return "tool_error";
      }
      if (msg.includes("validation") || msg.includes("schema")) {
        return "validation_failed";
      }
      if (
        msg.includes("stuck") ||
        msg.includes("loop") ||
        msg.includes("infinite")
      ) {
        return "stuck";
      }
      if (
        msg.includes("policy") ||
        msg.includes("denied") ||
        msg.includes("budget")
      ) {
        return "policy_denied";
      }
    }

    return "unknown";
  }

  /**
   * Determine if error should trigger retry (Phase 3)
   *
   * - Don't retry: validation errors, policy violations
   * - Retry: timeouts, tool errors, unknown errors
   */
  private shouldRetry(error: unknown): boolean {
    const kind = this.classifyError(error);

    // Don't retry permanent failures
    if (kind === "validation_failed") {
      return false;
    }
    if (kind === "policy_denied") {
      return false;
    }

    // Retry transient failures
    if (kind === "timeout") {
      return true;
    }
    if (kind === "tool_error") {
      return true;
    }
    if (kind === "stuck") {
      return true;
    }

    // Default: retry unknown errors
    return true;
  }

  /**
   * Get last N tool calls for debugging (Phase 3)
   */
  private getLastToolCalls(
    steps: AgentExecutionStep[],
    count: number,
  ): Array<{ tool: string; args: unknown; error?: string }> {
    const lastSteps = steps.slice(-count);
    const calls: Array<{ tool: string; args: unknown; error?: string }> = [];

    for (const step of lastSteps) {
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          calls.push({
            tool: tc.name,
            args: tc.input,
            error: tc.error,
          });
        }
      }
    }

    return calls;
  }

  /**
   * Check if agent indicated completion
   */
  private isComplete(message: string): boolean {
    const lowerMessage = message.toLowerCase();

    // Check for explicit completion signals
    const hasCompletionSignal =
      lowerMessage.includes("task complete") ||
      lowerMessage.includes("done") ||
      lowerMessage.includes("finished") ||
      lowerMessage.includes("completed");

    // Check for JSON output (indicates structured result ready)
    const hasJsonOutput =
      message.includes("```json") ||
      /\{[\s\S]*"summary"[\s\S]*\}/.test(message);

    return hasCompletionSignal || hasJsonOutput;
  }

  /**
   * Extract structured output from message
   */
  private extractOutput(message: string, config: AgentConfigV1): unknown {
    this.ctx.platform.logger.debug("Extracting output from agent response", {
      messageLength: message.length,
      hasSchema: !!config.output?.schema,
    });

    // Strategy 1: Try to extract from ```json ... ``` code block
    const jsonBlockMatch = message.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        this.ctx.platform.logger.debug(
          "Extracted output from JSON code block",
          { parsed },
        );
        return parsed;
      } catch (error) {
        this.ctx.platform.logger.warn("Failed to parse JSON from code block", {
          error: error instanceof Error ? error.message : String(error),
          content: jsonBlockMatch[1].slice(0, 200),
        });
      }
    }

    // Strategy 2: Try to extract any JSON object (greedy match from last {)
    const lines = message.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && line.trim().startsWith("{")) {
        // Found potential JSON start, try to parse from here to end
        const jsonCandidate = lines.slice(i).join("\n");
        try {
          const parsed = JSON.parse(jsonCandidate);
          this.ctx.platform.logger.debug("Extracted output from JSON object", {
            parsed,
          });
          return parsed;
        } catch {
          // Continue searching
        }
      }
    }

    // Strategy 3: Try to find JSON anywhere in message
    const objectMatch = message.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        this.ctx.platform.logger.debug("Extracted output from inline JSON", {
          parsed,
        });
        return parsed;
      } catch (error) {
        this.ctx.platform.logger.warn("Failed to parse inline JSON", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: Wrap raw message in summary field
    this.ctx.platform.logger.warn(
      "Could not extract structured output, using fallback",
      {
        messageSample: message.slice(0, 200),
      },
    );
    return {
      summary: message || "(empty response)",
      _warning: "Output was not in expected JSON format",
    };
  }
}
