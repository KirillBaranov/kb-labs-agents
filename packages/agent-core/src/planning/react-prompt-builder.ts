/**
 * ReAct Prompt Builder
 *
 * Builds system prompts that force structured Reasoning + Acting pattern.
 * This ensures agents think before acting and use tools proactively.
 */

import type { TaskClassification } from './task-classifier.js';
import type { ToolDefinition } from '@kb-labs/agent-contracts';

/**
 * ReAct Prompt Builder
 *
 * Generates system prompts that enforce:
 * 1. Tool-first thinking (MUST search codebase before answering)
 * 2. Structured reasoning (Thought → Action → Observation cycle)
 * 3. Task-specific guidance based on classification
 */
export class ReActPromptBuilder {
  /**
   * Build ReAct system prompt based on task classification
   *
   * @param includeTools - If false, excludes tool descriptions to force reasoning-only response
   */
  build(
    classification: TaskClassification,
    tools: ToolDefinition[],
    baseSystemPrompt?: string,
    includeTools: boolean = true
  ): string {
    let prompt = '';

    // Add base system prompt if provided
    if (baseSystemPrompt) {
      prompt += baseSystemPrompt + '\n\n';
    }

    // Add ReAct pattern instructions
    prompt += this.buildReActInstructions(includeTools);

    // Add task-specific guidance
    prompt += this.buildTaskSpecificGuidance(classification);

    // FORCED REASONING MODE:
    // When includeTools=false, skip tool guidelines entirely
    // This prevents LLM from "knowing" about tools and trying to call them
    if (includeTools) {
      // Add tool usage guidelines
      prompt += this.buildToolGuidelines(classification, tools);

      // Add critical rules
      prompt += this.buildCriticalRules(classification);

      // Add examples
      prompt += this.buildExamples(classification);
    } else {
      // Reasoning-only mode: Add reflection instructions
      prompt += this.buildReasoningModeInstructions();
    }

    return prompt;
  }

  /**
   * Core ReAct pattern instructions
   */
  private buildReActInstructions(includeTools: boolean): string {
    if (!includeTools) {
      // Reasoning-only mode: simplified instructions
      return `# Reasoning Mode

You are in REFLECTION mode. Your task is to THINK about what you just learned.

DO NOT call any tools in this step. Just reflect on:
- What did the previous tool results tell me?
- What have I learned so far?
- What should my next step be?
- Do I have enough information to answer, or do I need more?

After your reflection, I will enable tools again for your next action.

`;
    }

    return `# ReAct Pattern: Reasoning + Acting

You MUST follow this structured thinking pattern for EVERY response:

**Thought:** [Your reasoning about what to do next]
- What do I know so far?
- What information do I need?
- Which tool should I use?

**Action:** [Tool name]
**Action Input:** [Tool parameters as JSON]

**Observation:** [Tool result - provided by system]

Then repeat the cycle until you have enough information to answer.

CRITICAL: You MUST use tools to search the codebase BEFORE providing an answer.
NEVER answer from general knowledge without checking the actual codebase first.

## Task Completion Signals

**🎯 CRITICAL: You MUST use these markers to complete your task!**

When you finish your task or encounter obstacles, use these markers:

**✅ Task Complete (USE THIS WHEN YOU CAN ANSWER THE QUESTION):**
\`\`\`
[TASK_COMPLETE]
Your final answer here...
\`\`\`

**When to use [TASK_COMPLETE]:**
- ✅ You have read the relevant files and understand the implementation
- ✅ You can explain how the system works based on actual code you've seen
- ✅ You've gathered enough information to answer the user's question
- ✅ Re-reading files won't give you new information

**DO NOT wait until you've explored everything!** Once you can answer the question, use [TASK_COMPLETE] immediately.

**🆘 Need Escalation (complex decision, ambiguity, need human input):**
\`\`\`
[NEED_ESCALATION: brief reason]
What you found so far...
\`\`\`

**❌ Give Up (tried everything, cannot proceed):**
\`\`\`
[GIVE_UP: brief reason]
What you tried and why it didn't work...
\`\`\`

`;
  }

