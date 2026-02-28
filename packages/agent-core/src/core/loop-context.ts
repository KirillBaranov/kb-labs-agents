/**
 * LoopContextImpl — implements LoopContext from @kb-labs/agent-sdk.
 *
 * Provides the infrastructure primitives that LinearExecutionLoop calls:
 *   - appendMessage()   — the only way to mutate message history
 *   - callLLM()         — LLM call with beforeLLMCall/afterLLMCall middleware
 *   - executeTools()    — tool execution with beforeToolExec/afterToolExec middleware
 *
 * All business logic lives in the ExecutionLoop (LinearExecutionLoop).
 * LoopContextImpl is intentionally stateless between calls.
 */

import type { LLMMessage } from '@kb-labs/sdk';
import type {
  LoopContext,
  LLMCallResult,
  ToolCallInput,
  ToolOutput,
  RunContext,
  LLMCtx,
  ToolExecCtx,
  ControlAction,
} from '@kb-labs/agent-sdk';
import type { ILLM } from '@kb-labs/sdk';
import type { MiddlewarePipeline } from '../middleware/pipeline.js';
import type { ToolExecutor } from './tool-executor.js';

export class LoopContextImpl implements LoopContext {
  readonly run: RunContext;

  constructor(
    run: RunContext,
    private readonly messages: LLMMessage[],   // mutable backing array
    private readonly llm: ILLM,
    private readonly pipeline: MiddlewarePipeline,
    private readonly executor: ToolExecutor,
    private readonly onTokensConsumed: (delta: number) => void,
  ) {
    this.run = run;
  }

  // ── LoopContext API ────────────────────────────────────────────────────────

  appendMessage(message: LLMMessage): void {
    this.messages.push(message);
  }

  async beforeIteration(): Promise<ControlAction> {
    return this.pipeline.beforeIteration(this.run);
  }

  async callLLM(): Promise<LLMCallResult> {
    const llmCtx: LLMCtx = {
      run: this.run,
      messages: [...this.messages],
      tools: this.run.tools,
    };

    // Apply beforeLLMCall middleware patch
    const patch = await this.pipeline.beforeLLMCall(llmCtx);

    const messages = patch.messages ?? llmCtx.messages;
    const tools = patch.tools ?? llmCtx.tools;
    const temperature = patch.temperature;

    // Call LLM
    let rawResponse: Awaited<ReturnType<NonNullable<ILLM['chatWithTools']>>>;
    try {
      rawResponse = await this.llm.chatWithTools!(messages, {
        tools,
        ...(temperature !== undefined ? { temperature } : {}),
      });
    } catch (err) {
      throw err;
    }

    // Convert to LLMCallResult (SDK shape)
    const result: LLMCallResult = {
      content: rawResponse.content,
      toolCalls: (rawResponse.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      })),
      usage: rawResponse.usage
        ? {
            promptTokens: rawResponse.usage.promptTokens,
            completionTokens: rawResponse.usage.completionTokens,
          }
        : undefined,
    };

    // Notify token tracking
    if (result.usage) {
      this.onTokensConsumed(result.usage.promptTokens + result.usage.completionTokens);
    }

    // Append assistant message to history
    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content: rawResponse.content,
      toolCalls: rawResponse.toolCalls,
    };
    this.messages.push(assistantMessage);

    // Run afterLLMCall middleware
    await this.pipeline.afterLLMCall(llmCtx, result);

    return result;
  }

  async executeTools(calls: ToolCallInput[]): Promise<ToolOutput[]> {
    const outputs: ToolOutput[] = [];

    for (const call of calls) {
      const toolCtx: ToolExecCtx = {
        run: this.run,
        toolName: call.name,
        input: call.input,
        iteration: this.run.iteration,
        abortSignal: this.run.abortSignal,
        requestId: this.run.requestId,
      };

      // Check if middleware wants to skip this tool call
      const decision = await this.pipeline.beforeToolExec(toolCtx);
      if (decision === 'skip') {
        outputs.push({
          toolCallId: call.id,
          output: '[skipped by middleware]',
          success: true,
        });
        continue;
      }

      // Execute through ToolExecutor (guards + processors)
      const results = await this.executor.execute([call], this.run);
      const output = results[0] ?? {
        toolCallId: call.id,
        output: 'Tool execution returned no result',
        success: false,
      };
      outputs.push(output);

      // Run afterToolExec middleware
      await this.pipeline.afterToolExec(toolCtx, output);
    }

    // Append tool result messages to history
    for (const out of outputs) {
      this.messages.push({
        role: 'tool',
        content: out.output,
        toolCallId: out.toolCallId,
      });
    }

    return outputs;
  }
}
