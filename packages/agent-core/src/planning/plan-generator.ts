/**
 * Plan generator - creates execution plans using LLM with native tool calling
 */

import { useLLM, type LLMTool } from '@kb-labs/sdk';
import type { TaskPlan, Phase, AgentMode } from '@kb-labs/agent-contracts';
import type { ToolRegistry } from '@kb-labs/agent-tools';

/**
 * Generates execution plans from task descriptions
 */
export class PlanGenerator {
  /**
   * Generate a task execution plan using native tool calling
   */
  async generate(config: {
    task: string;
    sessionId: string;
    mode: AgentMode;
    complexity?: 'simple' | 'medium' | 'complex';
    toolRegistry?: ToolRegistry;
    researchContext?: string; // Context from research phase (if available)
  }): Promise<TaskPlan> {
    const llm = useLLM({ tier: 'large' });
    if (!llm) {
      throw new Error('LLM not available for plan generation');
    }

    if (!llm.chatWithTools) {
      throw new Error('LLM does not support native tool calling');
    }

    // Create plan generation tool
    const planTool = this.createPlanTool();

    // Build tools array - plan tool + research tools (read-only)
    const tools: LLMTool[] = [planTool];

    // Add research tools if registry provided
    if (config.toolRegistry) {
      const researchTools = this.getResearchTools(config.toolRegistry);
      tools.push(...researchTools);
    }

    const systemPrompt = this.buildSystemPrompt(config.task, config.mode, config.complexity, config.researchContext);

    // Use native tool calling
    const response = await llm.chatWithTools(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create an executable plan for: ${config.task}` },
      ],
      {
        tools,
        temperature: 0.1,
        toolChoice: { type: 'function', function: { name: 'plan_generate' } }, // Force using plan tool
      }
    );

    // Extract plan from tool call
    let planData: any;
    if (response.toolCalls && response.toolCalls.length > 0) {
      const planCall = response.toolCalls.find(tc => tc.name === 'plan_generate');
      if (planCall) {
        planData = planCall.input;
      }
    }

    if (!planData) {
      throw new Error('LLM did not generate a plan using the tool');
    }

    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const plan: TaskPlan = {
      id: planId,
      sessionId: config.sessionId,
      task: config.task,
      mode: config.mode,
      phases: this.normalizePhasesFromTool(planData.phases || []),
      estimatedDuration: planData.estimatedDuration || 'Unknown',
      complexity: config.complexity || planData.complexity || 'medium',
      createdAt: now,
      updatedAt: now,
      status: 'draft',
    };

    return plan;
  }

  /**
   * Create the plan generation tool
   */
  private createPlanTool(): LLMTool {
    return {
      name: 'plan_generate',
      description: 'Generate a structured execution plan with phases and steps. Each step MUST use an available tool (fs:read, fs:write, fs:edit, mind:rag-query, shell:exec, etc.)',
      inputSchema: {
        type: 'object',
        properties: {
          complexity: {
            type: 'string',
            enum: ['simple', 'medium', 'complex'],
            description: 'Task complexity assessment',
          },
          estimatedDuration: {
            type: 'string',
            description: 'Estimated implementation time (e.g., "2 hours", "1 day")',
          },
          phases: {
            type: 'array',
            description: 'Execution phases with dependencies',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique phase ID (e.g., "phase-1")' },
                name: { type: 'string', description: 'Phase name' },
                description: { type: 'string', description: 'What this phase accomplishes' },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of phases that must complete first',
                },
                steps: {
                  type: 'array',
                  description: 'Concrete executable steps',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Unique step ID (e.g., "step-1-1")' },
                      action: { type: 'string', description: 'Concrete action using a specific tool' },
                      tool: {
                        type: 'string',
                        enum: ['mind:rag-query', 'fs:read', 'fs:write', 'fs:edit', 'fs:list', 'fs:search', 'shell:exec'],
                        description: 'Tool to execute this step',
                      },
                      args: {
                        type: 'object',
                        description: 'Tool arguments (optional)',
                      },
                      expectedOutcome: {
                        type: 'string',
                        description: 'Measurable result of this step',
                      },
                    },
                    required: ['id', 'action', 'tool', 'expectedOutcome'],
                  },
                },
              },
              required: ['id', 'name', 'description', 'steps'],
            },
          },
        },
        required: ['complexity', 'estimatedDuration', 'phases'],
      },
    };
  }

  /**
   * Get research tools from registry (read-only tools for investigation)
   */
  private getResearchTools(registry: ToolRegistry): LLMTool[] {
    const tools: LLMTool[] = [];

    // Get all available tools and filter for research tools
    const researchToolNames = ['mind:rag-query', 'fs:read', 'fs:list'];

    for (const toolName of researchToolNames) {
      const tool = registry.get(toolName);
      if (tool) {
        // Convert from agent tool definition to LLM tool format
        tools.push({
          name: tool.definition.function.name,
          description: tool.definition.function.description || '',
          inputSchema: tool.definition.function.parameters,
        });
      }
    }

    return tools;
  }

  /**
   * Normalize phases from tool call
   */
  private normalizePhasesFromTool(phases: any[]): Phase[] {
    return phases.map((p, idx) => ({
      id: p.id || `phase-${idx + 1}`,
      name: p.name || `Phase ${idx + 1}`,
      description: p.description || '',
      dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
      status: 'pending' as const,
      steps: (p.steps || []).map((s: any, stepIdx: number) => ({
        id: s.id || `step-${idx + 1}-${stepIdx + 1}`,
        action: s.action || '',
        tool: s.tool,
        args: s.args || {},
        expectedOutcome: s.expectedOutcome || '',
        status: 'pending' as const,
      })),
    }));
  }

  /**
   * Build system prompt for plan generation
   */
  private buildSystemPrompt(
    task: string,
    mode: AgentMode,
    complexity?: 'simple' | 'medium' | 'complex',
    researchContext?: string
  ): string {
    const modeContext = this.getModeContext(mode);

    // Build research context section if available
    const researchSection = researchContext
      ? `\n\nRESEARCH FINDINGS:
The following information was gathered by research agents analyzing the codebase:

${researchContext}

Use this research to inform your implementation plan. Focus on ACTIONABLE IMPLEMENTATION STEPS, not meta-level research.`
      : '';

    return `You are an AI agent creating an EXECUTABLE plan for autonomous implementation.

Task: ${task}

Mode: ${mode}
${modeContext}

${complexity ? `Complexity hint: ${complexity}` : ''}${researchSection}

CRITICAL CONSTRAINTS:
1. You are an AUTONOMOUS AGENT with access ONLY to these tools:
   - fs:read - Read file contents
   - fs:write - Create new files
   - fs:edit - Edit existing files
   - fs:list - List directory contents
   - fs:search - Search for files by pattern
   - mind:rag-query - Semantic code search across codebase
   - shell:exec - Execute shell commands

2. EVERY step MUST use one of these tools - NO abstract steps like:
   ❌ "Interview stakeholders"
   ❌ "Gather requirements"
   ❌ "Deploy to production"
   ❌ "Configure infrastructure"
   ❌ "Research the codebase" (research is already done - see RESEARCH FINDINGS above)

   Instead, use CONCRETE tool-based steps:
   ✅ "Read orchestrator.ts to understand current implementation using fs:read"
   ✅ "Create new mode-handler.ts file using fs:write"
   ✅ "Modify agent.ts to add mode support using fs:edit"
   ✅ "Run build to verify changes using shell:exec pnpm build"

3. Focus on CODE IMPLEMENTATION, not project management:
   - Read specific files identified in research (fs:read)
   - Create new files (fs:write)
   - Modify existing files (fs:edit)
   - Run build/test commands (shell:exec)
   - Use mind:rag-query ONLY if you need additional specific information

4. Be REALISTIC about what an agent can do autonomously:
   - Can research codebase and find patterns
   - Can write and modify code
   - Can run builds and tests
   - CANNOT interview people, configure cloud infrastructure, or deploy to production

5. Generate an IMPLEMENTATION PLAN, not a research plan:
   - ✅ DO: "Create X file", "Modify Y function", "Add Z interface"
   - ❌ DON'T: "Analyze architecture", "Research patterns", "Understand codebase"
   - Research is ALREADY DONE (see RESEARCH FINDINGS section)

Generate a practical execution plan using the plan_generate tool. Each step MUST specify a tool. Be specific and executable.`;
  }

  /**
   * Get mode-specific context for plan generation
   */
  private getModeContext(mode: AgentMode): string {
    switch (mode) {
      case 'plan':
        return 'Focus on generating a comprehensive plan without execution. Include research, design, and implementation phases.';
      case 'edit':
        return 'Focus on file modifications. Start with reading existing files, then editing them. No new file creation unless necessary.';
      case 'debug':
        return 'Focus on error investigation. Include trace analysis, root cause identification, and fix implementation.';
      case 'execute':
      default:
        return 'Focus on complete task execution from start to finish.';
    }
  }

}
