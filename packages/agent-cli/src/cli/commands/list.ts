/**
 * Agent List Command
 *
 * List all discovered agent definitions from .kb/agents/
 */

import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
import { AgentRegistry } from '@kb-labs/agent-core';

interface ListFlags {
  json?: boolean;
}

interface ListInput {
  argv: string[];
  flags: ListFlags;
}

interface ListResult {
  agents: Array<{
    id: string;
    name: string;
    description?: string;
    tools?: {
      filesystem?: boolean;
      shell?: boolean;
      kbLabs?: string[];
    };
  }>;
  count: number;
}

/**
 * List all agent definitions
 */
export default defineCommand<unknown, ListInput, ListResult>({
  id: 'agent:list',
  description: 'List all discovered agent definitions',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: ListInput
    ): Promise<CommandResult<ListResult>> {
      const registry = new AgentRegistry(ctx);

      try {
        // Discover agents
        const agentMetas = await registry.discover();

        // Load config for each valid agent
        const agents = await Promise.all(
          agentMetas.filter(a => a.valid).map(async (agent) => {
            try {
              const config = await registry.loadConfig(agent.id);
              return {
                id: agent.id,
                name: agent.name,
                description: config.description,
                tools: {
                  filesystem: config.tools?.filesystem?.enabled,
                  shell: config.tools?.shell?.enabled,
                  kbLabs: config.tools?.kbLabs?.allow,
                },
              };
            } catch (error) {
              // Skip agents that fail to load
              return null;
            }
          })
        );

        const result: ListResult = {
          agents: agents.filter(a => a !== null) as ListResult['agents'],
          count: agentMetas.filter(a => a.valid).length,
        };

        if (input.flags.json) {
          ctx.ui.json(result);
        } else {
          if (result.count === 0) {
            ctx.ui.warn('No agents found', {
              title: 'Agent List',
              sections: [
                {
                  header: 'Getting Started',
                  items: [
                    'Initialize agents directory: kb agent:init',
                    'Create your first agent config in .kb/agents/',
                  ],
                },
              ],
            });
          } else {
            const sections = result.agents.map((agent) => {
              const tools: string[] = [];
              if (agent.tools?.filesystem) tools.push('filesystem');
              if (agent.tools?.shell) tools.push('shell');
              if (agent.tools?.kbLabs) tools.push(`kb-labs: ${agent.tools.kbLabs.join(', ')}`);

              return {
                header: `${agent.name} (${agent.id})`,
                items: [
                  agent.description || 'No description',
                  '',
                  `Tools: ${tools.length > 0 ? tools.join(', ') : 'none'}`,
                ],
              };
            });

            ctx.ui.success(`Found ${result.count} agent(s)`, {
              title: 'Agent List',
              sections,
            });
          }
        }

        return {
          exitCode: 0,
          result,
        };
      } catch (error) {
        ctx.ui.error(error instanceof Error ? error.message : String(error), {
          title: 'List Failed',
        });

        return {
          exitCode: 1,
          result: {
            agents: [],
            count: 0,
          },
        };
      }
    },
  },
});
