/**
 * GET /v1/agents handler
 *
 * Lists all available agents with their metadata
 */

import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import type { ListAgentsRequest, ListAgentsResponse, AgentMetadata } from '@kb-labs/agent-contracts';
import { AgentDiscoverer } from '../core/agent-discoverer.js';

/**
 * List all available agents
 */
export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<ListAgentsRequest, unknown>
  ): Promise<ListAgentsResponse> {
    try {
      const discoverer = new AgentDiscoverer(ctx);
      const agentContexts = await discoverer.discoverAll();

      const agents: AgentMetadata[] = agentContexts.map((agentCtx) => ({
        id: agentCtx.config.id,
        name: agentCtx.config.name,
        description: agentCtx.config.description,
        tools: agentCtx.tools?.map((t) => t.name) ?? [],
      }));

      return {
        agents,
        total: agents.length,
      };
    } catch (error) {
      ctx.logger.error('Failed to list agents', { error });
      return {
        agents: [],
        total: 0,
      };
    }
  },
});
