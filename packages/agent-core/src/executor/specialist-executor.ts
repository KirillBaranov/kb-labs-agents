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
import { useLLM } from '@kb-labs/sdk';
import type { SpecialistConfigV1 } from '@kb-labs/agent-contracts';
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

  constructor(private ctx: PluginContextV3) {
    this.loopDetector = new LoopDetector();
    this.toolExecutor = new ToolExecutor(ctx);
    this.contextCompressor = new ContextCompressor(ctx);
    this.executionMemory = new ExecutionMemory();
  }

  /**
   * Execute a specialist task
   *
   * @param context - Specialist context (config, tools)
   * @param task - Task description from orchestrator
   * @param inputData - Input data matching specialist's input schema
   * @param progressCallback - Optional progress callback
   * @returns Execution result
   */
  async execute(
    context: SpecialistContext,
    task: string,
    inputData?: unknown,
    progressCallback?: AgentProgressCallback
  ): Promise<SpecialistResult> {
    const config = context.config;
    const startTime = Date.now();

    // Initialize tool executor with tools
    this.toolExecutor = new ToolExecutor(this.ctx, { tools: context.tools });
    this.toolExecutor.setAgentId(config.id);

    // Initialize session state manager
    const sessionId = `${config.id}:${Date.now()}`;
    const sessionState = new SessionStateManager(this.ctx, sessionId);

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

    // Build initial system prompt (static context)
    const systemPrompt = this.buildSystemPrompt(config, task, inputData);

    // Add system message
    state.messages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Add user message with task
    state.messages.push({
      role: 'user',
      content: this.buildUserPrompt(task, inputData),
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

        // Check if we should compress context
        if (state.messages.length > 5) {
          const compressed = await this.contextCompressor.compress(
            state.messages,
            task,
            state.specialistId
          );
          state.messages = compressed.compressedMessages;
          state.tokensUsed += compressed.compressedTokens;

          this.ctx.platform.logger.info('Context compressed', {
            originalTokens: compressed.originalTokens,
            compressedTokens: compressed.compressedTokens,
            compressionRatio: compressed.compressionRatio,
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

        // Add assistant message to history
        state.messages.push({
          role: 'assistant',
          content: llmResponse.content || '',
        });

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

          // Add tool result to messages
          state.messages.push({
            role: 'user',
            content: `Tool result (${toolCall.name}):\n${JSON.stringify(result.output, null, 2)}`,
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
            const outputSize = JSON.stringify(result.output).length;
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

      return {
        success: true,
        output,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.ctx.platform.logger.error('Specialist execution failed', new Error(
        `[${config.id}] ${errorMessage} (steps: ${state.currentStep}, duration: ${durationMs}ms)`
      ));

      return {
        success: false,
        output: null,
        steps: state.steps,
        tokensUsed: state.tokensUsed,
        durationMs,
        error: errorMessage,
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
   * Build user prompt with task and input data
   */
  private buildUserPrompt(task: string, inputData?: unknown): string {
    let prompt = `Task: ${task}\n`;

    if (inputData) {
      prompt += `\nInput Data:\n${JSON.stringify(inputData, null, 2)}\n`;
    }

    return prompt;
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
