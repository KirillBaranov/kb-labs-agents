/**
 * Task Classifier
 *
 * Analyzes task to determine optimal execution strategy, tools, and complexity.
 * Uses LLM for intelligent classification with fallback to heuristics.
 */

import { useLLM, useCache } from "@kb-labs/sdk";
import type { ToolDefinition } from "@kb-labs/agent-contracts";

/**
 * Task type classification
 */
export type TaskType =
  | "simple-lookup"
  | "code-finding"
  | "architecture"
  | "multi-step"
  | "code-generation";

/**
 * Execution strategy for task
 */
export type ExecutionStrategy = "direct" | "explore" | "plan-then-execute";

/**
 * Task classification result
 */
export interface TaskClassification {
  type: TaskType;
  complexity: number; // 1-10
  suggestedStrategy: ExecutionStrategy;
  estimatedSteps: number;
  requiredTools: string[];
  reasoning: string; // Why this classification
}

/**
 * Task Classifier
 *
 * Phase 1 implementation:
 * - LLM-based classification for accuracy
 * - Heuristic fallback for speed/reliability
 * - Caching to avoid repeated classification
 */
export class TaskClassifier {
  /**
   * Classify task using LLM (with cache)
   */
  async classify(
    task: string,
    availableTools: ToolDefinition[],
  ): Promise<TaskClassification> {
    // Check cache first (TTL: 1 hour)
    const cacheKey = `task-classification:${this.hashTask(task)}`;
    const cache = useCache();

    if (cache) {
      const cached = await cache.get<TaskClassification>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try LLM classification
    try {
      const classification = await this.classifyWithLLM(task, availableTools);

      // Cache result if cache available
      if (cache) {
        await cache.set(cacheKey, classification, 60 * 60 * 1000); // 1 hour
      }

      return classification;
    } catch (error) {
      // Fallback to heuristics if LLM unavailable
      return this.classifyWithHeuristics(task, availableTools);
    }
  }

  /**
   * Classify using LLM for high accuracy
   */
  private async classifyWithLLM(
    task: string,
    availableTools: ToolDefinition[],
  ): Promise<TaskClassification> {
    const llm = useLLM();
    if (!llm) {
      throw new Error("LLM not available");
    }

    const toolNames = availableTools.map((t) => t.name).join(", ");

    const prompt = `Analyze this task and classify it for optimal execution.

**Task:** "${task}"

**Available Tools:** ${toolNames}

Classify the task into one of these types:
1. **simple-lookup** - Finding specific code elements, interfaces, classes
   - Examples: "What is X?", "Find Y", "Where is Z?"
   - Strategy: Direct search using mind:rag-query or fs:read
   - Tools needed: mind:rag-query, fs:read
   - Complexity: 1-3

2. **code-finding** - Understanding how features work, finding implementations
   - Examples: "How does X work?", "Explain Y implementation"
   - Strategy: Explore codebase using Mind RAG + file reads
   - Tools needed: mind:rag-query, fs:read, fs:search
   - Complexity: 3-6

3. **architecture** - Understanding system design, multi-file analysis
   - Examples: "Explain architecture", "How does X integrate with Y?"
   - Strategy: Deep exploration across multiple files
   - Tools needed: mind:rag-query, fs:read, fs:list
   - Complexity: 5-8

4. **multi-step** - Complex tasks requiring planning
   - Examples: "Add feature X", "Fix bug Y", "Refactor Z"
   - Strategy: Plan steps, then execute methodically
   - Tools needed: mind:rag-query, fs:read, fs:write, shell:exec
   - Complexity: 6-10

5. **code-generation** - Creating new code from scratch
   - Examples: "Create function X", "Write tests for Y"
   - Strategy: Plan structure, generate code, validate
   - Tools needed: fs:write, fs:read, mind:rag-query (for context)
   - Complexity: 4-8

Respond with JSON only:
{
  "type": "simple-lookup" | "code-finding" | "architecture" | "multi-step" | "code-generation",
  "complexity": 1-10,
  "suggestedStrategy": "direct" | "explore" | "plan-then-execute",
  "estimatedSteps": number,
  "requiredTools": ["tool1", "tool2"],
  "reasoning": "Brief explanation of why this classification"
}`;

    const response = await llm.complete(prompt, {
      temperature: 0.1, // Low temperature for consistent classification
      maxTokens: 300,
    });

    // Parse JSON response
    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Invalid LLM response format");
    }

    const classification = JSON.parse(jsonMatch[0]) as TaskClassification;

    // Validate classification
    if (!this.isValidClassification(classification)) {
      throw new Error("Invalid classification structure");
    }

    return classification;
  }

