/**
 * @module @kb-labs/agent-tools/quality
 * Tool for requesting revisions to agent output.
 */

import type { LLMTool } from "@kb-labs/core-platform";

/**
 * Revision request.
 */
export interface RevisionRequest {
  /** Subtask ID needing revision */
  subtaskId: string;
  /** Agent to revise */
  agentId: string;
  /** Issues requiring revision */
  issues: string[];
  /** Specific changes requested */
  requestedChanges: string[];
  /** Priority of revision (1-10) */
  priority: number;
  /** Reason for revision */
  reason: string;
}

/**
 * Create LLM tool for requesting output revisions.
 *
 * Asks agent to fix issues or make improvements.
 *
 * @param validSpecialistIds - Array of valid agent IDs
 * @returns LLM tool definition
 */
export function createRequestRevisionTool(
  validSpecialistIds: string[],
): LLMTool {
  return {
    name: "request_revision",
    description: `Request revision to agent output due to issues or needed improvements.

**Available agents:**
${validSpecialistIds.map((id) => `- ${id}`).join("\n")}

**Use this tool when:**
- Validation found issues that need fixing
- Output doesn't fully meet requirements
- Quality improvements are needed
- Changes required based on feedback

**Be specific:**
- Clearly describe each issue
- Provide actionable change requests
- Explain why revision is needed`,

    inputSchema: {
      type: "object",
      required: [
        "subtaskId",
        "agentId",
        "issues",
        "requestedChanges",
        "priority",
        "reason",
      ],
      properties: {
        subtaskId: {
          type: "string",
          description: "ID of subtask needing revision",
          pattern: "^subtask-\\d+$",
        },
        agentId: {
          type: "string",
          description: "Agent to revise",
          enum: validSpecialistIds,
        },
        issues: {
          type: "array",
          description: "Issues found that require revision",
          minItems: 1,
          items: {
            type: "string",
            minLength: 10,
            maxLength: 300,
          },
        },
        requestedChanges: {
          type: "array",
          description: "Specific changes requested",
          minItems: 1,
          items: {
            type: "string",
            minLength: 10,
            maxLength: 300,
          },
        },
        priority: {
          type: "number",
          description:
            "Priority of this revision (10 = critical, 1 = optional)",
          minimum: 1,
          maximum: 10,
        },
        reason: {
          type: "string",
          description: "Clear explanation of why revision is needed",
          minLength: 20,
          maxLength: 500,
        },
      },
    },
  };
}