  /**
   * Instructions for reasoning-only mode (after tool execution)
   */
  private buildReasoningModeInstructions(): string {
    return `# Reflection Instructions

You just received results from tool execution. Now you need to THINK about what you learned.

## What to do in this step:

1. **Analyze the results** - What did the tool tell you?
2. **Check for errors** - Did the tool fail? What was the error message?
3. **Learn from failures** - If something failed, why? What should you try differently?
4. **Review Execution Memory** - Check what you ALREADY KNOW from previous steps (see "Execution Memory" section above)
5. **Plan next steps** - Based on what you learned AND what you already know, what should you do next?
6. **Assess progress** - Are you closer to answering the question? Do you have enough information?
7. **🎯 DECIDE: Can you answer now?** - If you have enough information, use [TASK_COMPLETE] in your NEXT step instead of calling more tools!

## CRITICAL RULES FOR REASONING MODE:

❌ **DO NOT try to call tools** - Tools are disabled in this reflection step
❌ **DO NOT repeat queries** - Check Execution Memory first! If you already searched for something, use those results instead of searching again
✅ **DO reflect on what you learned** - Explain what the results mean
✅ **DO identify errors** - If tool failed, explain why and what to try next
✅ **DO plan ahead** - Decide what your next action will be (will be executed in the next step)
✅ **DO check memory** - Review "Execution Memory" section to see what you already learned

## Avoiding Redundant Work:

**Before planning your next tool call, ask yourself:**
- Have I already searched for this? (Check "Previous Search Results" in memory)
- Have I already read this file? (Check "Files Already Read" in memory)
- Can I answer based on what I ALREADY KNOW instead of searching again?

**Example good reflection:**

"I tried to read vector-store.ts but got 'File not found' error. The error message suggests similar files like 'index.ts' and 'types.ts'. This means vector-store.ts doesn't exist in that directory. I should try reading index.ts to see what's exported from that module. That will tell me where VectorStore is actually defined."

**Example bad reflection (don't do this):**

"File not found. Let me try another file." [then immediately calls fs:read again]

**Example - checking memory:**

"I was about to search for 'reasoning patterns' but I see in Execution Memory that I already searched for this on Step 3 and found the relevant files. Instead of searching again, I should read one of those files that was mentioned in the previous search results."

## When to Give Up:

If you've tried multiple approaches and nothing works:
- ✅ Use [GIVE_UP: brief reason] to signal you cannot complete the task
- ✅ Explain what you tried and why it didn't work
- ✅ Be honest - it's better to escalate than to loop forever

If you need clarification or human decision:
- ✅ Use [NEED_ESCALATION: brief reason] to ask for help

Take your time to think. The next step will allow tool usage again.

`;
  }

  /**
   * Task-specific guidance based on classification
   */
  private buildTaskSpecificGuidance(classification: TaskClassification): string {
    let guidance = `# Task Classification\n\n`;
    guidance += `**Type:** ${classification.type}\n`;
    guidance += `**Complexity:** ${classification.complexity}/10\n`;
    guidance += `**Strategy:** ${classification.suggestedStrategy}\n`;
    guidance += `**Estimated Steps:** ${classification.estimatedSteps}\n`;
    guidance += `**Reasoning:** ${classification.reasoning}\n\n`;

    // Add type-specific instructions
    switch (classification.type) {
      case 'simple-lookup':
        guidance += this.buildSimpleLookupGuidance();
        break;
      case 'code-finding':
        guidance += this.buildCodeFindingGuidance();
        break;
      case 'architecture':
        guidance += this.buildArchitectureGuidance();
        break;
      case 'multi-step':
        guidance += this.buildMultiStepGuidance();
        break;
      case 'code-generation':
        guidance += this.buildCodeGenerationGuidance();
        break;
    }

    return guidance;
  }

  /**
   * Simple lookup task guidance
   */
  private buildSimpleLookupGuidance(): string {
    return `## Simple Lookup Strategy

This is a simple lookup task. Follow these steps:

1. **Thought:** Identify what to search for
2. **Action:** Use mind:rag-query to find the code element
3. **Observation:** Review search results
4. **Thought:** If found, read the file for details
5. **Action:** Use fs:read to get full content
6. **Observation:** Analyze the code
7. **Final Answer:** Provide answer with source references

IMPORTANT: Even for simple questions, you MUST search the codebase first!

`;
  }

