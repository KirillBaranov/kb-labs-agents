/**
 * Iterative Orchestrator
 *
 * Manager-Worker Architecture for autonomous task execution:
 * - Smart orchestrator (Opus) thinks and delegates
 * - Cheap workers (Haiku) execute tools
 * - Iterative loop with early stopping
 * - Explicit user escalation
 */

export { IterativeOrchestrator } from "./orchestrator.js";
export * from "./types.js";
