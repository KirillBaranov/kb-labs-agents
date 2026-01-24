/**
 * @module @kb-labs/agent-tools/knowledge
 * Tool for requesting context from previous agents.
 */

import type { LLMTool } from "@kb-labs/core-platform";

/**
 * Context request.
 */
export interface ContextRequest {
  /** Current subtask ID */
  subtaskId: string;
  /** Agent requesting context */
  requesterId: string;
  /** Subtask ID to get context from */
  sourceSubtaskId: string;
  /** Agent to request from */
  sourceSpecialistId: string;
  /** Specific questions or information needed */
  questions: string[];
  /** Why this context is needed */
  reason: string;
}

/**
 * Create LLM tool for requesting context from previous agents.
 *
 * Enables agents to ask questions about work done by others,
 * supporting knowledge transfer and informed decision-making.
 *
 * @returns LLM tool definition
 */
export function createRequestContextTool(): LLMTool {
  return {
    name: "request_context",
    description: `Request additional context or information from a previous agent.

**Use this tool when:**
- Need to understand previous agent's decisions
- Require details not captured in deliverables
- Want to clarify assumptions or approach
- Need to understand why something was done a certain way
- Building on previous work and need more context

**Example scenarios:**
- Implementer asks researcher: "Why did you choose library X over Y?"
- Tester asks implementer: "What edge cases did you consider?"
- Reviewer asks implementer: "What were the architectural tradeoffs?"

**Benefits:**
- Prevents misunderstandings
- Enables informed decisions
- Captures tacit knowledge
- Improves collaboration`,

    inputSchema: {
      type: "object",
      required: [
        "subtaskId",
        "requesterId",
        "sourceSubtaskId",
        "sourceSpecialistId",
        "questions",
        "reason",
      ],
      properties: {
        subtaskId: {
          type: "string",
          description: "ID of current subtask",
          pattern: "^subtask-\\d+$",
        },
        requesterId: {
          type: "string",
          description: "Agent requesting context",
        },
        sourceSubtaskId: {
          type: "string",
          description: "Subtask to get context from",
          pattern: "^subtask-\\d+$",
        },
        sourceSpecialistId: {
          type: "string",
          description: "Agent to request context from",
        },
        questions: {
          type: "array",
          description: "Specific questions to ask",
          minItems: 1,
          items: {
            type: "string",
            minLength: 10,
            maxLength: 200,
          },
        },
        reason: {
          type: "string",
          description: "Why this context is needed",
          minLength: 20,
          maxLength: 300,
        },
      },
    },
  };
}