  /**
   * Code finding task guidance
   */
  private buildCodeFindingGuidance(): string {
    return `## Code Finding Strategy

This is a code exploration task. Follow these steps:

1. **Thought:** Understand what needs to be explained
2. **Action:** Use mind:rag-query to find relevant files
3. **Observation:** Review search results
4. **Thought:** Identify key files to read
5. **Action:** Use fs:read to examine implementations
6. **Observation:** Analyze the code
7. **Thought:** Check for related files or dependencies
8. **Action:** Use mind:rag-query or fs:search for more context
9. **Final Answer:** Synthesize findings with code references

REMEMBER: Explore the actual codebase, don't rely on general knowledge!

`;
  }

  /**
   * Architecture understanding guidance
   */
  private buildArchitectureGuidance(): string {
    return `## Architecture Exploration Strategy

This is an architecture analysis task. Follow these steps:

1. **Thought:** Break down the architectural question into components
2. **Action:** Use mind:rag-query to find high-level files (README, ADRs, main entry points)
3. **Observation:** Review architectural documentation
4. **Thought:** Identify key modules/packages to examine
5. **Action:** Use fs:list and fs:read to explore structure
6. **Observation:** Map out connections and dependencies
7. **Thought:** Verify understanding by checking implementations
8. **Action:** Read key implementation files
9. **Final Answer:** Explain architecture with multiple source references

This requires deep exploration across multiple files. Be thorough!

`;
  }

  /**
   * Multi-step task guidance
   */
  private buildMultiStepGuidance(): string {
    return `## Multi-Step Task Strategy

This is a complex task requiring planning. Follow these steps:

1. **Thought:** Break task into logical steps
2. **Action:** Use mind:rag-query to understand current implementation
3. **Observation:** Analyze existing code
4. **Thought:** Identify files that need modification
5. **Action:** Use fs:read to examine each file
6. **Observation:** Understand current structure
7. **Thought:** Plan changes step by step
8. **Action:** Execute changes one step at a time
9. **Observation:** Verify each change
10. **Final Answer:** Summarize what was done

Plan carefully before making changes!

`;
  }

  /**
   * Code generation guidance
   */
  private buildCodeGenerationGuidance(): string {
    return `## Code Generation Strategy

This is a code creation task. Follow these steps:

1. **Thought:** Understand requirements and context
2. **Action:** Use mind:rag-query to find similar existing code
3. **Observation:** Study patterns and conventions used in codebase
4. **Thought:** Plan code structure
5. **Action:** Use fs:read to check related files for context
6. **Observation:** Note import paths, dependencies, patterns
7. **Thought:** Generate code following codebase conventions
8. **Final Answer:** Provide code with explanations

Always base new code on existing patterns in the codebase!

`;
  }

  /**
   * Tool usage guidelines
   */
  private buildToolGuidelines(classification: TaskClassification, tools: ToolDefinition[]): string {
    let guidelines = `# Tool Usage Guidelines\n\n`;
    guidelines += `**Required Tools for This Task:** ${classification.requiredTools.join(', ')}\n\n`;

    // Add guidelines for Mind RAG (if available)
    const hasMindRAG = tools.some((t) => t.name === 'mind:rag-query');
    if (hasMindRAG) {
      guidelines += `## mind:rag-query - PRIORITY TOOL

This is your PRIMARY tool for code search. Use it FIRST before other tools.

**When to use:**
- Finding classes, interfaces, functions
- Understanding how features work
- Exploring architecture
- Searching for implementations

**How to use:**
- Use natural language queries: "What is VectorStore?", "How does loop detection work?"
- Be specific: Include class names, feature names, concepts
- Review results before using fs:read

**CRITICAL:** ALWAYS try mind:rag-query BEFORE answering from general knowledge!

`;
    }

    // Add guidelines for filesystem tools
    const hasFsRead = tools.some((t) => t.name === 'fs:read');
    if (hasFsRead) {
      guidelines += `## fs:read - Read File Contents

Use after mind:rag-query or fs:search identifies relevant files.

**When to use:**
- Reading full file content
- Examining specific implementations
- Verifying information from Mind RAG

**CRITICAL - Path Format:**
- fs:read requires the FULL RELATIVE PATH from project root
- If fs:search shows: \`kb-labs-agents/packages/agent-core/src/file.ts:50: code\`
- Use fs:read with: \`kb-labs-agents/packages/agent-core/src/file.ts\`
- Extract the path BEFORE the colon (:line_number)
- DO NOT use just the filename ("file.ts") - this will cause ENOENT errors!

`;
    }

    const hasFsSearch = tools.some((t) => t.name === 'fs:search');
    if (hasFsSearch) {
      guidelines += `## fs:search - Search File Contents

Use as fallback if mind:rag-query unavailable or for exact string matches.

**When to use:**
- Finding exact strings or patterns
- Searching for specific error messages
- Finding TODOs, FIXMEs, etc.

**IMPORTANT - File Path Usage:**
- fs:search returns results in format: \`path/to/file.ts:123: matched line\`
- When using fs:read after fs:search, USE THE FULL PATH from the result
- Example: If fs:search shows \`kb-labs-agents/packages/agent-core/src/executor/progress-tracker.ts:50: class ProgressTracker\`
- Then use: fs:read with path \`kb-labs-agents/packages/agent-core/src/executor/progress-tracker.ts\`
- DO NOT extract just the filename (e.g., "progress-tracker.ts") - this will fail!

`;
    }

    return guidelines;
  }

