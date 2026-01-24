/**
 * Loop Detector
 *
 * Detects when an agent is stuck in a loop by analyzing execution patterns
 */

import type {
  AgentExecutionStep,
  LoopDetectionState,
  LoopDetectionResult,
} from "@kb-labs/agent-contracts";
import { createHash } from "crypto";

/**
 * Loop Detector for agent execution
 *
 * Tracks execution patterns and detects loops using multiple strategies:
 * 1. Exact state repeats (hash-based)
 * 2. Tool call sequence repeats
 * 3. Similar reasoning patterns
 * 4. Stuck/no-progress detection
 */
export class LoopDetector {
  private state: LoopDetectionState;

  constructor(options?: { maxHistorySize?: number; loopThreshold?: number }) {
    this.state = {
      stateHashes: [],
      maxHistorySize: options?.maxHistorySize ?? 10, // Increased from 5 to allow more exploration
      toolCallSequences: [],
      loopThreshold: options?.loopThreshold ?? 4, // Increased from 3 to be less aggressive
    };
  }

  /**
   * Check if current step indicates a loop
   */
  checkForLoop(steps: AgentExecutionStep[]): LoopDetectionResult {
    if (steps.length < 2) {
      return { detected: false };
    }

    const currentStep = steps[steps.length - 1];
    if (!currentStep) {
      return { detected: false };
    }

    // Strategy 1: Exact state repeat (hash-based)
    // DISABLED: Too aggressive with forced reasoning pattern
    // const exactRepeat = this.checkExactRepeat(currentStep);
    // if (exactRepeat.detected) {
    //   return exactRepeat;
    // }

    // Strategy 2: Tool call sequence repeat
    const sequenceRepeat = this.checkToolSequenceRepeat(steps);
    if (sequenceRepeat.detected) {
      return sequenceRepeat;
    }

    // Strategy 3: Stuck reasoning (same tools, no progress)
    const stuckReasoning = this.checkStuckReasoning(steps);
    if (stuckReasoning.detected) {
      return stuckReasoning;
    }

    return { detected: false };
  }

  /**
   * Strategy 1: Check for exact state repeats
   *
   * UPDATED LOGIC: Only flag as loop if CONSECUTIVE repeats (within 3 tool execution steps).
   * This allows: Search → Read → Analyze → Read (re-reading for more details)
   * But blocks: Read → Reasoning → Read (immediate repeat after forced reasoning = likely stuck)
   */
  private checkExactRepeat(step: AgentExecutionStep): LoopDetectionResult {
    const stateHash = this.hashStep(step);

    // Check if this exact state was seen recently (within last 3 tool steps)
    // This allows one forced reasoning step between tool re-use
    const recentHistory = this.state.stateHashes.slice(-3); // Last 3 hashes
    const recentRepeatIndex = recentHistory.indexOf(stateHash);

    if (recentRepeatIndex !== -1) {
      const stepsSinceLastSeen = recentHistory.length - recentRepeatIndex;

      return {
        detected: true,
        type: "exact_repeat",
        description: `Exact state repeated after ${stepsSinceLastSeen} steps`,
        loopSteps: [step.step - stepsSinceLastSeen, step.step],
        confidence: 1.0, // 100% confidence for exact repeats
      };
    }

    // Add to history
    this.state.stateHashes.push(stateHash);

    // Keep only last N states
    if (this.state.stateHashes.length > this.state.maxHistorySize) {
      this.state.stateHashes.shift();
    }

    return { detected: false };
  }

