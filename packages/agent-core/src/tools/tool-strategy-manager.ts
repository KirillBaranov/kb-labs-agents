/**
 * Tool Strategy Manager
 *
 * Manages tool availability based on strategy configuration.
 * Supports prioritized, gated, and unrestricted modes.
 */

import type { PluginContextV3 } from '@kb-labs/sdk';
import type {
  ToolStrategyConfig,
  ToolGroup,
  ToolExecutionState,
  ToolAvailability,
  ToolDefinition,
} from '@kb-labs/agent-contracts';

/**
 * Tool Strategy Manager
 *
 * Responsibilities:
 * - Track which tool groups have been used
 * - Determine tool availability based on strategy
 * - Generate hints for LLM system prompt
 * - Unlock gated tool groups when conditions are met
 */
export class ToolStrategyManager {
  private state: ToolExecutionState;
  private groupsByName: Map<string, ToolGroup>;
  private toolToGroup: Map<string, ToolGroup>;

  constructor(
    private ctx: PluginContextV3,
    private config: ToolStrategyConfig
  ) {
    // Initialize state
    this.state = {
      usedGroups: new Set(),
      toolCalls: [],
      unlockedGroups: new Set(),
    };

    // Index groups by name
    this.groupsByName = new Map();
    this.toolToGroup = new Map();

    if (config.groups) {
      for (const group of config.groups) {
        this.groupsByName.set(group.name, group);

        // Map tools to groups (expand patterns later)
        for (const toolPattern of group.tools) {
          // For exact tool names, map directly
          if (!toolPattern.includes('*')) {
            this.toolToGroup.set(toolPattern, group);
          }
        }

        // Auto-unlock groups without unlockAfter in gated mode
        if (config.strategy === 'gated' && !group.unlockAfter) {
          this.state.unlockedGroups.add(group.name);
        }
      }
    }

    // In non-gated modes, all groups are unlocked
    if (config.strategy !== 'gated') {
      for (const group of config.groups || []) {
        this.state.unlockedGroups.add(group.name);
      }
    }
  }

  /**
   * Check if a tool is available
   */
  checkAvailability(toolName: string): ToolAvailability {
    const group = this.findGroupForTool(toolName);

    // If no groups configured, tool is available
    if (!group) {
      return { available: true };
    }

    // Check if group is unlocked
    if (!this.state.unlockedGroups.has(group.name)) {
      const unlockAfter = group.unlockAfter;
      const prerequisiteGroup = unlockAfter ? this.groupsByName.get(unlockAfter) : undefined;

      return {
        available: false,
        reason: `Tool "${toolName}" is in group "${group.name}" which requires using "${unlockAfter}" group first`,
        hint: prerequisiteGroup?.hints?.[0] || `Try using tools from "${unlockAfter}" group first`,
        group: group.name,
      };
    }

    return {
      available: true,
      group: group.name,
      hint: group.hints?.[0],
    };
  }

  /**
   * Record a tool call and potentially unlock new groups
   */
  recordToolCall(toolName: string, confidence?: number): void {
    const group = this.findGroupForTool(toolName);
    const groupName = group?.name || 'unknown';

    // Record the call
    this.state.toolCalls.push({
      tool: toolName,
      group: groupName,
      timestamp: Date.now(),
      confidence,
    });

    // Mark group as used
    if (group) {
      this.state.usedGroups.add(group.name);
    }

    // Check if we should unlock any gated groups
    if (this.config.strategy === 'gated' && this.config.groups) {
      for (const g of this.config.groups) {
        if (
          !this.state.unlockedGroups.has(g.name) &&
          g.unlockAfter &&
          this.state.usedGroups.has(g.unlockAfter)
        ) {
          // Check confidence threshold if specified
          if (g.unlockWhenConfidenceBelow !== undefined && confidence !== undefined) {
            if (confidence < g.unlockWhenConfidenceBelow) {
              this.state.unlockedGroups.add(g.name);
              this.ctx.platform.logger.info('Unlocked tool group due to low confidence', {
                group: g.name,
                confidence,
                threshold: g.unlockWhenConfidenceBelow,
              });
            }
          } else {
            // No confidence check, unlock immediately
            this.state.unlockedGroups.add(g.name);
            this.ctx.platform.logger.info('Unlocked tool group', {
              group: g.name,
              triggeredBy: g.unlockAfter,
            });
          }
        }
      }
    }
  }

