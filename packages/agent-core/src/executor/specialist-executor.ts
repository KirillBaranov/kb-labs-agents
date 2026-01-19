/**
 * Specialist Executor (V2 Architecture)
 *
 * Simplified executor for specialists:
 * - No task classification (specialist already knows domain)
 * - Configurable forced reasoning interval (from YAML)
 * - Static context injection
 * - Structured output validation
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import { useLLM, useCache } from '@kb-labs/sdk';
import type { SpecialistConfigV1, ExecutionContext, SpecialistOutcome, RunMeta, FailureReport } from '@kb-labs/agent-contracts';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  AgentExecutionStep,
  ToolCall,
  ToolDefinition,
  AgentProgressCallback,
} from '@kb-labs/agent-contracts';
import { ToolExecutor } from '../tools/tool-executor.js';
import { LoopDetector } from './loop-detector.js';
import { ExecutionMemory } from './execution-memory.js';
import { ContextCompressor, type Message } from './context-compressor.js';
import { SessionStateManager } from './session-state-manager.js';
import { sanitizeToolName, createToolNameMapping, restoreToolName } from './tool-name-sanitizer.js';
import {
  createToolTraceStore,
  createToolTraceRecorder,
  createSchemaValidator,
  type IToolTraceStore,
} from '../trace/index.js';

/**
 * Specialist execution context
 */
export interface SpecialistContext {
  config: SpecialistConfigV1;
  tools: ToolDefinition[];
}

/**
 * Specialist execution result
 */
export interface SpecialistResult {
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
}

/**
 * Specialist Runtime State
 */