  /**
   * Fallback: Classify using heuristics
   */
  private classifyWithHeuristics(
    task: string,
    _availableTools: ToolDefinition[],
  ): TaskClassification {
    const taskLower = task.toLowerCase();

    // Simple lookup patterns
    if (
      this.matchesPattern(taskLower, [
        /^what is\s+/,
        /^where is\s+/,
        /^find\s+/,
        /^show me\s+/,
        /interface$/,
        /class$/,
        /function$/,
      ])
    ) {
      return {
        type: "simple-lookup",
        complexity: 2,
        suggestedStrategy: "direct",
        estimatedSteps: 2,
        requiredTools: ["mind:rag-query", "fs:read"],
        reasoning: "Pattern match: simple lookup query",
      };
    }

    // Code finding patterns
    if (
      this.matchesPattern(taskLower, [
        /^how does\s+/,
        /^explain\s+/,
        /works$/,
        /implementation$/,
        /^understand\s+/,
      ])
    ) {
      return {
        type: "code-finding",
        complexity: 4,
        suggestedStrategy: "explore",
        estimatedSteps: 4,
        requiredTools: ["mind:rag-query", "fs:read", "fs:search"],
        reasoning: "Pattern match: code exploration query",
      };
    }

    // Architecture patterns
    if (
      this.matchesPattern(taskLower, [
        /architecture/,
        /design/,
        /system/,
        /flow/,
        /integrate/,
        /end.to.end/,
      ])
    ) {
      return {
        type: "architecture",
        complexity: 6,
        suggestedStrategy: "explore",
        estimatedSteps: 6,
        requiredTools: ["mind:rag-query", "fs:read", "fs:list"],
        reasoning: "Pattern match: architecture query",
      };
    }

    // Multi-step patterns
    if (
      this.matchesPattern(taskLower, [
        /^add\s+/,
        /^implement\s+/,
        /^fix\s+/,
        /^refactor\s+/,
        /^create\s+/,
      ])
    ) {
      return {
        type: "multi-step",
        complexity: 7,
        suggestedStrategy: "plan-then-execute",
        estimatedSteps: 8,
        requiredTools: ["mind:rag-query", "fs:read", "fs:write", "shell:exec"],
        reasoning: "Pattern match: complex task requiring changes",
      };
    }

    // Default: code-finding (safest middle ground)
    return {
      type: "code-finding",
      complexity: 5,
      suggestedStrategy: "explore",
      estimatedSteps: 5,
      requiredTools: ["mind:rag-query", "fs:read"],
      reasoning: "Default classification: exploratory task",
    };
  }

  /**
   * Check if task matches any of the patterns
   */
  private matchesPattern(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }

  /**
   * Validate classification structure
   */
  private isValidClassification(
    classification: any,
  ): classification is TaskClassification {
    return (
      typeof classification === "object" &&
      typeof classification.type === "string" &&
      typeof classification.complexity === "number" &&
      typeof classification.suggestedStrategy === "string" &&
      typeof classification.estimatedSteps === "number" &&
      Array.isArray(classification.requiredTools) &&
      typeof classification.reasoning === "string"
    );
  }

  /**
   * Generate cache key from task
   */
  private hashTask(task: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < task.length; i++) {
      const char = task.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }
}