  /**
   * Generate hints for LLM system prompt based on strategy
   */
  generateSystemPromptHints(): string {
    if (this.config.strategy === 'unrestricted' || !this.config.groups) {
      return '';
    }

    // Sort groups by priority
    const sortedGroups = [...this.config.groups].sort((a, b) => a.priority - b.priority);

    const lines: string[] = ['## Tool Usage Strategy', ''];

    if (this.config.strategy === 'prioritized') {
      lines.push('Use tools in priority order. Try higher priority groups first:');
      lines.push('');
    } else if (this.config.strategy === 'gated') {
      lines.push('Some tool groups are gated. You must use prerequisite groups first:');
      lines.push('');
    }

    for (const group of sortedGroups) {
      const locked = !this.state.unlockedGroups.has(group.name);
      const lockIcon = locked ? '🔒' : '✅';

      lines.push(`### ${lockIcon} ${group.name} (Priority ${group.priority})`);
      lines.push(`Tools: ${group.tools.join(', ')}`);

      if (group.hints && group.hints.length > 0) {
        for (const hint of group.hints) {
          lines.push(`- ${hint}`);
        }
      }

      if (locked && group.unlockAfter) {
        lines.push(`⚠️ Locked: Use "${group.unlockAfter}" group first to unlock`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Filter tools based on strategy (remove unavailable tools from list)
   *
   * In gated mode, locked tools are excluded from the list entirely.
   * In prioritized mode, all tools are available but ordered by priority.
   */
  filterAvailableTools(tools: ToolDefinition[]): ToolDefinition[] {
    if (this.config.strategy === 'unrestricted') {
      return tools;
    }

    if (this.config.strategy === 'gated') {
      // Filter out tools from locked groups
      return tools.filter((tool) => {
        const availability = this.checkAvailability(tool.name);
        return availability.available;
      });
    }

    // For prioritized mode, sort by group priority
    return [...tools].sort((a, b) => {
      const groupA = this.findGroupForTool(a.name);
      const groupB = this.findGroupForTool(b.name);
      const priorityA = groupA?.priority ?? 999;
      const priorityB = groupB?.priority ?? 999;
      return priorityA - priorityB;
    });
  }

  /**
   * Get current execution state
   */
  getState(): ToolExecutionState {
    return {
      usedGroups: new Set(this.state.usedGroups),
      toolCalls: [...this.state.toolCalls],
      unlockedGroups: new Set(this.state.unlockedGroups),
    };
  }

  /**
   * Reset state (for new execution)
   */
  reset(): void {
    this.state = {
      usedGroups: new Set(),
      toolCalls: [],
      unlockedGroups: new Set(),
    };

    // Re-initialize unlocked groups
    if (this.config.groups) {
      for (const group of this.config.groups) {
        if (this.config.strategy !== 'gated' || !group.unlockAfter) {
          this.state.unlockedGroups.add(group.name);
        }
      }
    }
  }

  /**
   * Find which group a tool belongs to
   */
  private findGroupForTool(toolName: string): ToolGroup | undefined {
    // Check exact match first
    const exactMatch = this.toolToGroup.get(toolName);
    if (exactMatch) {
      return exactMatch;
    }

    // Check pattern matches
    if (this.config.groups) {
      for (const group of this.config.groups) {
        for (const pattern of group.tools) {
          if (this.matchesPattern(toolName, pattern)) {
            return group;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Match tool name against pattern (supports wildcards)
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    if (!pattern.includes('*')) {
      return toolName === pattern;
    }

    // Convert glob to regex
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
  }
}
