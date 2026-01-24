/**
 * Agent Init Command
 *
 * Initialize .kb/agents/ directory for agent definitions
 */

import {
  defineCommand,
  type PluginContextV3,
  type CommandResult,
} from "@kb-labs/sdk";
import { AgentRegistry } from "@kb-labs/agent-core";

interface InitFlags {
  force?: boolean;
}

interface InitInput {
  argv: string[];
  flags: InitFlags;
}

interface InitResult {
  initialized: boolean;
  path: string;
}

/**
 * Initialize agent directory
 */
export default defineCommand<unknown, InitInput, InitResult>({
  id: "agent:init",
  description: "Initialize .kb/agents/ directory for agent definitions",

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
    ): Promise<CommandResult<InitResult>> {
      const registry = new AgentRegistry(ctx);

      try {
        // Initialize registry
        await registry.init();

        const agentsDir = ".kb/agents";

        ctx.ui.success("Agent directory initialized", {
          title: "Agent Init",
          sections: [
            {
              header: "Details",
              items: [
                `Path: ${agentsDir}`,
                "You can now create agent definitions in this directory.",
                "",
                "Next steps:",
                '  1. Create agent config: echo "..." > .kb/agents/my-agent.yml',
                "  2. List agents: kb agent:list",
                '  3. Run agent: kb agent:run --agent-id my-agent --task "..."',
              ],
            },
          ],
        });

        return {
          exitCode: 0,
          result: {
            initialized: true,
            path: agentsDir,
          },
        };
      } catch (error) {
        ctx.ui.error(error instanceof Error ? error.message : String(error), {
          title: "Init Failed",
        });

        return {
          exitCode: 1,
          result: {
            initialized: false,
            path: "",
          },
        };
      }
    },
  },
});
