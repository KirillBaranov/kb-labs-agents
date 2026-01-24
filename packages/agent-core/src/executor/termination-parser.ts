/**
 * Termination Parser
 *
 * Parses LLM responses for explicit termination markers:
 * - [TASK_COMPLETE] - Agent successfully completed the task
 * - [NEED_ESCALATION: reason] - Agent needs help from orchestrator/human
 * - [GIVE_UP: reason] - Agent tried but cannot complete the task
 */

/**
 * Termination signal types
 */
export type TerminationSignal =
  | { type: "task_complete"; response: string }
  | { type: "need_escalation"; reason: string; response: string }
  | { type: "give_up"; reason: string; response: string }
  | { type: "none" };

/**
 * Parse LLM response for termination markers
 *
 * @param response - LLM text response
 * @returns Termination signal or 'none' if no marker found
 */
export function parseTerminationSignal(response: string): TerminationSignal {
  // Check for [TASK_COMPLETE]
  if (response.includes("[TASK_COMPLETE]")) {
    // Extract response without marker
    const cleanResponse = response.replace("[TASK_COMPLETE]", "").trim();
    return {
      type: "task_complete",
      response: cleanResponse,
    };
  }

  // Check for [NEED_ESCALATION: reason]
  const escalationMatch = response.match(/\[NEED_ESCALATION:\s*([^\]]+)\]/);
  if (escalationMatch) {
    const reason = escalationMatch[1]?.trim() || "No reason provided";
    const cleanResponse = response.replace(escalationMatch[0], "").trim();
    return {
      type: "need_escalation",
      reason,
      response: cleanResponse,
    };
  }

  // Check for [GIVE_UP: reason]
  const giveUpMatch = response.match(/\[GIVE_UP:\s*([^\]]+)\]/);
  if (giveUpMatch) {
    const reason = giveUpMatch[1]?.trim() || "No reason provided";
    const cleanResponse = response.replace(giveUpMatch[0], "").trim();
    return {
      type: "give_up",
      reason,
      response: cleanResponse,
    };
  }

  // No termination marker found
  return { type: "none" };
}

/**
 * Check if agent should give up based on consecutive failures
 *
 * @param consecutiveFailures - Number of consecutive tool call failures
 * @param maxFailures - Maximum allowed consecutive failures (default: 3)
 * @returns True if agent should give up
 */
export function shouldGiveUp(
  consecutiveFailures: number,
  maxFailures: number = 3,
): boolean {
  return consecutiveFailures >= maxFailures;
}
