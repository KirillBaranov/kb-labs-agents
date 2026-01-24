/**
 * @module @kb-labs/progress-reporter/types
 * Type definitions for progress feedback system.
 */

import type { LLMTier } from "@kb-labs/sdk";

/**
 * Progress event types.
 */
export type ProgressEventType =
  | "task_started"
  | "task_classified"
  | "planning_started"
  | "planning_completed"
  | "subtask_started"
  | "subtask_progress"
  | "subtask_completed"
  | "subtask_failed"
  | "tier_escalated"
  | "task_completed";

/**
 * Base progress event.
 */
export interface BaseProgressEvent {
  type: ProgressEventType;
  timestamp: number;
}

/**
 * Task started event.
 */
export interface TaskStartedEvent extends BaseProgressEvent {
  type: "task_started";
  data: {
    taskDescription: string;
  };
}

/**
 * Task classified event.
 */
export interface TaskClassifiedEvent extends BaseProgressEvent {
  type: "task_classified";
  data: {
    tier: LLMTier;
    confidence: "high" | "low";
    method: "heuristic" | "llm";
  };
}

/**
 * Planning phase event.
 */
export interface PlanningEvent extends BaseProgressEvent {
  type: "planning_started" | "planning_completed";
  data: {
    subtaskCount?: number; // Only for 'completed'
  };
}

/**
 * Subtask event.
 */
export interface SubtaskEvent extends BaseProgressEvent {
  type:
    | "subtask_started"
    | "subtask_progress"
    | "subtask_completed"
    | "subtask_failed";
  data: {
    subtaskId: number;
    description: string;
    tier: LLMTier;
    agentId?: string; // Optional: agent agent handling this subtask
    progress?: number; // 0-100, only for 'progress'
    error?: string; // Only for 'failed'
  };
}

/**
 * Tier escalation event.
 */
export interface TierEscalatedEvent extends BaseProgressEvent {
  type: "tier_escalated";
  data: {
    subtaskId: number;
    fromTier: LLMTier;
    toTier: LLMTier;
    reason: string;
  };
}

/**
 * Task completed event.
 */
export interface TaskCompletedEvent extends BaseProgressEvent {
  type: "task_completed";
  data: {
    status: "success" | "failed";
    totalDuration: number;
    costBreakdown: {
      total: string;
      small: string;
      medium: string;
      large: string;
    };
  };
}

/**
 * Union of all progress events.
 */
export type ProgressEvent =
  | TaskStartedEvent
  | TaskClassifiedEvent
  | PlanningEvent
  | SubtaskEvent
  | TierEscalatedEvent
  | TaskCompletedEvent;

/**
 * Progress callback function.
 */
export type ProgressCallback = (event: ProgressEvent) => void;
