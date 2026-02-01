/**
 * Orchestrator agent for task classification and parallel execution
 */

import type {
  TaskResult,
  TaskComplexity,
  ExecutionPlan,
  Subtask,
  AgentConfig,
  OrchestratorConfig,
  AgentEvent,
} from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';
import { Agent } from './agent.js';
import { useLLM } from '@kb-labs/sdk';
import { SessionManager } from './planning/session-manager.js';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Active agent info for correction routing
 */
interface ActiveAgentInfo {
  id: string;
  agent: Agent;
  task: string;
  status: 'running' | 'waiting' | 'completed';
}

/**
 * Correction routing result
 */
export interface CorrectionRoutingResult {
  correctionId: string;
  routedTo: string[];
  reason: string;
  applied: boolean;
}

/**
 * Generate unique orchestrator ID
 */
function generateOrchestratorId(): string {
  return `orch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Orchestrator Agent
 *
 * Classifies task complexity and creates execution plan.
 * For complex tasks, breaks down into subtasks and executes with child agents.
 */
export class OrchestratorAgent {
  private config: OrchestratorConfig;
  private toolRegistry: ToolRegistry;
  private startTime: number = 0;
  private startTimestamp: string = '';

  /** Unique ID for this orchestrator instance (for event correlation) */
  public readonly agentId: string;

  /** Active agents for correction routing */
  private activeAgents: Map<string, ActiveAgentInfo> = new Map();

  /** Stop flag for graceful shutdown */
  private stopRequested: boolean = false;

  /** Extracted scope path for child agents (relative to workingDir) */
  private taskScope: string | null = null;

  constructor(config: OrchestratorConfig, toolRegistry: ToolRegistry) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.agentId = generateOrchestratorId();
  }

  /**
   * Load conversation history from session for context
   * Returns formatted string with previous Q&A pairs
   */
  private async loadConversationHistory(): Promise<string> {
    if (!this.config.sessionId || !this.config.workingDir) {
      return '';
    }

    try {
      const sessionManager = new SessionManager(this.config.workingDir);
      const previousTurns = await sessionManager.getConversationHistory(this.config.sessionId, 5);

      if (previousTurns.length === 0) {
        return '';
      }

      this.log(`📜 Loaded ${previousTurns.length} previous conversation turn(s)`);

      const historyParts: string[] = [];
      for (const turn of previousTurns) {
        historyParts.push(`**User:** ${turn.userTask}`);
        if (turn.agentResponse) {
          historyParts.push(`**Assistant:** ${turn.agentResponse}`);
        }
      }

      return historyParts.join('\n\n');
    } catch (error) {
      this.log(`⚠️ Failed to load conversation history: ${error}`);
      return '';
    }
  }

  /**
   * Extract scope (subdirectory) from task using LLM tool calling
   * Returns relative path if task mentions specific repo/folder, null otherwise
   */
  private async extractScope(task: string): Promise<string | null> {
    const llm = useLLM({ tier: 'small' });
    if (!llm || !llm.chatWithTools) return null;

    // List available directories
    const workingDir = this.config.workingDir;
    let availableDirs: string[] = [];
    try {
      const entries = fs.readdirSync(workingDir, { withFileTypes: true });
      availableDirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => e.name);
    } catch {
      return null;
    }

    if (availableDirs.length === 0) return null;

    // Tool definition for scope selection (LLMTool format)
    const scopeTool = {
      name: 'select_scope',
      description: 'Select the specific subdirectory/repository that this task is about, or indicate no specific scope',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: [...availableDirs, 'none'],
            description: 'The directory name if task is about a specific one, or "none" if task is general',
          },
        },
        required: ['scope'],
      },
    };

    const prompt = `Analyze this task and determine if it refers to a specific subdirectory/repository.

**Task:** ${task}

**Available directories:**
${availableDirs.map(d => `- ${d}`).join('\n')}

If the task explicitly mentions or is clearly about ONE of these directories, select it.
If the task is general or mentions multiple directories, select "none".

Examples:
- "What packages are in kb-labs-mind?" → select "kb-labs-mind"
- "How does the CLI work?" → select "none" (could be any CLI)
- "Explain kb-labs-workflow architecture" → select "kb-labs-workflow"

Call select_scope with your choice.`;

    try {
      const response = await llm.chatWithTools(
        [{ role: 'user', content: prompt }],
        { tools: [scopeTool], temperature: 0 }
      );

      const toolCall = response.toolCalls?.[0];
      if (toolCall && toolCall.name === 'select_scope') {
        const input = toolCall.input as { scope: string };
        const scope = input.scope;
        if (scope && scope !== 'none' && availableDirs.includes(scope)) {
          this.log(`🎯 Extracted scope: ${scope}`);
          return scope;
        }
      }
    } catch (error) {
      this.log(`⚠️ Scope extraction error: ${error}`);
    }

    return null;
  }

  /**
   * Inject user correction into running agents
   * Uses LLM to decide which agents should receive the correction
   */
  async injectCorrection(message: string, targetAgentId?: string): Promise<CorrectionRoutingResult> {
    const correctionId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // If specific target, route directly
    if (targetAgentId) {
      const agentInfo = this.activeAgents.get(targetAgentId);
      if (agentInfo && agentInfo.agent.injectUserContext) {
        agentInfo.agent.injectUserContext(message);
        return {
          correctionId,
          routedTo: [targetAgentId],
          reason: 'User specified target agent',
          applied: true,
        };
      }
      return {
        correctionId,
        routedTo: [],
        reason: `Agent ${targetAgentId} not found or not running`,
        applied: false,
      };
    }

    // Use LLM to decide routing
    const activeList = Array.from(this.activeAgents.values())
      .filter(a => a.status === 'running' || a.status === 'waiting');

    if (activeList.length === 0) {
      return {
        correctionId,
        routedTo: [],
        reason: 'No active agents to receive correction',
        applied: false,
      };
    }

    // If only one agent, route directly
    if (activeList.length === 1) {
      const agentInfo = activeList[0]!;
      if (agentInfo.agent.injectUserContext) {
        agentInfo.agent.injectUserContext(message);
      }
      return {
        correctionId,
        routedTo: [agentInfo.id],
        reason: 'Only one active agent',
        applied: true,
      };
    }

    // Multiple agents - use LLM to decide
    const routing = await this.routeCorrectionWithLLM(message, activeList);

    // Apply correction to selected agents
    for (const agentId of routing.targets) {
      const agentInfo = this.activeAgents.get(agentId);
      if (agentInfo?.agent.injectUserContext) {
        agentInfo.agent.injectUserContext(message);
      }
    }

    return {
      correctionId,
      routedTo: routing.targets,
      reason: routing.reason,
      applied: routing.targets.length > 0,
    };
  }

  /**
   * Use LLM to decide which agents should receive the correction
   */
  private async routeCorrectionWithLLM(
    message: string,
    activeAgents: ActiveAgentInfo[]
  ): Promise<{ targets: string[]; reason: string }> {
    const llm = useLLM({ tier: 'small' });

    if (!llm) {
      // Fallback: send to all
      return {
        targets: activeAgents.map(a => a.id),
        reason: 'LLM unavailable, sending to all agents',
      };
    }

    const prompt = `You are a correction router. Decide which agents should receive this user correction.

**User Correction:** "${message}"

**Active Agents:**
${activeAgents.map(a => `- ${a.id}: "${a.task}" (status: ${a.status})`).join('\n')}

Analyze the correction and decide which agent(s) it applies to.
Consider: Is this correction about a specific task? Does it apply to all agents?

Respond ONLY with valid JSON:
{
  "targets": ["agent-id-1", "agent-id-2"],
  "reason": "Brief explanation of routing decision"
}`;

    try {
      const response = await llm.complete(prompt, { temperature: 0 });
      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        const validTargets = (parsed.targets || []).filter((id: string) =>
          activeAgents.some(a => a.id === id)
        );
        return {
          targets: validTargets,
          reason: parsed.reason || 'LLM routing decision',
        };
      }
    } catch (error) {
      this.log(`⚠️  Correction routing error: ${error}`);
    }

    // Fallback: send to all
    return {
      targets: activeAgents.map(a => a.id),
      reason: 'Routing failed, sending to all agents',
    };
  }

  /**
   * Request graceful stop of execution
   */
  requestStop(): void {
    this.stopRequested = true;
    this.log('\n🛑 Stop requested, finishing current operations...\n');
  }

  /**
   * Check if stop was requested
   */
  isStopRequested(): boolean {
    return this.stopRequested;
  }

  /**
   * Get list of active agents (for UI)
   * Only returns agents that are running or waiting (not completed)
   */
  getActiveAgents(): Array<{ id: string; task: string; status: 'running' | 'waiting' }> {
    return Array.from(this.activeAgents.values())
      .filter((a): a is ActiveAgentInfo & { status: 'running' | 'waiting' } =>
        a.status === 'running' || a.status === 'waiting'
      )
      .map(a => ({
        id: a.id,
        task: a.task,
        status: a.status,
      }));
  }

  /**
   * Emit event to callback if configured
   * Automatically adds agentId for event correlation
   */
  private emit(event: AgentEvent): void {
    if (this.config.onEvent) {
      const enrichedEvent = {
        ...event,
        agentId: this.agentId,
      };
      this.config.onEvent(enrichedEvent);
    }
  }

  /**
   * Execute task with orchestration
   */
  async execute(task: string): Promise<TaskResult> {
    this.startTime = Date.now();
    this.startTimestamp = new Date().toISOString();

    this.log(`\n${'='.repeat(70)}`);
    this.log(`🎭 ORCHESTRATOR - Task Analysis`);
    this.log(`${'='.repeat(70)}\n`);
    this.log(`📋 Task: ${task}\n`);

    // Check if we're in plan mode
    const isPlanMode = this.config.mode?.mode === 'plan';

    // Step 0: Extract scope from task (if task mentions specific subdirectory)
    this.taskScope = await this.extractScope(task);
    if (this.taskScope) {
      this.log(`🎯 Task scope: ${this.taskScope} (child agents will work in this directory)`);
    }

    // Emit orchestrator:start event (complexity will be refined after classification)
    this.emit({
      type: 'orchestrator:start',
      timestamp: this.startTimestamp,
      data: {
        task,
        complexity: 'simple', // Will be refined after classification
      },
    });

    if (isPlanMode) {
      this.log(`\n📝 PLAN MODE - Generating execution plan only\n`);
      return this.executePlanMode(task);
    }

    // Step 0: Check for meta-conversation questions (about the conversation itself)
    // These are answered directly from history without spawning child agents
    const metaResult = await this.handleMetaConversationQuestion(task);
    if (metaResult) {
      this.log(`\n💬 META-QUESTION - Answered from conversation history\n`);

      // Emit orchestrator:end event
      this.emit({
        type: 'orchestrator:end',
        timestamp: new Date().toISOString(),
        startedAt: this.startTimestamp,
        data: {
          success: metaResult.success,
          subtaskCount: 0,
          completedCount: 0,
          summary: metaResult.summary,
          durationMs: Date.now() - this.startTime,
        },
      } as AgentEvent);

      return metaResult;
    }

    // Step 1: Classify task complexity
    const classification = await this.classifyTask(task);

    this.log(`\n📊 Classification: ${classification.complexity.toUpperCase()}`);
    this.log(`   Reasoning: ${classification.reasoning}\n`);

    // Step 2: Execute based on complexity
    let result: TaskResult;
    let subtaskCount = 1;
    let completedCount = 0;

    if (classification.complexity === 'simple') {
      // Execute directly with single agent
      this.log(`\n🚀 Executing as SIMPLE task (single agent)\n`);
      result = await this.executeSimple(task);
      completedCount = result.success ? 1 : 0;
    } else if (classification.complexity === 'research') {
      // Research: gather info with child agents, synthesize with orchestrator
      this.log(`\n🔬 Executing as RESEARCH task (gather → synthesize)\n`);
      result = await this.executeResearch(task);
      subtaskCount = result.iterations;
      completedCount = result.success ? result.iterations : 0;
    } else {
      // Complex: create execution plan and run with child agents
      this.log(`\n⚙️ Executing as COMPLEX task (multi-step)\n`);
      const plan = await this.createExecutionPlan(task, classification.reasoning);

      this.log(`\n🎯 Execution Plan (${plan.subtasks.length} subtasks):`);
      plan.subtasks.forEach((subtask, i) => {
        this.log(`   ${i + 1}. ${subtask.description}`);
      });
      this.log('');

      result = await this.executeComplex(plan);
      subtaskCount = plan.subtasks.length;
      completedCount = plan.subtasks.filter(st => st.status === 'completed').length;
    }

    // Step 3: Apply result processors
    const finalResult = await this.applyResultProcessors(result);

    // Save answer to memory (never summarized - always available in full for follow-up questions)
    if (finalResult.success && finalResult.summary) {
      await this.saveAnswerToMemory(task, finalResult.summary, {
        filesCreated: finalResult.filesCreated,
        filesModified: finalResult.filesModified,
      });
    }

    // Emit orchestrator:end event with final summary and startedAt for correlation
    this.emit({
      type: 'orchestrator:end',
      timestamp: new Date().toISOString(),
      startedAt: this.startTimestamp, // When orchestrator started
      data: {
        success: finalResult.success,
        subtaskCount,
        completedCount,
        summary: finalResult.summary,
        durationMs: Date.now() - this.startTime,
      },
    } as AgentEvent);

    return finalResult;
  }

  /**
   * Execute in plan mode - generate plan without executing
   * Two-phase approach:
   * 1. Research Phase: Use child agents to gather information via subtasks
   * 2. Planning Phase: Generate actionable implementation plan based on research
   */
  private async executePlanMode(task: string): Promise<TaskResult> {
    const { PlanGenerator } = await import('./planning/plan-generator');
    const { SessionManager } = await import('./planning/session-manager');
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');

    // Generate session
    const sessionManager = new SessionManager(this.config.workingDir);
    const sessionId = this.config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Get complexity from mode context
    const planContext = this.config.mode?.context;
    const complexity = planContext && 'complexity' in planContext ? planContext.complexity : undefined;

    this.log(`\n📋 Plan Mode - Two Phase Approach`);
    this.log(`   Session ID: ${sessionId}`);
    if (complexity) {
      this.log(`   Complexity: ${complexity}`);
    }
    this.log('');

    // Phase 1: Research - Create subtasks to gather information
    this.log(`\n${'='.repeat(70)}`);
    this.log(`🔍 PHASE 1: RESEARCH - Gathering Information`);
    this.log(`${'='.repeat(70)}\n`);

    const researchPlan = await this.createResearchPlan(task);
    this.log(`\n📝 Research plan created (${researchPlan.subtasks.length} subtasks):`);
    researchPlan.subtasks.forEach((subtask, i) => {
      this.log(`   ${i + 1}. ${subtask.description}`);
    });
    this.log('');

    // Execute research subtasks using existing orchestrator infrastructure
    const researchContext = await this.executeResearchPhase(researchPlan);

    // Phase 2: Planning - Generate actionable implementation plan
    this.log(`\n${'='.repeat(70)}`);
    this.log(`📋 PHASE 2: PLANNING - Generating Implementation Plan`);
    this.log(`${'='.repeat(70)}\n`);

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task,
      sessionId,
      mode: 'plan',
      complexity,
      toolRegistry: this.toolRegistry,
      researchContext, // Pass collected research
    });

    // Save plan to session
    const planPath = sessionManager.getSessionPlanPath(sessionId);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    this.log(`\n✅ Plan generated successfully!`);
    this.log(`   Phases: ${plan.phases.length}`);
    this.log(`   Total steps: ${plan.phases.reduce((sum, p) => sum + p.steps.length, 0)}`);
    this.log(`   Saved to: ${planPath}\n`);

    // Display plan
    this.log(`\n${'='.repeat(70)}`);
    this.log(`📋 EXECUTION PLAN`);
    this.log(`${'='.repeat(70)}\n`);

    plan.phases.forEach((phase, i) => {
      this.log(`Phase ${i + 1}: ${phase.name}`);
      this.log(`   ${phase.description}`);
      this.log(`   Steps:`);
      phase.steps.forEach((step, j) => {
        this.log(`     ${j + 1}. ${step.action}`);
      });
      this.log('');
    });

    // Return result with plan
    return {
      success: true,
      summary: `Plan generated with ${plan.phases.length} phases and ${plan.phases.reduce((sum, p) => sum + p.steps.length, 0)} steps`,
      filesCreated: [planPath],
      filesModified: [],
      filesRead: [],
      iterations: 1,
      tokensUsed: 0,
      sessionId,
      plan,
    };
  }

  /**
   * Create research plan - break down task into research subtasks
   */
  private async createResearchPlan(task: string): Promise<ExecutionPlan> {
    const llm = useLLM({ tier: 'large' });

    const prompt = `You are a research planning agent. Break down this task into research subtasks to gather necessary information.

**Original Task:** ${task}

Create research subtasks to understand:
1. Current architecture and implementation
2. Key files and components involved
3. Existing patterns and conventions
4. Dependencies and constraints

Each subtask should be specific and focused on gathering one type of information.

Respond ONLY with valid JSON:
{
  "subtasks": [
    {"description": "Research subtask 1"},
    {"description": "Research subtask 2"},
    ...
  ]
}`;

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      const response = await llm.complete(prompt, {
        temperature: 0,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        const subtasks: Subtask[] = (parsed.subtasks || []).map(
          (st: any, index: number) => ({
            id: `research-${index + 1}`,
            description: st.description,
            status: 'pending' as const,
          })
        );

        return {
          originalTask: task,
          subtasks,
          createdAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.log(`⚠️  Research planning error: ${error}, using fallback`);
    }

    // Fallback: basic research subtasks
    return {
      originalTask: task,
      subtasks: [
        {
          id: 'research-1',
          description: `Analyze the architecture and key components related to: ${task}`,
          status: 'pending',
        },
        {
          id: 'research-2',
          description: `Find relevant files and implementation patterns for: ${task}`,
          status: 'pending',
        },
      ],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Execute research phase - run subtasks and collect context
   */
  private async executeResearchPhase(plan: ExecutionPlan): Promise<string> {
    const aggregator = this.createResultAggregator();
    const contextParts: string[] = [];

    for (const subtask of plan.subtasks) {
      this.logSubtaskHeader(subtask);
      subtask.status = 'in_progress';

      // eslint-disable-next-line no-await-in-loop -- Sequential research required
      const shouldContinue = await this.executeSubtask(subtask, aggregator);

      // Collect context from subtask result
      if (subtask.result && subtask.result.success) {
        contextParts.push(`## ${subtask.description}\n\n${subtask.result.summary}`);
      }

      if (!shouldContinue) {
        break;
      }
    }

    const researchContext = contextParts.join('\n\n');
    this.log(`\n✅ Research phase complete. Collected ${contextParts.length} research results.\n`);

    return researchContext;
  }

  /**
   * Check if task is a meta-question about the conversation itself
   * These questions should be answered directly from conversation history
   */
  private isMetaConversationQuestion(task: string): boolean {
    const lowerTask = task.toLowerCase();

    // Patterns for meta-questions about conversation history
    const metaPatterns = [
      // Russian patterns
      'о чем мы',
      'о чём мы',
      'что мы обсуждали',
      'что мы говорили',
      'прошлый раз',
      'предыдущий раз',
      'наш разговор',
      'наша беседа',
      'история беседы',
      'история разговора',
      'напомни о чем',
      'напомни о чём',
      'что было до этого',
      'что мы делали',
      // English patterns
      'what did we',
      'what have we',
      'our conversation',
      'our discussion',
      'previous discussion',
      'last time',
      'conversation history',
      'what were we',
      'remind me what',
      'what was our',
      'earlier we',
      'before this',
    ];

    return metaPatterns.some(pattern => lowerTask.includes(pattern));
  }

  /**
   * Handle meta-conversation questions directly from history
   * Returns null if not a meta-question or history is empty
   */
  private async handleMetaConversationQuestion(task: string): Promise<TaskResult | null> {
    if (!this.isMetaConversationQuestion(task)) {
      return null;
    }

    const conversationHistory = await this.loadConversationHistory();

    if (!conversationHistory) {
      // Emit answer event for "no history" response
      const noHistoryAnswer = 'У нас ещё не было предыдущих обсуждений в этой сессии. Это начало нового разговора.';

      this.emit({
        type: 'orchestrator:answer',
        timestamp: new Date().toISOString(),
        data: {
          answer: noHistoryAnswer,
        },
      });

      return {
        success: true,
        summary: noHistoryAnswer,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: 0,
        tokensUsed: 0,
      };
    }

    // Use LLM to summarize conversation history
    const llm = useLLM({ tier: 'small' });

    if (!llm) {
      // Fallback: return raw history
      const answer = `Вот история нашей беседы:\n\n${conversationHistory}`;

      this.emit({
        type: 'orchestrator:answer',
        timestamp: new Date().toISOString(),
        data: { answer },
      });

      return {
        success: true,
        summary: answer,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: 0,
        tokensUsed: 0,
      };
    }

    const prompt = `Summarize this conversation history concisely in the same language as the user's question.

**User's Question:** ${task}

**Conversation History:**
${conversationHistory}

Provide a brief, natural summary of what was discussed. Be specific about topics covered.`;

    try {
      const response = await llm.complete(prompt, { temperature: 0.3 });
      const answer = response.content || conversationHistory;

      this.emit({
        type: 'orchestrator:answer',
        timestamp: new Date().toISOString(),
        data: { answer },
      });

      return {
        success: true,
        summary: answer,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: 1,
        tokensUsed: (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0),
      };
    } catch (error) {
      // Fallback: return raw history
      const answer = `Вот история нашей беседы:\n\n${conversationHistory}`;

      this.emit({
        type: 'orchestrator:answer',
        timestamp: new Date().toISOString(),
        data: { answer },
      });

      return {
        success: true,
        summary: answer,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: 0,
        tokensUsed: 0,
      };
    }
  }

  /**
   * Classify task complexity
   */
  private async classifyTask(task: string): Promise<{
    complexity: TaskComplexity;
    reasoning: string;
  }> {
    const llm = useLLM({ tier: 'large' });
    if (!llm) {
      return {
        complexity: 'simple',
        reasoning: 'LLM not available, defaulting to simple execution',
      };
    }

    const prompt = `You are a task complexity classifier for an agent system.

Classify this task as "simple", "research", or "complex":

**Task:** ${task}

**Classification Criteria:**

SIMPLE tasks (one clear action):
- Creating or editing ONE file: "Create X.ts", "Add function Y to file Z"
- Direct lookup: "What is X?", "Where is file Y?"
- Running ONE command
- Basic factual questions
- ANY task that involves a SINGLE file operation

RESEARCH tasks (gathering + synthesizing information):
- Questions requiring MULTIPLE sources: "Explain the architecture", "How does X work?"
- Comparisons: "Compare A vs B"
- Analysis across multiple files
- Questions where answer needs synthesis from many findings
- Understanding patterns across the codebase

COMPLEX tasks (ONLY when multiple coordinated steps required):
- Implementing features that span 3+ files
- Refactoring that requires coordinated changes
- Multi-phase workflows: analyze → implement → test → verify
- Tasks explicitly mentioning "refactor", "migrate", "upgrade across"

**CRITICAL: Prefer SIMPLE over COMPLEX!**
- If a task can be done in ONE file → SIMPLE
- "Create X" with just ONE file → SIMPLE (not COMPLEX!)
- Only use COMPLEX when task EXPLICITLY requires multiple coordinated steps
- When in doubt → SIMPLE

Respond ONLY with valid JSON:
{
  "complexity": "simple" | "research" | "complex",
  "reasoning": "1-2 sentence explanation"
}`;

    try {
      const response = await llm.complete(prompt, {
        temperature: 0,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        return {
          complexity: ['simple', 'research', 'complex'].includes(parsed.complexity)
            ? parsed.complexity
            : 'simple',
          reasoning: parsed.reasoning || 'No reasoning provided',
        };
      }
    } catch (error) {
      this.log(`⚠️  Classification error: ${error}, defaulting to simple`);
    }

    // Fallback: default to simple
    return {
      complexity: 'simple',
      reasoning: 'Classification failed, defaulting to simple execution',
    };
  }

  /**
   * Create execution plan for complex task
   */
  private async createExecutionPlan(
    task: string,
    reasoning: string
  ): Promise<ExecutionPlan> {
    const llm = useLLM({ tier: this.config.planningTier || 'large' });

    const prompt = `You are a task planning agent. Break down this complex task into sequential subtasks.

**Original Task:** ${task}

**Why Complex:** ${reasoning}

Create a step-by-step execution plan. Each subtask should be:
- Specific and actionable
- Executable independently
- Ordered sequentially (dependencies first)

Respond ONLY with valid JSON:
{
  "subtasks": [
    {"description": "Step 1 description"},
    {"description": "Step 2 description"},
    ...
  ]
}`;

    try {
      if (!llm) {
        throw new Error('LLM not available');
      }

      const response = await llm.complete(prompt, {
        temperature: 0,
      });

      const content = response.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]!);
        const subtasks: Subtask[] = (parsed.subtasks || []).map(
          (st: any, index: number) => ({
            id: `subtask-${index + 1}`,
            description: st.description,
            status: 'pending' as const,
          })
        );

        return {
          originalTask: task,
          subtasks,
          createdAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.log(`⚠️  Planning error: ${error}, creating fallback plan`);
    }

    // Fallback: single subtask with original task
    return {
      originalTask: task,
      subtasks: [
        {
          id: 'subtask-1',
          description: task,
          status: 'pending',
        },
      ],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Execute simple task with single agent
   */
  private async executeSimple(task: string): Promise<TaskResult> {
    // Use createAgentConfig to ensure tracer and memory are passed
    const agentConfig = this.createAgentConfig();

    const agent = new Agent(agentConfig, this.toolRegistry);
    return agent.execute(task);
  }

  /**
   * Execute research task: gather info with child agents, synthesize with orchestrator
   *
   * Flow:
   * 1. Create research subtasks (what info to gather)
   * 2. Child agents (small tier) collect data
   * 3. Orchestrator (large tier) synthesizes final answer
   */
  private async executeResearch(task: string): Promise<TaskResult> {
    const llm = useLLM({ tier: 'large' });

    // Load conversation history for context
    const conversationHistory = await this.loadConversationHistory();

    // Step 1: Create research plan
    this.log(`\n🔍 Creating research plan...\n`);
    const researchPlan = await this.createResearchPlan(task);

    this.log(`\n📋 Research Plan (${researchPlan.subtasks.length} queries):`);
    researchPlan.subtasks.forEach((subtask, i) => {
      this.log(`   ${i + 1}. ${subtask.description}`);
    });
    this.log('');

    // Step 2: Execute research subtasks (child agents collect data)
    const researchContext = await this.executeResearchPhase(researchPlan);

    // Step 3: Synthesize answer with large model
    this.log(`\n🧠 Synthesizing answer from research...\n`);

    if (!llm) {
      return {
        success: false,
        summary: 'LLM not available for synthesis',
        error: 'LLM not available',
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: researchPlan.subtasks.length,
        tokensUsed: 0,
      };
    }

    // Build synthesis prompt with conversation history
    const historySection = conversationHistory
      ? `**Previous Conversation:**
${conversationHistory}

---

`
      : '';

    const synthesisPrompt = `You are a technical assistant answering questions about a codebase. Your answer MUST be specific and actionable.

${historySection}**User Question:** ${task}

**Research Findings:**
${researchContext}

**CRITICAL RULES:**
1. **BE SPECIFIC** - Include actual file paths, class names, function names, and code snippets from the research
2. **NO FLUFF** - Skip generic statements like "the architecture is modular" or "the code is well-structured"
3. **CITE SOURCES** - When mentioning something, reference the exact file: "In \`src/auth/service.ts\`, the AuthService class..."
4. **ANSWER DIRECTLY** - Start with the direct answer, then provide details
5. **USE CODE** - Include relevant code snippets when helpful
6. **BE CONCISE** - Every sentence must add value. If you can't find specific info, say "I couldn't find specific details about X"

**Format:**
- Start with a 1-2 sentence summary that directly answers the question
- Then provide specifics with file references
- Use \`code\` formatting for files, classes, functions
- Use code blocks for multi-line code snippets`;

    try {
      const response = await llm.complete(synthesisPrompt, { temperature: 0.3 });
      const answer = response.content || 'Unable to synthesize answer';
      const synthesisTokens = (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0);

      // Step 4: Verify synthesis (if verification enabled)
      let verificationResult: import('@kb-labs/agent-contracts').VerificationResult | undefined;
      let finalAnswer = answer;
      let totalIterations = researchPlan.subtasks.length + 1;
      let totalTokens = synthesisTokens;

      if (this.config.enableVerification !== false) {
        this.log(`\n🔍 Verifying synthesized answer...\n`);
        verificationResult = await this.verifySynthesis(task, finalAnswer, researchContext);

        // Step 5: React to verification results
        if (verificationResult) {
          const { DEFAULT_VERIFICATION_THRESHOLDS } = await import('@kb-labs/agent-contracts');
          const thresholds = DEFAULT_VERIFICATION_THRESHOLDS;
          const maxVerificationRetries = 2;
          let verificationAttempt = 0;

          // Loop until quality is acceptable or max retries reached
          while (verificationAttempt < maxVerificationRetries) {
            const needsImprovement =
              verificationResult.confidence < thresholds.minConfidence ||
              verificationResult.completeness < thresholds.minCompleteness ||
              verificationResult.unverifiedMentions.length > thresholds.maxUnverifiedMentions;

            if (!needsImprovement) {
              this.log(`\n✅ Answer quality acceptable (confidence: ${(verificationResult.confidence * 100).toFixed(0)}%, completeness: ${(verificationResult.completeness * 100).toFixed(0)}%)\n`);
              break;
            }

            verificationAttempt++;
            this.log(`\n🔄 Answer quality insufficient, attempting improvement (attempt ${verificationAttempt}/${maxVerificationRetries})...\n`);

            // Determine improvement strategy
            const hasGaps = verificationResult.gaps.length > 0;
            const hasHallucinations = verificationResult.unverifiedMentions.length > thresholds.maxUnverifiedMentions;
            const lowConfidence = verificationResult.confidence < thresholds.minConfidence;

            let improvementContext = '';

            // Strategy 1: Fill gaps with follow-up research
            if (hasGaps && verificationResult.gaps.length <= 3) {
              this.log(`📋 Filling ${verificationResult.gaps.length} gap(s) with additional research...\n`);

              const gapResults: string[] = [];
              for (const gap of verificationResult.gaps) {
                // eslint-disable-next-line no-await-in-loop -- Sequential gap filling required
                const gapResearch = await this.executeGapResearch(gap, researchContext);
                if (gapResearch) {
                  gapResults.push(`Gap "${gap}": ${gapResearch}`);
                  totalIterations++;
                }
              }

              if (gapResults.length > 0) {
                improvementContext += `\n\n## Additional Research (Gap Filling)\n${gapResults.join('\n\n')}`;
              }
            }

            // Strategy 2: Create guidance to avoid hallucinations
            if (hasHallucinations) {
              this.log(`⚠️ Guidance: avoid ${verificationResult.unverifiedMentions.length} unverified claims\n`);
              improvementContext += `\n\n## IMPORTANT: Avoid Unverified Claims\nThe following claims could NOT be verified and should NOT be repeated:\n${verificationResult.unverifiedMentions.map(m => `- ${m}`).join('\n')}\n\nOnly include information that is directly supported by the research context.`;
            }

            // Strategy 3: Add confidence guidance for low confidence
            if (lowConfidence) {
              improvementContext += `\n\n## Quality Guidance\nPrevious answer had low confidence (${(verificationResult.confidence * 100).toFixed(0)}%). Please:\n- Only state facts directly found in the research\n- Use hedging language for uncertain information\n- Clearly indicate what information is missing`;
            }

            // Re-synthesize with improved context
            const improvedPrompt = `${synthesisPrompt}\n\n---\n\n## Previous Verification Feedback\n\nThe previous answer had issues:\n- Confidence: ${(verificationResult.confidence * 100).toFixed(0)}%\n- Completeness: ${(verificationResult.completeness * 100).toFixed(0)}%\n- Gaps: ${verificationResult.gaps.join(', ') || 'none'}\n- Unverified claims: ${verificationResult.unverifiedMentions.join(', ') || 'none'}\n${improvementContext}\n\nPlease provide an improved answer that addresses these issues.`;

            // eslint-disable-next-line no-await-in-loop -- Sequential improvement required
            const improvedResponse = await llm.complete(improvedPrompt, { temperature: 0.2 });
            finalAnswer = improvedResponse.content || finalAnswer;
            totalTokens += (improvedResponse.usage?.promptTokens || 0) + (improvedResponse.usage?.completionTokens || 0);
            totalIterations++;

            // Re-verify improved answer
            this.log(`\n🔍 Re-verifying improved answer...\n`);
            // eslint-disable-next-line no-await-in-loop -- Sequential verification required
            const newVerification = await this.verifySynthesis(task, finalAnswer, researchContext + improvementContext);
            if (newVerification) {
              verificationResult = newVerification;
            }
          }

          if (verificationAttempt >= maxVerificationRetries) {
            this.log(`\n⚠️ Max verification retries reached. Returning best available answer.\n`);
          }
        }
      }

      // Emit orchestrator:answer event with the synthesized response and verification metrics
      this.emit({
        type: 'orchestrator:answer',
        timestamp: new Date().toISOString(),
        data: {
          answer: finalAnswer,
          confidence: verificationResult?.confidence,
          completeness: verificationResult?.completeness,
          gaps: verificationResult?.gaps,
          unverifiedMentions: verificationResult?.unverifiedMentions,
        },
      });

      // Note: saveAnswerToMemory is called in execute() after all result processors
      // This ensures the final answer is saved consistently for all task types

      return {
        success: true,
        summary: finalAnswer,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: totalIterations,
        tokensUsed: totalTokens,
        verification: verificationResult,
        qualityMetrics: verificationResult ? {
          confidence: verificationResult.confidence,
          completeness: verificationResult.completeness,
          gaps: verificationResult.gaps,
          reasoning: verificationResult.reasoning,
        } : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Research completed but synthesis failed: ${errorMsg}`,
        error: errorMsg,
        filesCreated: [],
        filesModified: [],
        filesRead: [],
        iterations: researchPlan.subtasks.length,
        tokensUsed: 0,
      };
    }
  }

  /**
   * Execute complex task with child agents
   */
  private async executeComplex(plan: ExecutionPlan): Promise<TaskResult> {
    const aggregator = this.createResultAggregator();
    const totalSubtasks = plan.subtasks.length;

    for (let index = 0; index < plan.subtasks.length; index++) {
      const subtask = plan.subtasks[index]!;
      this.logSubtaskHeader(subtask);
      subtask.status = 'in_progress';

      const subtaskStartTimestamp = new Date().toISOString();

      // Emit subtask:start event
      this.emit({
        type: 'subtask:start',
        timestamp: subtaskStartTimestamp,
        data: {
          subtaskId: subtask.id,
          description: subtask.description,
          index,
          total: totalSubtasks,
        },
      });

      // eslint-disable-next-line no-await-in-loop -- Sequential subtask execution required: orchestrator must execute subtasks in order
      const shouldContinue = await this.executeSubtask(subtask, aggregator);

      // Emit subtask:end event with startedAt for correlation
      this.emit({
        type: 'subtask:end',
        timestamp: new Date().toISOString(),
        startedAt: subtaskStartTimestamp, // When subtask started
        data: {
          subtaskId: subtask.id,
          success: subtask.result?.success ?? false,
          summary: subtask.result?.summary,
        },
      } as AgentEvent);

      if (!shouldContinue) {
        break;
      }
    }

    return this.buildFinalResult(plan, aggregator);
  }

  /**
   * Create result aggregator
   */
  private createResultAggregator(): {
    results: TaskResult[];
    allFilesCreated: string[];
    allFilesModified: string[];
    allFilesRead: string[];
    totalIterations: number;
    totalTokens: number;
  } {
    return {
      results: [],
      allFilesCreated: [],
      allFilesModified: [],
      allFilesRead: [],
      totalIterations: 0,
      totalTokens: 0,
    };
  }

  /**
   * Log subtask header
   */
  private logSubtaskHeader(subtask: Subtask): void {
    this.log(`\n${'─'.repeat(70)}`);
    this.log(`📍 Subtask ${subtask.id}: ${subtask.description}`);
    this.log(`${'─'.repeat(70)}\n`);
  }

  /**
   * Execute single subtask and aggregate results
   */
  private async executeSubtask(
    subtask: Subtask,
    aggregator: ReturnType<typeof this.createResultAggregator>
  ): Promise<boolean> {
    const agentConfig = this.createAgentConfig();
    const agent = new Agent(agentConfig, this.toolRegistry);

    try {
      const result = await agent.execute(subtask.description);

      subtask.status = result.success ? 'completed' : 'failed';
      subtask.result = result;

      this.accumulateResults(result, aggregator);

      if (!result.success) {
        return this.handleSubtaskFailure(subtask, result);
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      subtask.status = 'failed';
      this.log(`\n❌ Subtask error: ${errorMsg}\n`);

      return this.config.continueOnFailure ?? true;
    }
  }

  /**
   * Create agent configuration
   *
   * Note: Child agents use 'small' tier by default for efficiency.
   * Orchestrator uses 'large' tier for planning/classification.
   * Child agents can escalate if enableEscalation is true.
   */
  private createAgentConfig(): AgentConfig {
    // Apply scope if extracted (narrows child agent's working directory)
    let workingDir = this.config.workingDir;
    if (this.taskScope) {
      const scopedDir = path.join(this.config.workingDir, this.taskScope);
      // Verify scoped directory exists
      if (fs.existsSync(scopedDir) && fs.statSync(scopedDir).isDirectory()) {
        workingDir = scopedDir;
        this.log(`📁 Child agent workingDir: ${workingDir}`);
      }
    }

    return {
      workingDir,
      maxIterations: this.config.maxIterations,
      temperature: this.config.temperature,
      verbose: this.config.verbose,
      sessionId: this.config.sessionId,
      // Child agents use 'small' tier for efficiency
      // They can escalate to higher tiers if enableEscalation is true
      tier: this.config.childAgentTier || 'small',
      enableEscalation: this.config.enableEscalation,
      // DON'T pass mode to child agents - they should always execute in standard mode
      tracer: this.config.tracer, // Pass tracer to child agents
      memory: this.config.memory, // Pass memory to child agents
      onEvent: this.config.onEvent, // Pass event callback to child agents
      // Hierarchical event correlation: child agents know their parent
      parentAgentId: this.agentId,
    };
  }

  /**
   * Accumulate subtask results
   */
  private accumulateResults(
    result: TaskResult,
    aggregator: ReturnType<typeof this.createResultAggregator>
  ): void {
    aggregator.results.push(result);
    aggregator.allFilesCreated.push(...result.filesCreated);
    aggregator.allFilesModified.push(...result.filesModified);
    aggregator.allFilesRead.push(...result.filesRead);
    aggregator.totalIterations += result.iterations;
    aggregator.totalTokens += result.tokensUsed;
  }

  /**
   * Handle subtask failure and decide whether to continue
   */
  private handleSubtaskFailure(subtask: Subtask, result: TaskResult): boolean {
    this.log(`\n❌ Subtask failed: ${subtask.description}`);
    this.log(`   Error: ${result.error || result.summary}\n`);

    if (!this.config.continueOnFailure) {
      this.log(`\n🛑 Stopping execution due to subtask failure\n`);
      return false;
    }

    this.log(`\n⚠️  Continuing despite failure...\n`);
    return true;
  }

  /**
   * Build final aggregated result
   */
  private buildFinalResult(
    plan: ExecutionPlan,
    aggregator: ReturnType<typeof this.createResultAggregator>
  ): TaskResult {
    const allSuccessful = aggregator.results.every((r: TaskResult) => r.success);
    const completedCount = aggregator.results.filter((r: TaskResult) => r.success).length;

    return {
      success: allSuccessful,
      summary: `Orchestrator completed ${completedCount}/${plan.subtasks.length} subtasks`,
      filesCreated: [...new Set(aggregator.allFilesCreated)],
      filesModified: [...new Set(aggregator.allFilesModified)],
      filesRead: [...new Set(aggregator.allFilesRead)],
      iterations: aggregator.totalIterations,
      tokensUsed: aggregator.totalTokens,
    };
  }

  /**
   * Apply result processors
   */
  private async applyResultProcessors(result: TaskResult): Promise<TaskResult> {
    if (!this.config.resultProcessors || this.config.resultProcessors.length === 0) {
      return result;
    }

    let processedResult = result;

    for (const processor of this.config.resultProcessors) {
      // eslint-disable-next-line no-await-in-loop -- Sequential result processing required: each processor may depend on previous
      processedResult = await processor.process(processedResult);
    }

    return processedResult;
  }

  /**
   * Verify synthesized answer using cross-tier verification
   *
   * Uses a larger model tier to verify the synthesis generated by smaller models.
   * Returns verification result with confidence, completeness, and potential hallucinations.
   */
  private async verifySynthesis(
    task: string,
    answer: string,
    researchContext: string
  ): Promise<import('@kb-labs/agent-contracts').VerificationResult | undefined> {
    try {
      const { requestVerification, toVerificationResult } = await import('./verification/index.js');

      const startTime = Date.now();

      // Emit verification:start event
      if (this.config.onEvent) {
        this.config.onEvent({
          type: 'verification:start' as const,
          timestamp: new Date().toISOString(),
          agentId: this.agentId,
          data: {
            target: 'synthesis' as const,
            executorTier: 'medium' as const,
            verifierTier: 'large' as const,
          },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }

      // Request verification from larger model
      const verificationOutput = await requestVerification({
        task,
        answer,
        toolResultsSummary: researchContext,
        executorTier: 'medium', // Synthesis uses medium tier
      });

      // Convert to VerificationResult
      const result = toVerificationResult(verificationOutput);

      const durationMs = Date.now() - startTime;

      // Emit verification:complete event
      if (this.config.onEvent) {
        this.config.onEvent({
          type: 'verification:complete' as const,
          timestamp: new Date().toISOString(),
          agentId: this.agentId,
          data: {
            target: 'synthesis' as const,
            confidence: result.confidence,
            completeness: result.completeness,
            verifiedMentions: result.verifiedMentions,
            unverifiedMentions: result.unverifiedMentions,
            gaps: result.gaps,
            warnings: result.warnings.map((w: { message: string }) => w.message),
            durationMs,
          },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }

      this.log(`\n✅ Verification complete:`);
      this.log(`   Confidence: ${(result.confidence * 100).toFixed(0)}%`);
      this.log(`   Completeness: ${(result.completeness * 100).toFixed(0)}%`);
      if (result.unverifiedMentions.length > 0) {
        this.log(`   ⚠️ Unverified mentions: ${result.unverifiedMentions.join(', ')}`);
      }
      if (result.gaps.length > 0) {
        this.log(`   📋 Gaps: ${result.gaps.join(', ')}`);
      }
      this.log('');

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`\n⚠️ Verification failed: ${errorMsg}\n`);
      return undefined;
    }
  }

  /**
   * Execute targeted research to fill a specific gap
   *
   * Creates a mini-research task focused on finding information for one gap.
   * Returns the research findings as a string, or null if research failed.
   */
  private async executeGapResearch(gap: string, existingContext: string): Promise<string | null> {
    try {
      const llm = useLLM();
      if (!llm) {
        this.log(`   ❌ Gap research failed: LLM not available`);
        return null;
      }

      // Create a focused research prompt
      const gapPrompt = `You are filling a specific information gap.

**Gap to fill:** ${gap}

**Existing research context (for reference):**
${existingContext.slice(0, 2000)}...

**Instructions:**
1. Use the available tools to find specific information about: ${gap}
2. Focus ONLY on this specific gap - don't repeat existing research
3. Be concise - return only the relevant findings
4. If you cannot find the information, say so clearly

What specific information can you find about: ${gap}`;

      // Use a simple completion to get gap-filling research
      // In a full implementation, this would use tool calling
      const response = await llm.complete(gapPrompt, { temperature: 0.1 });

      if (response.content && response.content.length > 50) {
        this.log(`   ✅ Found information for gap: ${gap.slice(0, 50)}...`);
        return response.content;
      }

      this.log(`   ⚠️ Could not find information for gap: ${gap.slice(0, 50)}...`);
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`   ❌ Gap research failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Log helper
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }

  /**
   * Save orchestrator answer to memory (never summarized)
   *
   * This ensures the full answer is always available for follow-up questions.
   * The answer is stored separately from regular memories and never compressed.
   */
  private async saveAnswerToMemory(
    task: string,
    answer: string,
    metadata?: {
      confidence?: number;
      completeness?: number;
      filesCreated?: string[];
      filesModified?: string[];
    }
  ): Promise<void> {
    // Check if memory supports saveLastAnswer
    const memory = this.config.memory;
    if (memory && typeof (memory as any).saveLastAnswer === 'function') {
      try {
        await (memory as any).saveLastAnswer(answer, task, metadata);
        this.log(`📝 Answer saved to memory (${answer.length} chars)`);
      } catch (error) {
        // Don't fail the task if memory save fails
        this.log(`⚠️ Failed to save answer to memory: ${error}`);
      }
    }
  }
}