  /**
   * Strategy 2: Check for tool call sequence repeats
   *
   * Detects patterns like: [fs:read, fs:write] → [fs:read, fs:write] → [fs:read, fs:write]
   */
  private checkToolSequenceRepeat(
    steps: AgentExecutionStep[],
  ): LoopDetectionResult {
    if (steps.length < 4) {
      return { detected: false };
    }

    // Get tool sequence from current step
    const currentStep = steps[steps.length - 1];
    if (!currentStep) {
      return { detected: false };
    }

    const currentSequence = this.extractToolSequence(currentStep);

    if (currentSequence.length === 0) {
      return { detected: false };
    }

    // Find matching sequence in history
    const sequenceKey = currentSequence.join("→");
    const matchingSeq = this.state.toolCallSequences.find(
      (seq) => seq.sequence.join("→") === sequenceKey,
    );

    if (matchingSeq) {
      matchingSeq.count++;
      matchingSeq.lastSeen = currentStep.step;

      // Loop detected if sequence repeats >= threshold times
      if (matchingSeq.count >= this.state.loopThreshold) {
        return {
          detected: true,
          type: "tool_sequence_repeat",
          description: `Tool sequence [${sequenceKey}] repeated ${matchingSeq.count} times`,
          confidence: 0.9,
        };
      }
    } else {
      // New sequence, add to tracking
      this.state.toolCallSequences.push({
        sequence: currentSequence,
        count: 1,
        lastSeen: currentStep.step,
      });
    }

    // Clean up old sequences (not seen in last 10 steps)
    this.state.toolCallSequences = this.state.toolCallSequences.filter(
      (seq) => currentStep.step - seq.lastSeen < 10,
    );

    return { detected: false };
  }

  /**
   * Strategy 3: Check for stuck reasoning
   *
   * Detects when agent keeps trying same tools but making no progress
   */
  private checkStuckReasoning(
    steps: AgentExecutionStep[],
  ): LoopDetectionResult {
    if (steps.length < 6) {
      return { detected: false };
    }

    // Look at last 5 steps
    const recentSteps = steps.slice(-5);

    // Extract all tool names from recent steps
    const allTools = recentSteps.flatMap(
      (step) => step.toolCalls?.map((tc) => tc.name) || [],
    );

    // Count unique tools vs total tools
    const uniqueTools = new Set(allTools);
    const repetitionRatio = allTools.length / uniqueTools.size;

    // If using only 1-2 tools repeatedly (ratio > 2.5), might be stuck
    if (uniqueTools.size <= 2 && repetitionRatio > 2.5) {
      // Check if all recent tool calls failed
      const failedCount = recentSteps.reduce(
        (count, step) =>
          count + (step.toolCalls?.filter((tc) => !tc.success).length || 0),
        0,
      );

      // Check if responses are very similar (indicating no progress)
      const responseHashes = recentSteps
        .filter((s) => s.response)
        .map((s) => this.hashString(s.response!.slice(0, 200))); // First 200 chars
      const uniqueResponses = new Set(responseHashes);

      // Stuck if: repeated tools + mostly failing + similar responses
      if (failedCount > recentSteps.length * 0.6 && uniqueResponses.size <= 2) {
        return {
          detected: true,
          type: "stuck_reasoning",
          description: `Agent stuck using ${Array.from(uniqueTools).join(", ")} repeatedly with ${failedCount} failures`,
          confidence: 0.75,
        };
      }
    }

    return { detected: false };
  }

  /**
   * Hash a step into a unique string
   *
   * We hash ONLY tool NAME + INPUT (not output, not reasoning).
   * This creates consistent hashes for same tool calls.
   *
   * Combined with checkExactRepeat's "recent history" check,
   * this allows re-using tools after a gap but blocks immediate repeats.
   */
  private hashStep(step: AgentExecutionStep): string {
    const toolCallsStr = step.toolCalls
      ? step.toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.input)}`)
          .join("|")
      : "";

    // For reasoning-only steps, each step is unique (forced reasoning pattern)
    if (!toolCallsStr) {
      return this.hashString(`reasoning-step-${step.step}`);
    }

    // For tool execution steps: hash tool calls only
    return this.hashString(toolCallsStr);
  }

  /**
   * Extract tool sequence from a step
   */
  private extractToolSequence(step: AgentExecutionStep): string[] {
    return step.toolCalls?.map((tc) => tc.name) || [];
  }

  /**
   * Hash a string using MD5
   */
  private hashString(str: string): string {
    return createHash("md5").update(str).digest("hex");
  }

  /**
   * Reset loop detection state (useful for new task)
   */
  reset(): void {
    this.state = {
      stateHashes: [],
      maxHistorySize: this.state.maxHistorySize,
      toolCallSequences: [],
      loopThreshold: this.state.loopThreshold,
    };
  }

  /**
   * Get current loop detection state (for debugging)
   */
  getState(): LoopDetectionState {
    return { ...this.state };
  }
}