interface SpecialistRuntimeState {
  specialistId: string;
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
 * Specialist Executor
 *
 * Simpler than AgentExecutor:
 * - Uses specialist's configured forcedReasoningInterval
 * - Injects static context from YAML
 * - No task classification (specialist knows its domain)
 * - Validates structured output
 */
export class SpecialistExecutor {
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
   * Execute a specialist task (V2 with ExecutionContext)
   *
   * Phase 3: Returns SpecialistOutcome with failure classification and partial results
   *
   * @param context - Specialist context (config, tools)
   * @param task - Task description from orchestrator
   * @param executionContext - Execution context from orchestrator
   * @param progressCallback - Optional progress callback
   * @returns Execution outcome (success with result OR failure with partial result)
   */
  async execute(
    context: SpecialistContext,
    task: string,
    executionContext?: ExecutionContext,
    progressCallback?: AgentProgressCallback
  ): Promise<SpecialistOutcome<SpecialistResult>> {
    const config = context.config;
    const startTime = Date.now();

    // Initialize tool executor with tools
    this.toolExecutor = new ToolExecutor(this.ctx, { tools: context.tools });
    this.toolExecutor.setAgentId(config.id);

    // Initialize session state manager
    const sessionId = `${config.id}:${Date.now()}`;
    const sessionState = new SessionStateManager(this.ctx, sessionId);

    // Create tool trace for this specialist execution
    const trace = await this.toolTraceStore.create(sessionId, config.id);

    // Setup trace recorder and schema validator
    const traceRecorder = createToolTraceRecorder({
      traceId: trace.traceId,
      store: this.toolTraceStore,
      purpose: 'execution',
    });
    const schemaValidator = createSchemaValidator();

    // Inject recorder and validator into tool executor
    this.toolExecutor.setTraceRecorder(traceRecorder);
    this.toolExecutor.setSchemaValidator(schemaValidator);

    // Get forced reasoning interval from config (default: 3)
    const forcedReasoningInterval = config.limits.forcedReasoningInterval ?? 3;

    // Create tool name mapping for sanitization (OpenAI doesn't allow colons)
    const toolNameMapping = createToolNameMapping(context.tools.map(t => t.name));
    const sanitizedTools = context.tools.map(tool => ({
      ...tool,
      name: sanitizeToolName(tool.name),
    }));

    // Initialize runtime state
    const state: SpecialistRuntimeState = {
      specialistId: config.id,
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

    this.ctx.platform.logger.info('Starting specialist execution', {
      specialistId: config.id,
      task,
      tier: config.llm.tier,
      maxSteps: state.maxSteps,
      forcedReasoningInterval,
    });

    // V2: Build system prompt with ExecutionContext
    const systemPrompt = await this.buildSystemPromptWithContext(
      config,
      task,
      executionContext
    );

    // Add system message
    state.messages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Add user message with task
    state.messages.push({
      role: 'user',
      content: this.buildUserPrompt(task),
    });

    // Main execution loop
    try {
      while (state.currentStep < state.maxSteps) {
        state.currentStep++;

        this.ctx.platform.logger.debug(`Specialist step ${state.currentStep}/${state.maxSteps}`, {
          specialistId: config.id,
          toolCallsSinceReasoning: state.toolCallsSinceReasoning,
        });

        // If approaching max steps, add urgent reminder
        if (state.currentStep === state.maxSteps - 1 && config.output?.schema) {
          state.messages.push({
            role: 'system',
            content: `⚠️ WARNING: This is your LAST step! You MUST complete the task now and return JSON output:\n\`\`\`json\n${JSON.stringify(config.output.schema, null, 2)}\n\`\`\``,
          });
        }

        // Check if we should compress context (by message count OR estimated tokens)
        const estimatedTokens = state.messages.reduce((sum, m) => {
          // Safety: handle undefined/null content (shouldn't happen but defensive)
          const contentLength = m.content?.length ?? 0;
          return sum + Math.ceil(contentLength / 4);
        }, 0);
        const TOKEN_COMPRESSION_THRESHOLD = 8000; // Compress if context exceeds ~8k tokens

        if (state.messages.length > 5 || estimatedTokens > TOKEN_COMPRESSION_THRESHOLD) {
          const compressed = await this.contextCompressor.compress(
            state.messages,
            task,
            state.specialistId
          );
          state.messages = compressed.compressedMessages;
          state.tokensUsed += compressed.compressedTokens;

          this.ctx.platform.logger.info('Context compressed', {
            reason: state.messages.length > 5 ? 'message count' : 'token count',
            originalMessages: state.messages.length,
            originalTokens: compressed.originalTokens,
            compressedTokens: compressed.compressedTokens,
            compressionRatio: compressed.compressionRatio,
            tokensSaved: compressed.originalTokens - compressed.compressedTokens,
          });
        }

        // Check if forced reasoning step is needed
        const isForcedReasoning =
          state.toolCallsSinceReasoning >= forcedReasoningInterval &&
          state.toolCallsSinceReasoning > 0;

        if (isForcedReasoning) {
          this.ctx.platform.logger.debug('Forced reasoning step', {
            toolCallsSinceReasoning: state.toolCallsSinceReasoning,
            forcedReasoningInterval,
          });
        }

        // Call LLM
        const llm = useLLM({ tier: config.llm.tier });
        if (!llm || !llm.chatWithTools) {
          throw new Error('LLM not configured or does not support tool calling');
        }

        const llmResponse = await llm.chatWithTools(state.messages, {
          tools: isForcedReasoning ? [] : sanitizedTools, // No tools on forced reasoning, use sanitized names
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
        });

        // Update token usage
        const tokensUsed = llmResponse.usage.promptTokens + llmResponse.usage.completionTokens;
        state.tokensUsed += tokensUsed;

        // Add assistant message to history (only if has content - empty content breaks some APIs)
        const assistantContent = llmResponse.content || '';
        if (assistantContent.trim()) {
          state.messages.push({
            role: 'assistant',
            content: assistantContent,
          });
        }

        // Create step record
        const step: AgentExecutionStep = {
          step: state.currentStep,
          response: llmResponse.content || '',
          tokensUsed,
        };

        // If forced reasoning, reset counter and continue
        if (isForcedReasoning) {
          state.toolCallsSinceReasoning = 0;
          state.steps.push(step);

          // Check for completion signals in reasoning
          if (this.isComplete(llmResponse.content || '')) {
            this.ctx.platform.logger.info('Specialist completed task (detected in reasoning)', {
              specialistId: config.id,
              steps: state.currentStep,
            });
            break;
          }

          // After forced reasoning, provide session state summary and remind about output format
          let reminderContent = '';

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
              role: 'system',
              content: reminderContent,
            });
          }

          continue;
        }

        // Execute tools
        const toolCalls = llmResponse.toolCalls || [];

        if (toolCalls.length === 0) {
          // No tools called - check if complete
          if (this.isComplete(llmResponse.content || '')) {
            state.steps.push(step);
            this.ctx.platform.logger.info('Specialist completed task (no more tools)', {
              specialistId: config.id,
              steps: state.currentStep,
            });
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
          const originalName = restoreToolName(llmToolCall.name, toolNameMapping);

          const toolCall = {
            id: llmToolCall.id,
            name: originalName,
            input: llmToolCall.input,
          };
          const result = await this.toolExecutor.execute(toolCall);

          step.toolCalls.push({
            name: toolCall.name,
            input: toolCall.input,
            output: result.output || '',
            success: result.success,
            error: result.error ? (typeof result.error === 'string' ? result.error : result.error.message) : undefined,
          });

          // Add tool result to messages (with aggressive truncation to prevent context explosion)
          const rawOutput = JSON.stringify(result.output ?? null, null, 2) ?? ''; // Safety: handle undefined output
          const MAX_TOOL_RESULT_LENGTH = 800; // Aggressive limit - prevents 77k token explosions

          let truncatedOutput = rawOutput;
          if (rawOutput && rawOutput.length > MAX_TOOL_RESULT_LENGTH) {
            truncatedOutput = rawOutput.slice(0, MAX_TOOL_RESULT_LENGTH) +
              `\n\n...[truncated ${rawOutput.length - MAX_TOOL_RESULT_LENGTH} chars to save ~${Math.floor((rawOutput.length - MAX_TOOL_RESULT_LENGTH) / 4)} tokens]\n\n` +
              `💡 Full result stored in session artifacts. Use findings and context from previous messages.`;
          }

          state.messages.push({
            role: 'user',
            content: `Tool result (${toolCall.name}):\n${truncatedOutput}`,
          });

          // Extract findings for memory (legacy)
          if (result.success && result.output) {
            this.executionMemory.addFinding({
              tool: toolCall.name,
              query: JSON.stringify(toolCall.input),
              fact: typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output),
              step: state.currentStep,
              success: true,
            });

            // Add to session state (V2)
            const factSummary = typeof result.output === 'string'
              ? result.output.slice(0, 100)
              : `${toolCall.name} completed successfully`;

            sessionState.addFinding({
              step: state.currentStep,
              tool: toolCall.name,
              fact: factSummary,
            });

            // Store large outputs as artifacts
            const outputSize = (JSON.stringify(result.output ?? null) ?? '').length;
            if (outputSize > 500) {
              // Store as artifact if large
              await sessionState.storeArtifact({
                type: toolCall.name.startsWith('fs:') ? 'file-content' : 'search-result',
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

        // Check for loops
        const loopDetection = this.loopDetector.checkForLoop(state.steps);

        if (loopDetection.detected) {
          this.ctx.platform.logger.warn('Loop detected in specialist execution', {
            specialistId: config.id,
            type: loopDetection.type,
            description: loopDetection.description,
            confidence: loopDetection.confidence,
          });

          // Add warning to messages
          state.messages.push({
            role: 'system',
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

      // Extract output from last assistant message
      const lastMessage = state.messages.filter(m => m.role === 'assistant').pop();
      const output = this.extractOutput(lastMessage?.content || '', config);

      // Log session state metrics
      const sessionTokens = sessionState.getTokenEstimate();
      const sessionStats = sessionState.getState();

      this.ctx.platform.logger.info('Specialist execution completed', {
        specialistId: config.id,
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

      // Phase 3: Return SpecialistOutcome with success
      const result: SpecialistResult = {
        success: true,
        output,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
        traceRef: `trace:${trace.traceId}`,
      };

      const meta: RunMeta = {
        durationMs,
        tokenUsage: {
          prompt: Math.floor(state.tokensUsed * 0.4), // Rough estimate (40% prompt, 60% completion)
          completion: Math.floor(state.tokensUsed * 0.6),
        },
        toolCalls: state.steps.reduce((sum, step) => sum + (step.toolCalls?.length || 0), 0),
        modelTier: config.llm.tier,
      };

      return {
        ok: true,
        result,
        meta,
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error('Specialist execution failed', new Error(
        `[${config.id}] ${errorMessage} (steps: ${state.currentStep}, duration: ${durationMs}ms)`
      ));

      // Complete tool trace even on error
      await this.toolTraceStore.complete(trace.traceId);

      // Phase 3: Classify error and build failure report
      const failure: FailureReport = {
        kind: this.classifyError(error),
        message: errorMessage,
        lastToolCalls: this.getLastToolCalls(state.steps, 5),
        suggestedRetry: this.shouldRetry(error),
      };

      // Phase 3: Build partial result (preserve work done so far!)
      const partial: SpecialistResult = {
        success: false,
        output: null,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
        error: errorMessage,
        traceRef: `trace:${trace.traceId}`,
      };

      const meta: RunMeta = {
        durationMs,
        tokenUsage: {
          prompt: Math.floor(state.tokensUsed * 0.4),
          completion: Math.floor(state.tokensUsed * 0.6),
        },
        toolCalls: state.steps.reduce((sum, step) => sum + (step.toolCalls?.length || 0), 0),
        modelTier: config.llm.tier,
      };

      // Phase 3: Return SpecialistOutcome with failure + partial result
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
   */
  private buildSystemPrompt(
    config: SpecialistConfigV1,
    task: string,
    inputData?: unknown
  ): string {
    let prompt = '';

    // Add static context if provided
    if (config.context?.static?.system) {
      prompt += config.context.static.system + '\n\n';
    }

    // Add capabilities
    if (config.capabilities && config.capabilities.length > 0) {
      prompt += `## Your Capabilities\n`;
      for (const capability of config.capabilities) {
        prompt += `- ${capability}\n`;
      }
      prompt += '\n';
    }

    // Add constraints
    if (config.constraints && config.constraints.length > 0) {
      prompt += `## Constraints\n`;
      for (const constraint of config.constraints) {
        prompt += `${constraint}\n`;
      }
      prompt += '\n';
    }

    // Add output schema requirement
    if (config.output?.schema) {
      prompt += `## CRITICAL: Required Output Format\n\n`;
      prompt += `When you complete the task, you MUST return your final answer as a JSON code block.\n`;
      prompt += `The JSON must match this exact schema:\n\n`;
      prompt += `\`\`\`json\n`;
      prompt += JSON.stringify(config.output.schema, null, 2);
      prompt += `\n\`\`\`\n\n`;
      prompt += `**Rules:**\n`;
      prompt += `1. Return ONLY valid JSON in a markdown code block: \`\`\`json ... \`\`\`\n`;
      prompt += `2. Include ALL required fields from the schema\n`;
      prompt += `3. Do NOT add any text before or after the JSON block\n`;
      prompt += `4. When done, say "TASK COMPLETE" followed by the JSON block\n\n`;
    }

    return prompt;
  }

  /**
   * Build system prompt with ExecutionContext (V2)
   *
   * Loads context.md and examples.yml from specialist directory.
   * Uses cache with 1 hour TTL for static files.
   *
   * @param config - Specialist configuration
   * @param task - Task description
   * @param executionContext - Execution context from orchestrator
   * @returns System prompt with full context
   */
  private async buildSystemPromptWithContext(
    config: SpecialistConfigV1,
    task: string,
    executionContext?: ExecutionContext
  ): Promise<string> {
    let prompt = '';

    // Add static context from config (backward compatibility)
    if (config.context?.static?.system) {
      prompt += config.context.static.system + '\n\n';
    }

    // V2: Load context.md from specialist directory
    const contextMd = await this.loadContextMarkdown(config.id);
    if (contextMd) {
      // V2.5: Adapt context size based on model tier
      const adaptedContext = this.adaptContextForTier(contextMd, config.llm.tier);
      prompt += `# Specialist Context\n\n${adaptedContext}\n\n`;
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

      prompt += '\n';

      // Add findings from previous specialists
      if (executionContext.findings && executionContext.findings.length > 0) {
        prompt += `## Findings from Previous Specialists\n\n`;
        for (const finding of executionContext.findings) {
          prompt += `- ${finding}\n`;
        }
        prompt += '\n';
      }

      // Add available files
      if (executionContext.availableFiles.created.length > 0) {
        prompt += `## Files Created by Previous Specialists\n\n`;
        for (const file of executionContext.availableFiles.created) {
          prompt += `- ${file}\n`;
        }
        prompt += '\n';
      }

      if (executionContext.availableFiles.modified.length > 0) {
        prompt += `## Files Modified by Previous Specialists\n\n`;
        for (const file of executionContext.availableFiles.modified) {
          prompt += `- ${file}\n`;
        }
        prompt += '\n';
      }
    }

    // V2: Load examples.yml from specialist directory
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
      prompt += '\n';
    }

    // Add constraints
    if (config.constraints && config.constraints.length > 0) {
      prompt += `## Constraints\n`;
      for (const constraint of config.constraints) {
        prompt += `${constraint}\n`;
      }
      prompt += '\n';
    }

    // Add output schema requirement
    if (config.output?.schema) {
      prompt += `## CRITICAL: Required Output Format\n\n`;
      prompt += `When you complete the task, you MUST return your final answer as a JSON code block.\n`;
      prompt += `The JSON must match this exact schema:\n\n`;
      prompt += `\`\`\`json\n`;
      prompt += JSON.stringify(config.output.schema, null, 2);
      prompt += `\n\`\`\`\n\n`;
      prompt += `**Rules:**\n`;
      prompt += `1. Return ONLY valid JSON in a markdown code block: \`\`\`json ... \`\`\`\n`;
      prompt += `2. Include ALL required fields from the schema\n`;
      prompt += `3. Do NOT add any text before or after the JSON block\n`;
      prompt += `4. When done, say "TASK COMPLETE" followed by the JSON block\n\n`;
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
  private adaptContextForTier(contextMd: string, tier: 'small' | 'medium' | 'large'): string {
    const limits = {
      small: 2048,      // 2KB (~500 tokens)
      medium: 5120,     // 5KB (~1200 tokens)
      large: Infinity,  // No limit
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
   * Load context.md for specialist (V2)
   *
   * Cached with 1 hour TTL using useCache() from SDK.
   *
   * @param specialistId - Specialist ID
   * @returns Context markdown content or undefined
   */
  private async loadContextMarkdown(specialistId: string): Promise<string | undefined> {
    const cache = useCache();
    const cacheKey = `specialist:${specialistId}:context`;

    // Try cache first
    if (cache) {
      const cached = await cache.get<string>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Load from filesystem
    try {
      const contextPath = path.join(process.cwd(), '.kb/specialists', specialistId, 'context.md');
      const content = await fs.readFile(contextPath, 'utf-8');

      // Cache for 1 hour (3600000ms)
      if (cache) {
        await cache.set(cacheKey, content, 3600000);
      }

      return content;
    } catch (error) {
      // File not found or read error - not critical
      this.ctx.platform.logger.debug('Failed to load context.md', {
        specialistId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Load examples.yml for specialist (V2)
   *
   * Cached with 1 hour TTL using useCache() from SDK.
   *
   * @param specialistId - Specialist ID
   * @returns Array of examples or undefined
   */
  private async loadExamples(specialistId: string): Promise<Array<{ task: string; approach: string; outcome: string }> | undefined> {
    const cache = useCache();
    const cacheKey = `specialist:${specialistId}:examples`;

    // Try cache first
    if (cache) {
      const cached = await cache.get<Array<{ task: string; approach: string; outcome: string }>>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Load from filesystem
    try {
      const examplesPath = path.join(process.cwd(), '.kb/specialists', specialistId, 'examples.yml');
      const content = await fs.readFile(examplesPath, 'utf-8');

      // Simple YAML parsing (examples is an array)
      const examples = this.parseExamplesYaml(content);

      // Cache for 1 hour (3600000ms)
      if (cache) {
        await cache.set(cacheKey, examples, 3600000);
      }

      return examples;
    } catch (error) {
      // File not found or read error - not critical
      this.ctx.platform.logger.debug('Failed to load examples.yml', {
        specialistId,
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
  private parseExamplesYaml(content: string): Array<{ task: string; approach: string; outcome: string }> {
    const examples: Array<{ task: string; approach: string; outcome: string }> = [];

    // Simple regex-based parsing for our specific format
    const exampleBlocks = content.split(/^  - task:/m).slice(1);

    for (const block of exampleBlocks) {
      const taskMatch = block.match(/^\s*"([^"]+)"/);
      const approachMatch = block.match(/approach:\s*\|\s*\n((?:(?:      .+|\s*)\n)+)/);
      const outcomeMatch = block.match(/outcome:\s*"([^"]+)"/);

      if (taskMatch?.[1] && approachMatch?.[1] && outcomeMatch?.[1]) {
        examples.push({
          task: taskMatch[1],
          approach: approachMatch[1].replace(/^      /gm, '').trim(),
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
  private classifyError(error: unknown): FailureReport['kind'] {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
      if (msg.includes('tool') || msg.includes('execution failed')) return 'tool_error';
      if (msg.includes('validation') || msg.includes('schema')) return 'validation_failed';
      if (msg.includes('stuck') || msg.includes('loop') || msg.includes('infinite')) return 'stuck';
      if (msg.includes('policy') || msg.includes('denied') || msg.includes('budget')) return 'policy_denied';
    }

    return 'unknown';
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
    if (kind === 'validation_failed') return false;
    if (kind === 'policy_denied') return false;

    // Retry transient failures
    if (kind === 'timeout') return true;
    if (kind === 'tool_error') return true;
    if (kind === 'stuck') return true;

    // Default: retry unknown errors
    return true;
  }

  /**
   * Get last N tool calls for debugging (Phase 3)
   */
  private getLastToolCalls(steps: AgentExecutionStep[], count: number): Array<{ tool: string; args: unknown; error?: string }> {
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
   * Check if specialist indicated completion
   */
  private isComplete(message: string): boolean {
    const lowerMessage = message.toLowerCase();

    // Check for explicit completion signals
    const hasCompletionSignal = (
      lowerMessage.includes('task complete') ||
      lowerMessage.includes('done') ||
      lowerMessage.includes('finished') ||
      lowerMessage.includes('completed')
    );

    // Check for JSON output (indicates structured result ready)
    const hasJsonOutput = message.includes('```json') || /\{[\s\S]*"summary"[\s\S]*\}/.test(message);

    return hasCompletionSignal || hasJsonOutput;
  }

  /**
   * Extract structured output from message
   */
  private extractOutput(message: string, config: SpecialistConfigV1): unknown {
    this.ctx.platform.logger.debug('Extracting output from specialist response', {
      messageLength: message.length,
      hasSchema: !!config.output?.schema,
    });

    // Strategy 1: Try to extract from ```json ... ``` code block
    const jsonBlockMatch = message.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        this.ctx.platform.logger.debug('Extracted output from JSON code block', { parsed });
        return parsed;
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse JSON from code block', {
          error: error instanceof Error ? error.message : String(error),
          content: jsonBlockMatch[1].slice(0, 200),
        });
      }
    }

    // Strategy 2: Try to extract any JSON object (greedy match from last {)
    const lines = message.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && line.trim().startsWith('{')) {
        // Found potential JSON start, try to parse from here to end
        const jsonCandidate = lines.slice(i).join('\n');
        try {
          const parsed = JSON.parse(jsonCandidate);
          this.ctx.platform.logger.debug('Extracted output from JSON object', { parsed });
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
        this.ctx.platform.logger.debug('Extracted output from inline JSON', { parsed });
        return parsed;
      } catch (error) {
        this.ctx.platform.logger.warn('Failed to parse inline JSON', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: Wrap raw message in summary field
    this.ctx.platform.logger.warn('Could not extract structured output, using fallback', {
      messageSample: message.slice(0, 200),
    });
    return {
      summary: message || '(empty response)',
      _warning: 'Output was not in expected JSON format',
    };
  }
}
