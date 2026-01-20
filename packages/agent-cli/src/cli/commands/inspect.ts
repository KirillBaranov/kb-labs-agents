/**
 * Agent Inspect Command
 *
 * Shows the full agent configuration as it will be sent to the LLM:
 * - System prompt
 * - Available tools (including submit_result)
 * - Output schema
 * - Limits and configuration
 */

import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';
import { AgentRegistry } from '@kb-labs/agent-core';
import { buildOutputTool, usesStructuredOutput, getOutputTypeName } from '@kb-labs/agent-core';

interface InspectFlags {
  agentId: string;
}

interface InspectInput {
  argv: string[];
  flags: InspectFlags;
}

interface InspectResult {
  agentId: string;
  name: string;
  config: Record<string, any>;
}

/**
 * Inspect agent configuration
 */
export const inspectCommand = defineCommand<unknown, InspectInput, InspectResult>({
  id: 'agent:inspect',
  description: 'Inspect agent configuration (tools, prompt, output schema)',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: InspectInput
    ): Promise<CommandResult<InspectResult>> {
      const { agentId } = input.flags;

      // Load agent configuration
      const registry = new AgentRegistry(ctx);

      try {
        // Discover and load agent
        const agentMetas = await registry.discover();
        const agentMeta = agentMetas.find(a => a.id === agentId);

        if (!agentMeta) {
          const available = agentMetas.map(a => a.id).join(', ');
          throw new Error(`Agent "${agentId}" not found. Available agents: ${available}`);
        }

        const config = await registry.load(agentId);

        // Build console output
        console.log(`\n┌── Agent: ${config.name} (${config.id}) ───`);
        console.log(`│ ${config.description}`);
        console.log(`└───────────────────────────────────────\n`);

        // 1. LLM Configuration
        console.log('📊 LLM Configuration:');
        console.log(`  Tier: ${config.llm.tier}`);
        console.log(`  Temperature: ${config.llm.temperature}`);
        console.log(`  Max Tokens: ${config.llm.maxTokens}\n`);

        // 2. Limits
        console.log('⚡ Execution Limits:');
        console.log(`  Max Steps: ${config.limits.maxSteps}`);
        console.log(`  Max Tool Calls: ${config.limits.maxToolCalls}`);
        console.log(`  Timeout: ${config.limits.timeoutMs}ms`);
        console.log(`  Forced Reasoning Interval: ${config.limits.forcedReasoningInterval}\n`);

        // 3. Tools
        console.log('🛠️  Available Tools:');

        // Built-in tools
        const builtInTools: string[] = [];
        if (config.tools.builtIn?.fs) {
          builtInTools.push('fs:read', 'fs:write', 'fs:edit', 'fs:list', 'fs:search');
        }
        if (config.tools.builtIn?.code) {
          builtInTools.push('code:analyze', 'code:search');
        }

        // KB Labs tools (from permissions)
        const kbLabsTools = config.tools.permissions?.kbLabs?.allow || [];

        // Output tool (submit_result)
        const outputTool = buildOutputTool(config);
        const hasStructuredOutput = usesStructuredOutput(config);

        console.log('  Built-in:');
        builtInTools.forEach((tool: string) => {
          console.log(`    ✓ ${tool}`);
        });

        if (kbLabsTools.length > 0) {
          console.log('\n  KB Labs:');
          kbLabsTools.forEach((tool: string) => {
            console.log(`    ✓ ${tool}`);
          });
        }

        if (outputTool) {
          console.log('\n  Output:');
          console.log(`    ✓ submit_result (structured output)`);
        }

        console.log(`\n  Total: ${builtInTools.length + kbLabsTools.length + (outputTool ? 1 : 0)} tools\n`);

        // 4. Output Schema
        console.log('📤 Output Mode:');
        if (hasStructuredOutput) {
          console.log(`  ✓ Structured output via submit_result()`);
          console.log(`  Type: ${getOutputTypeName(config)}`);

          if (config.output?.schema) {
            const schema = config.output.schema as any;
            console.log('\n  Required fields:');
            if (schema.required && Array.isArray(schema.required)) {
              schema.required.forEach((field: string) => {
                const fieldSchema = schema.properties?.[field];
                const fieldType = fieldSchema?.type || 'unknown';
                const fieldDesc = fieldSchema?.description || '';
                console.log(`    • ${field}: ${fieldType} ${fieldDesc ? `- ${fieldDesc}` : ''}`);
              });
            }
          }
        } else {
          console.log(`  ⚠ Legacy text-based output (no schema)`);
        }
        console.log();

        // 5. System Prompt
        console.log('💬 System Prompt:');

        const promptToShow = config.context?.static?.system || '';
        const lines = promptToShow.split('\n');
        const displayLines = lines.slice(0, 15);
        const truncated = lines.length > 15;

        console.log('─'.repeat(60));
        displayLines.forEach((line: string) => {
          console.log(`  ${line}`);
        });
        if (truncated) {
          console.log(`  ... (${lines.length - 15} more lines)`);
        }
        console.log('─'.repeat(60));
        console.log();

        // 6. Tool Description for submit_result (if exists)
        if (outputTool) {
          console.log('🎯 submit_result Tool Description:');
          console.log('─'.repeat(60));
          const desc = outputTool.definition.description;
          desc.split('\n').forEach((line: string) => {
            console.log(`  ${line}`);
          });
          console.log('─'.repeat(60));
          console.log();
        }

        // 7. Capabilities
        if (config.capabilities && config.capabilities.length > 0) {
          console.log('🎓 Capabilities:');
          config.capabilities.forEach((cap: string) => {
            console.log(`  ✓ ${cap}`);
          });
          console.log();
        }

        // 8. Constraints
        if (config.constraints && config.constraints.length > 0) {
          console.log('⚠️  Constraints:');
          config.constraints.forEach((constraint: string) => {
            console.log(`  ! ${constraint}`);
          });
          console.log();
        }

        console.log('✅ Inspection complete\n');

        return {
          exitCode: 0,
          result: {
            agentId: config.id,
            name: config.name,
            config: {
              llm: config.llm,
              limits: config.limits,
              toolsCount: builtInTools.length + kbLabsTools.length + (outputTool ? 1 : 0),
              hasStructuredOutput,
            },
          },
        };
      } catch (error) {
        ctx.ui.error(error instanceof Error ? error.message : String(error), {
          title: 'Inspect Failed',
        });

        return {
          exitCode: 1,
          result: {
            agentId: '',
            name: '',
            config: {},
          },
        };
      }
    },
  },
});

export default inspectCommand;