  /**
   * Critical rules to prevent common failures
   */
  private buildCriticalRules(classification: TaskClassification): string {
    return `# CRITICAL RULES

🚨 **MANDATORY RULES - FAILURE TO FOLLOW = TASK FAILURE:**

1. **TOOL-FIRST THINKING**
   - You MUST use tools to search the codebase BEFORE answering
   - NEVER answer from training data/general knowledge without searching first
   - If mind:rag-query is available, use it as your FIRST action

2. **NO GENERIC ANSWERS**
   - Answers must be based on ACTUAL codebase findings
   - Include source references (file paths, line numbers)
   - If you can't find information in the codebase, say so explicitly

3. **STRUCTURED REASONING**
   - Always show your Thought → Action → Observation cycle
   - Explain WHY you chose each tool
   - Document what you learned from each observation

4. **ERROR RECOVERY**
   - If a tool fails, try an alternative approach
   - Don't give up on first error
   - Example: If fs:search finds nothing, try mind:rag-query with different query

5. **COMPLETENESS**
   - For ${classification.type} tasks, expected steps: ~${classification.estimatedSteps}
   - If you finish in <${Math.floor(classification.estimatedSteps / 2)} steps, you probably didn't explore enough
   - Review your findings before providing final answer

❌ **FORBIDDEN:**
- Answering "I don't know" without using tools
- Providing generic explanations about "how things typically work"
- Skipping the Thought → Action → Observation pattern
- Giving up after one failed tool call

`;
  }

  /**
   * Build examples based on task type
   */
  private buildExamples(classification: TaskClassification): string {
    let examples = `# Examples\n\n`;

    switch (classification.type) {
      case 'simple-lookup':
        examples += `## Example: Finding an Interface

**Task:** "What is the VectorStore interface?"

**Thought:** I need to find the VectorStore interface definition in the codebase. I'll use mind:rag-query first.

**Action:** mind:rag-query
**Action Input:** "VectorStore interface definition"

**Observation:** Found VectorStore in kb-labs-mind/packages/mind-engine/src/storage/vector-store.ts

**Thought:** Now I'll read the file to get the full definition.

**Action:** fs:read
**Action Input:** {"path": "kb-labs-mind/packages/mind-engine/src/storage/vector-store.ts"}

**Observation:** [File content with interface definition]

**Final Answer:** The VectorStore interface is defined in [file path] and includes methods for... [based on actual code]

`;
        break;

      case 'code-finding':
        examples += `## Example: Understanding Implementation

**Task:** "How does loop detection work?"

**Thought:** I need to find loop detection implementation. Let me search for it.

**Action:** mind:rag-query
**Action Input:** "loop detection in agents"

**Observation:** Found LoopDetector class in agent-core/src/executor/loop-detector.ts

**Thought:** Let me read the implementation to understand the strategies.

**Action:** fs:read
**Action Input:** {"path": "agent-core/src/executor/loop-detector.ts"}

**Observation:** [Code showing 3 detection strategies: exact state repeats, tool sequence repeats, stuck detection]

**Final Answer:** Loop detection uses 3 strategies implemented in LoopDetector class... [details from actual code]

`;
        break;
    }

    return examples;
  }
}
