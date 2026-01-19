/**
 * CLI Command: orchestrator:list
 *
 * List all available specialists with their capabilities and status
 */

import { defineCommand, type CommandResult } from '@kb-labs/sdk';
import type { PluginContextV3 } from '@kb-labs/sdk';
import { SpecialistRegistry } from '@kb-labs/agent-core';
import type { SpecialistMetadata } from '@kb-labs/agent-contracts';

interface OrchestratorListInput {
  flags: {
    json?: boolean;
    verbose?: boolean;
  };
}

interface OrchestratorListOutput {
  success: boolean;
  specialists: SpecialistMetadata[];
  total: number;
  valid: number;
  invalid: number;
}

export default defineCommand<unknown, OrchestratorListInput, OrchestratorListOutput>({
  id: 'orchestrator:list',
  description: 'List all available specialists',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: OrchestratorListInput
    ): Promise<CommandResult<OrchestratorListOutput>> {
      const { json: jsonOutput, verbose } = input.flags;

      try {
        // Create registry and discover specialists
        const registry = new SpecialistRegistry(ctx);
        const specialists = await registry.discover();

        // Calculate stats
        const total = specialists.length;
        const valid = specialists.filter(s => s.valid).length;
        const invalid = specialists.filter(s => !s.valid).length;

        // Output results
        if (jsonOutput) {
          // JSON output for programmatic use
          const output = {
            success: true,
            specialists,
            total,
            valid,
            invalid,
          };
          ctx.ui?.write(JSON.stringify(output, null, 2) + '\n');
        } else {
          // Human-readable output using ctx.ui
          const sections: Array<{ header?: string; items: string[] }> = [];

          // Summary section
          sections.push({
            header: 'Summary',
            items: [
              `Total: ${total}`,
              `Valid: ${ctx.ui?.symbols.success} ${valid}`,
              `Invalid: ${ctx.ui?.symbols.error} ${invalid}`,
            ],
          });

          // Specialists section
          if (specialists.length === 0) {
            sections.push({
              header: 'Specialists',
              items: [
                'No specialists found',
                'Directory: .kb/specialists/',
                'Create specialists with: mkdir -p .kb/specialists/<name>',
              ],
            });
          } else {
            const specialistItems: string[] = [];

            for (const s of specialists) {
              const status = s.valid
                ? ctx.ui?.symbols.success
                : ctx.ui?.symbols.error;

              const nameFormatted = ctx.ui?.colors.success(s.id);
              specialistItems.push(`${status} ${nameFormatted}`);
              specialistItems.push(`   Name: ${s.name}`);
              specialistItems.push(`   Description: ${s.description || '(no description)'}`);
              specialistItems.push(`   Tier: ${s.tier}`);

              if (s.capabilities && s.capabilities.length > 0) {
                specialistItems.push(`   Capabilities: ${s.capabilities.join(', ')}`);
              }

              if (!s.valid && s.error) {
                specialistItems.push(`   ${ctx.ui?.symbols.warning}  Error: ${s.error}`);
              }

              if (verbose) {
                specialistItems.push(`   Path: ${s.path}`);
                specialistItems.push(`   Config: ${s.configPath}`);
              }

              specialistItems.push(''); // Empty line between specialists
            }

            sections.push({
              header: 'Specialists',
              items: specialistItems,
            });
          }

          // Use ctx.ui.success for formatted output
          ctx.ui?.success('Available Specialists', {
            sections,
          });
        }

        return {
          exitCode: 0,
          result: {
            success: true,
            specialists,
            total,
            valid,
            invalid,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (jsonOutput) {
          ctx.ui?.write(JSON.stringify({ success: false, error: errorMessage }, null, 2) + '\n');
        } else {
          ctx.ui?.error(new Error(errorMessage));
        }

        ctx.platform.logger.error('Orchestrator list command failed', new Error(errorMessage));

        return {
          exitCode: 1,
          result: {
            success: false,
            specialists: [],
            total: 0,
            valid: 0,
            invalid: 0,
          },
        };
      }
    },
  },
});
