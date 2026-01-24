/**
 * @module @kb-labs/agent-tools/progress
 * Tool for reporting overall execution progress.
 */

import type { LLMTool } from "@kb-labs/core-platform";

/**
 * Progress metric.
 */
export interface ProgressMetric {
  /** Metric name */
  name: string;
  /** Current value */
  current: number;
  /** Target/total value */
  target: number;
  /** Unit of measurement */
  unit: string;
}

/**
 * Progress report.
 */
export interface ProgressReport {
  /** Overall progress percentage (0-100) */
  overallProgress: number;
  /** Number of subtasks completed */
  completedSubtasks: number;
  /** Total number of subtasks */
  totalSubtasks: number;
  /** Key milestones achieved */
  milestonesAchieved: string[];
  /** Next milestone to reach */
  nextMilestone: string;
  /** Additional metrics (optional) */
  metrics?: ProgressMetric[];
  /** Summary message */
  summary: string;
}

/**
 * Create LLM tool for reporting execution progress.
 *
 * Provides high-level progress overview.
 *
 * @returns LLM tool definition
 */
export function createReportProgressTool(): LLMTool {
  return {
    name: "report_progress",
    description: `Report overall execution progress with metrics and milestones.

**Use this tool to:**
- Provide progress updates to user
- Track completion percentage
- Highlight achieved milestones
- Identify next steps`,

    inputSchema: {
      type: "object",
      required: [
        "overallProgress",
        "completedSubtasks",
        "totalSubtasks",
        "milestonesAchieved",
        "nextMilestone",
        "summary",
      ],
      properties: {
        overallProgress: {
          type: "number",
          description: "Overall progress percentage",
          minimum: 0,
          maximum: 100,
        },
        completedSubtasks: {
          type: "number",
          description: "Number of subtasks completed",
          minimum: 0,
        },
        totalSubtasks: {
          type: "number",
          description: "Total number of subtasks",
          minimum: 1,
        },
        milestonesAchieved: {
          type: "array",
          description: "Key milestones achieved so far",
          items: {
            type: "string",
            minLength: 5,
            maxLength: 100,
          },
        },
        nextMilestone: {
          type: "string",
          description: "Next milestone to reach",
          minLength: 5,
          maxLength: 100,
        },
        metrics: {
          type: "array",
          description: "Additional progress metrics (optional)",
          items: {
            type: "object",
            required: ["name", "current", "target", "unit"],
            properties: {
              name: { type: "string" },
              current: { type: "number" },
              target: { type: "number" },
              unit: { type: "string" },
            },
          },
        },
        summary: {
          type: "string",
          description: "Summary of current progress",
          minLength: 20,
          maxLength: 500,
        },
      },
    },
  };
}
