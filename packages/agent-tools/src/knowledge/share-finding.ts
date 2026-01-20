/**
 * @module @kb-labs/agent-tools/knowledge
 * Tool for sharing discoveries between agents.
 */

import type { LLMTool } from '@kb-labs/core-platform';

/**
 * Finding category.
 */
export type FindingCategory = 'bug' | 'optimization' | 'requirement' | 'constraint' | 'insight';

/**
 * Shared finding.
 */
export interface SharedFinding {
  /** Subtask ID where finding was discovered */
  subtaskId: string;
  /** Agent who discovered this */
  agentId: string;
  /** Category of finding */
  category: FindingCategory;
  /** Finding description */
  description: string;
  /** Impact on plan or execution */
  impact: string;
  /** Which subtasks might be affected */
  affectedSubtasks: string[];
  /** Recommended actions */
  recommendedActions: string[];
}

/**
 * Create LLM tool for sharing findings between agents.
 *
 * Enables Phase 2 adaptive feedback - agents share discoveries
 * that might affect other parts of the plan.
 *
 * @returns LLM tool definition
 */
export function createShareFindingTool(): LLMTool {
  return {
    name: 'share_finding',
    description: `Share an important discovery or finding with the team.

**Use this tool when an agent discovers:**
- Bugs that affect other subtasks
- Optimization opportunities
- New requirements or constraints
- Technical insights that change approach
- Dependencies not identified in initial plan

**Finding categories:**
- bug: Discovered bug or error
- optimization: Performance or quality improvement opportunity
- requirement: New requirement or edge case found
- constraint: Technical limitation or dependency
- insight: Important learning or pattern

**This enables adaptive feedback loop:**
- Findings can trigger plan revisions
- Other agents can adjust approach
- Prevents wasted effort on outdated assumptions`,

    inputSchema: {
      type: 'object',
      required: ['subtaskId', 'agentId', 'category', 'description', 'impact', 'affectedSubtasks', 'recommendedActions'],
      properties: {
        subtaskId: {
          type: 'string',
          description: 'ID of subtask where finding was discovered',
          pattern: '^subtask-\\d+$',
        },
        agentId: {
          type: 'string',
          description: 'Agent who made this discovery',
        },
        category: {
          type: 'string',
          description: 'Category of finding',
          enum: ['bug', 'optimization', 'requirement', 'constraint', 'insight'],
        },
        description: {
          type: 'string',
          description: 'Clear description of what was discovered',
          minLength: 20,
          maxLength: 500,
        },
        impact: {
          type: 'string',
          description: 'How this finding affects the plan or execution',
          minLength: 20,
          maxLength: 300,
        },
        affectedSubtasks: {
          type: 'array',
          description: 'IDs of subtasks that might be affected by this finding',
          items: {
            type: 'string',
            pattern: '^subtask-\\d+$',
          },
        },
        recommendedActions: {
          type: 'array',
          description: 'Recommended actions based on this finding',
          minItems: 1,
          items: {
            type: 'string',
            minLength: 10,
            maxLength: 200,
          },
        },
      },
    },
  };
}
