/**
 * @module @kb-labs/agent-tools/progress
 * Tool for identifying and reporting blockers.
 */

import type { LLMTool } from "@kb-labs/core-platform";

/**
 * Blocker severity levels.
 */
export type BlockerSeverity = "low" | "medium" | "high" | "critical";

/**
 * Blocker type.
 */
export type BlockerType =
  | "dependency"
  | "resource"
  | "technical"
  | "external"
  | "unknown";

/**
 * Blocker identification.
 */
export interface BlockerIdentification {
  /** Subtask ID that is blocked */
  subtaskId: string;
  /** Blocker type */
  type: BlockerType;
  /** Severity level */
  severity: BlockerSeverity;
  /** Description of blocker */
  description: string;
  /** Impact on execution */
  impact: string;
  /** Suggested resolution steps */
  suggestedResolution: string[];
  /** Whether execution can continue without resolving */
  canProceedWithout: boolean;
}

/**
 * Create LLM tool for identifying blockers.
 *
 * Reports obstacles preventing subtask completion.
 *
 * @returns LLM tool definition
 */
export function createIdentifyBlockerTool(): LLMTool {
  return {
    name: "identify_blocker",
    description: `Identify and report a blocker preventing subtask progress.

**Blocker types:**
- dependency: Waiting on another subtask or external dependency
- resource: Missing required resource (file, API key, etc.)
- technical: Technical limitation or bug
- external: Waiting on external service or third party
- unknown: Unclear cause

**Severity levels:**
- low: Minor inconvenience, workarounds exist
- medium: Significant delay, limited workarounds
- high: Major roadblock, no good workarounds
- critical: Complete show-stopper, execution cannot proceed

**Use this tool when:**
- Subtask cannot proceed due to obstacle
- External dependency is unavailable
- Resource or information is missing
- Technical limitation discovered`,

    inputSchema: {
      type: "object",
      required: [
        "subtaskId",
        "type",
        "severity",
        "description",
        "impact",
        "suggestedResolution",
        "canProceedWithout",
      ],
      properties: {
        subtaskId: {
          type: "string",
          description: "ID of blocked subtask",
          pattern: "^subtask-\\d+$",
        },
        type: {
          type: "string",
          description: "Type of blocker",
          enum: ["dependency", "resource", "technical", "external", "unknown"],
        },
        severity: {
          type: "string",
          description: "Severity level",
          enum: ["low", "medium", "high", "critical"],
        },
        description: {
          type: "string",
          description: "Clear description of what is blocking progress",
          minLength: 20,
          maxLength: 500,
        },
        impact: {
          type: "string",
          description: "How this blocker affects execution",
          minLength: 20,
          maxLength: 300,
        },
        suggestedResolution: {
          type: "array",
          description: "Steps to resolve this blocker",
          minItems: 1,
          items: {
            type: "string",
            minLength: 10,
            maxLength: 200,
          },
        },
        canProceedWithout: {
          type: "boolean",
          description:
            "Whether execution can continue without resolving this blocker",
        },
      },
    },
  };
}
