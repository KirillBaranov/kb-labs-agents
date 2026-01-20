/**
 * @module @kb-labs/adaptive-orchestrator/agent-execution-helper
 * Helper for executing agent agents with full tool integration.
 *
 * Uses AgentExecutor for real agent execution with tools.
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type { Subtask, SubtaskResult } from './types.js';
import type { ToolCallRecord, LLMInteraction } from './history-types.js';
import type { LLMTier } from '@kb-labs/sdk';
import type { AgentContext, AgentExecutionStep } from '@kb-labs/agent-contracts';
import { AgentExecutor } from '@kb-labs/agent-core';
import { ToolDiscoverer } from '@kb-labs/agent-core';
import { AgentRegistry } from '@kb-labs/agent-core';

/**
 * Execute subtask with an agent agent using full AgentExecutor.
 *
 * This implementation:
 * - Loads agent config and context using AgentRegistry
 * - Discovers and loads tools using ToolDiscoverer
 * - Executes with full AgentExecutor (supports tool calling)
 * - Extracts tool calls and LLM interactions from execution steps
 * - Records complete execution history
 */
export async function executeWithAgent(
  ctx: PluginContextV3,
  subtask: Subtask,
  tier: LLMTier
): Promise<{
  result: SubtaskResult;
  toolCalls: ToolCallRecord[];
  llmInteractions: LLMInteraction[];
}> {
  if (!subtask.agentId) {
    throw new Error('Agent ID required for executeWithAgent');
  }

  const logger = ctx.platform.logger;
  logger.debug(`Executing subtask ${subtask.id} with agent: ${subtask.agentId}`);

  const startTime = Date.now();

  try {
    // 1. Load agent configuration and context using AgentRegistry
    const registry = new AgentRegistry(ctx);
    await registry.discover();

    const config = await registry.loadConfig(subtask.agentId);
    const agentContext = await registry.loadContext(subtask.agentId, config);

    // 2. Discover tools using ToolDiscoverer
    const toolDiscoverer = new ToolDiscoverer(ctx);
    const tools = await toolDiscoverer.discover(config.tools || {});

    // 3. Create full agent context with tools
    const fullContext: AgentContext = {
      ...agentContext,
      tools,
    };

    logger.debug(`Agent ${subtask.agentId} loaded with ${tools.length} tools`);

    // 4. Execute agent with AgentExecutor
    const executor = new AgentExecutor(ctx);
    const agentResult = await executor.execute(fullContext, subtask.description);

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // 5. Extract tool calls and LLM interactions from execution steps
    const { toolCalls, llmInteractions } = extractExecutionHistory(
      agentResult.steps || [],
      tier,
      startTime
    );

    // 6. Build SubtaskResult
    const result: SubtaskResult = {
      id: subtask.id,
      status: agentResult.success ? 'success' : 'failed',
      tier,
      agentId: subtask.agentId,
      content: agentResult.result,
      error: agentResult.error?.message,
      tokens: agentResult.totalTokens || 0,
    };

    logger.debug(
      `Agent ${subtask.agentId} completed subtask ${subtask.id} in ${durationMs}ms (${agentResult.totalTokens || 0} tokens, ${toolCalls.length} tool calls)`
    );

    return {
      result,
      toolCalls,
      llmInteractions,
    };
  } catch (error) {
    logger.error(
      `Failed to execute subtask ${subtask.id} with agent ${subtask.agentId}:`,
      error instanceof Error ? error : undefined
    );

    const endTime = Date.now();

    // Return failed result
    return {
      result: {
        id: subtask.id,
        status: 'failed',
        tier,
        agentId: subtask.agentId,
        error: error instanceof Error ? error.message : 'Unknown error',
        tokens: 0,
      },
      toolCalls: [],
      llmInteractions: [],
    };
  }
}

/**
 * Extract tool calls and LLM interactions from agent execution steps.
 *
 * Converts AgentExecutionStep[] to our history format.
 */
function extractExecutionHistory(
  steps: AgentExecutionStep[],
  tier: LLMTier,
  baseTimestamp: number
): {
  toolCalls: ToolCallRecord[];
  llmInteractions: LLMInteraction[];
} {
  const toolCalls: ToolCallRecord[] = [];
  const llmInteractions: LLMInteraction[] = [];

  for (const step of steps) {
    const stepTimestamp = baseTimestamp + (steps.indexOf(step) * 1000); // Estimate timestamp

    // Extract LLM interaction from this step
    if (step.response) {
      llmInteractions.push({
        type: 'chatWithTools', // AgentExecutor uses chat with tools
        tier,
        input: '', // We don't have input in AgentExecutionStep (would need to track separately)
        output: step.response,
        tokens: step.tokensUsed || 0,
        durationMs: step.durationMs || 0,
        timestamp: stepTimestamp,
      });
    }

    // Extract tool calls from this step
    if (step.toolCalls) {
      for (const toolCall of step.toolCalls) {
        toolCalls.push({
          name: toolCall.name,
          input: toolCall.input,
          output: toolCall.success ? toolCall.output : undefined,
          error: toolCall.error,
          durationMs: 0, // Not available in AgentExecutionStep
          timestamp: stepTimestamp,
        });
      }
    }
  }

  return { toolCalls, llmInteractions };
}
