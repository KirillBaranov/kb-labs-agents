/**
 * ReAct Pattern Parser
 *
 * Parses text-based ReAct output (Thought → Action → Observation)
 * and extracts tool calls when LLM doesn't use native function calling.
 *
 * This is a fallback/enhancement for when the agent shows correct reasoning
 * but doesn't trigger native tool calls.
 */

import type { ToolCall } from '@kb-labs/agent-contracts';

/**
 * Parsed ReAct step
 */
export interface ParsedReActStep {
  thought?: string;
  action?: string;
  actionInput?: string | Record<string, unknown>;
  hasToolCall: boolean;
}

/**
 * ReAct Pattern Parser
 *
 * Extracts tool calls from text-based ReAct format:
 * **Thought:** [reasoning]
 * **Action:** [tool-name]
 * **Action Input:** [JSON or string]
 */
export class ReActParser {
  /**
   * Parse LLM response for ReAct pattern
   */
  parse(content: string): ParsedReActStep {
    const result: ParsedReActStep = {
      hasToolCall: false,
    };

    // Extract Thought
    const thoughtMatch = content.match(/\*\*Thought:\*\*\s*(.+?)(?=\n\*\*|$)/is);
    if (thoughtMatch && thoughtMatch[1]) {
      result.thought = thoughtMatch[1].trim();
    }

    // Extract Action (tool name)
    const actionMatch = content.match(/\*\*Action:\*\*\s*(.+?)(?=\n|$)/i);
    if (actionMatch && actionMatch[1]) {
      result.action = actionMatch[1].trim();
      result.hasToolCall = true;
    }

    // Extract Action Input
    const actionInputMatch = content.match(/\*\*Action Input:\*\*\s*(.+?)(?=\n\*\*|$)/is);
    if (actionInputMatch && actionInputMatch[1]) {
      const inputStr = actionInputMatch[1].trim();

      // Try to parse as JSON
      try {
        // Handle both JSON objects and JSON strings
        if (inputStr.startsWith('{') || inputStr.startsWith('[')) {
          result.actionInput = JSON.parse(inputStr);
        } else if (inputStr.startsWith('"') && inputStr.endsWith('"')) {
          // Quoted string - use as-is after removing quotes
          result.actionInput = inputStr.slice(1, -1);
        } else {
          // Plain string
          result.actionInput = inputStr;
        }
      } catch {
        // Not valid JSON, use as string
        result.actionInput = inputStr;
      }
    }

    return result;
  }

  /**
   * Convert parsed ReAct step to ToolCall format
   */
  toToolCall(parsed: ParsedReActStep): ToolCall | null {
    if (!parsed.hasToolCall || !parsed.action) {
      return null;
    }

    // Convert action input to appropriate format
    let input: string | Record<string, unknown>;

    if (typeof parsed.actionInput === 'string') {
      // String input - could be a query or JSON string
      input = parsed.actionInput;
    } else if (parsed.actionInput && typeof parsed.actionInput === 'object') {
      // Already an object
      input = parsed.actionInput;
    } else {
      // No input provided
      input = {};
    }

    return {
      id: `react-${Date.now()}`, // Generate ID for tracking
      name: this.normalizeToolName(parsed.action),
      input,
    };
  }

  /**
   * Normalize tool name (remove formatting, extra spaces)
   */
  private normalizeToolName(toolName: string): string {
    return toolName
      .replace(/[*_`]/g, '') // Remove markdown formatting
      .trim()
      .toLowerCase();
  }

  /**
   * Check if content contains ReAct pattern
   */
  hasReActPattern(content: string): boolean {
    return (
      content.includes('**Thought:**') ||
      content.includes('**Action:**') ||
      // Also check for variations
      content.includes('Thought:') ||
      content.includes('Action:')
    );
  }

  /**
   * Extract all ReAct steps from a multi-step response
   */
  parseMultiStep(content: string): ParsedReActStep[] {
    const steps: ParsedReActStep[] = [];

    // Split by **Thought:** markers to find multiple steps
    const thoughtMarkers = content.split(/(?=\*\*Thought:\*\*)/i);

    for (const section of thoughtMarkers) {
      if (!section.trim()) continue;

      const parsed = this.parse(section);
      if (parsed.thought || parsed.hasToolCall) {
        steps.push(parsed);
      }
    }

    return steps;
  }
}

/**
 * Helper: Extract tool call from text content
 *
 * Quick utility for single tool extraction
 */
export function extractToolCall(content: string): ToolCall | null {
  const parser = new ReActParser();
  const parsed = parser.parse(content);
  return parser.toToolCall(parsed);
}

/**
 * Helper: Check if text contains tool call intent
 */
export function hasToolCallIntent(content: string): boolean {
  const parser = new ReActParser();
  return parser.hasReActPattern(content);
}
