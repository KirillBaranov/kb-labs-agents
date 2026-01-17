# Agent-Aware Orchestration - Implementation Plan

**Status:** Planning
**Date:** 2026-01-17
**Goal:** Enable AdaptiveOrchestrator to select specialist agents for each subtask

---

## ⚠️ CRITICAL: LLM Configuration Philosophy

**Agents use ABSTRACT tiers, NOT concrete models:**

```yaml
# ✅ CORRECT - Abstract tier
llm:
  tier: small              # Platform resolves to actual model via kb.config.json

# ❌ WRONG - Hardcoded model
llm:
  model: gpt-4o-mini       # DO NOT DO THIS!
```

**Why?**
- **Flexibility**: Change models globally in `.kb/kb.config.json` without touching agents
- **Cost optimization**: Easily swap providers/models based on pricing
- **Future-proof**: New models get picked up automatically
- **Tier mapping** (from `.kb/kb.config.json`):
  - `small` → `gpt-4o-mini` (OpenAI)
  - `medium` → `claude-sonnet-4-5-20250929` (Anthropic via VibeProxy)
  - `large` → `claude-opus-4-5-20251101` (Anthropic via VibeProxy)

**Migration note:** All existing agents with `model:` field will be updated to use `tier:` instead.

---

## 🎯 Vision

Transform the orchestrator from **tier-only** selection to **agent + tier** selection:

**Current:**
```
User Task → Orchestrator → [subtask1: medium, subtask2: small, subtask3: large]
                                ↓
                         Generic LLM calls
```

**Target:**
```
User Task → Orchestrator → [subtask1: devkit-assistant + small,
                             subtask2: mind-specialist + medium,
                             subtask3: general-assistant + small]
                                ↓
                         Agent-specific execution with context
```

---

## 📦 Phase 1: Agent Metadata Schema

**Goal:** Add lightweight metadata to agent.yml for orchestrator discovery

### Tasks:

#### 1.1 Define metadata schema in agent.yml

Add `metadata` section to existing agent.yml schema:

```yaml
schema: kb.agent/1
id: devkit-assistant
name: DevKit Assistant
description: Expert in KB Labs DevKit monorepo management tools

# NEW: Metadata for orchestrator (lightweight info)
metadata:
  specialty: devkit               # Primary domain
  tags: [monorepo, dependencies, validation, health-check]

  # Brief capabilities for matching
  capabilities:
    - Check and fix broken imports
    - Find duplicate dependencies
    - Validate package structure
    - Run monorepo health checks

  # Keywords for semantic matching
  keywords: [devkit, imports, dependencies, duplicates, health, monorepo, pnpm, packages]

# Existing fields...
llm:
  tier: small                    # small | medium | large (NOT model name!)
  temperature: 0.0
  maxTokens: 5000
  maxToolCalls: 20

# Short prompt for orchestrator (summary only)
prompt:
  # This is what orchestrator sees (keep it brief!)
  systemPrompt: |
    You are DevKit specialist. Use kb-devkit-* commands to manage monorepo.

  # Full context in separate file (orchestrator doesn't see this)
  contextFile: context.md

tools:
  kbLabs:
    mode: allowlist
    allow:
      - "devkit:*"
  shell:
    enabled: true
    mode: allowlist
    allow:
      - "npx kb-devkit-*"

policies:
  allowWrite: false
  maxExecutionTime: 300000
```

#### 1.2 Create TypeScript interfaces

**File:** `packages/agent-contracts/src/agent-metadata.ts`

```typescript
/**
 * Agent metadata for orchestrator discovery
 */
export interface AgentMetadata {
  id: string;
  name: string;
  description: string;

  specialty: string;                 // Primary domain: 'devkit' | 'mind' | 'workflow' | 'general'
  tags: string[];                    // ['monorepo', 'dependencies', etc.]
  capabilities: string[];            // Brief list of what agent can do
  keywords: string[];                // Keywords for semantic matching
}

/**
 * Full agent config with metadata
 */
export interface AgentConfig {
  schema: string;
  id: string;
  name: string;
  description: string;
  metadata?: AgentMetadata;          // Optional - legacy agents don't have it
  llm: {
    tier: 'small' | 'medium' | 'large';  // Abstract tier, NOT model name
    temperature: number;
    maxTokens: number;
    maxToolCalls: number;
  };
  prompt: {
    systemPrompt: string;
    contextFile?: string;            // Optional - path to context.md
  };
  tools: Record<string, any>;
  policies: Record<string, any>;
}
```

#### 1.3 Update existing agents with metadata

Add `metadata` section to all current agents:

- **devkit-assistant** - DevKit tools specialist
- **mind-specialist** - Mind RAG specialist
- **general-assistant** - General-purpose fallback
- **code-analyzer** - Code analysis (keep as-is, becomes general)
- **coder** - Code writing
- **executor** - Command execution

**Deliverables:**
- ✅ Updated schema documentation
- ✅ TypeScript interfaces in agent-contracts
- ✅ 6 agents with metadata sections
- ✅ Example context.md files

---

## 📦 Phase 2: Orchestrator Agent Registry

**Goal:** Dynamic agent discovery for orchestrator planning

### Tasks:

#### 2.1 Create OrchestratorAgentRegistry

**File:** `packages/adaptive-orchestrator/src/agent-registry.ts`

```typescript
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { load as loadYaml } from 'js-yaml';
import type { AgentMetadata } from '@kb-labs/agent-contracts';

/**
 * Agent registry for orchestrator
 * Dynamically loads agent metadata from .kb/agents/
 */
export class OrchestratorAgentRegistry {
  private agents: Map<string, AgentMetadata> = new Map();
  private agentsDir: string;

  constructor(agentsDir: string = '.kb/agents') {
    this.agentsDir = agentsDir;
  }

  /**
   * Load all agents from filesystem
   */
  async loadAgents(): Promise<void> {
    const dirs = await readdir(this.agentsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const configPath = join(this.agentsDir, dir.name, 'agent.yml');

      try {
        const content = await readFile(configPath, 'utf-8');
        const config = loadYaml(content) as any;

        // Extract metadata (if exists)
        const metadata: AgentMetadata = {
          id: config.id,
          name: config.name,
          description: config.description,
          specialty: config.metadata?.specialty || 'general',
          tags: config.metadata?.tags || [],
          capabilities: config.metadata?.capabilities || [],
          keywords: config.metadata?.keywords || [],
        };

        this.agents.set(config.id, metadata);
      } catch (error) {
        // Skip invalid agents
        console.warn(`Failed to load agent: ${dir.name}`, error);
      }
    }
  }

  /**
   * Get all agents
   */
  getAll(): AgentMetadata[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent by ID
   */
  get(id: string): AgentMetadata | undefined {
    return this.agents.get(id);
  }

  /**
   * Find agents by tags
   */
  findByTags(tags: string[]): AgentMetadata[] {
    return this.getAll().filter(agent =>
      tags.some(tag => agent.tags.includes(tag))
    );
  }

  /**
   * Find agents by specialty
   */
  findBySpecialty(specialty: string): AgentMetadata[] {
    return this.getAll().filter(agent => agent.specialty === specialty);
  }

  /**
   * Find agents by keyword match
   */
  findByKeywords(query: string): AgentMetadata[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(agent =>
      agent.keywords.some(keyword => lowerQuery.includes(keyword))
    );
  }

  /**
   * Format agents for orchestrator prompt
   */
  toPromptFormat(): string {
    return this.getAll()
      .map(agent => `
**${agent.name}** (ID: ${agent.id})
- Specialty: ${agent.specialty}
- Tags: ${agent.tags.join(', ')}
- Capabilities:
${agent.capabilities.map(c => `  • ${c}`).join('\n')}
- Keywords: ${agent.keywords.join(', ')}
      `.trim())
      .join('\n\n---\n\n');
  }
}
```

#### 2.2 Add tests for registry

**File:** `packages/adaptive-orchestrator/src/agent-registry.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { OrchestratorAgentRegistry } from './agent-registry.js';

describe('OrchestratorAgentRegistry', () => {
  it('should load agents from directory', async () => {
    const registry = new OrchestratorAgentRegistry('.kb/agents');
    await registry.loadAgents();

    const agents = registry.getAll();
    expect(agents.length).toBeGreaterThan(0);
  });

  it('should find agents by tags', async () => {
    const registry = new OrchestratorAgentRegistry('.kb/agents');
    await registry.loadAgents();

    const devkitAgents = registry.findByTags(['devkit', 'monorepo']);
    expect(devkitAgents.length).toBeGreaterThan(0);
  });

  it('should find agents by keywords', async () => {
    const registry = new OrchestratorAgentRegistry('.kb/agents');
    await registry.loadAgents();

    const agents = registry.findByKeywords('fix imports');
    expect(agents.some(a => a.id === 'devkit-assistant')).toBe(true);
  });

  it('should format agents for prompt', async () => {
    const registry = new OrchestratorAgentRegistry('.kb/agents');
    await registry.loadAgents();

    const prompt = registry.toPromptFormat();
    expect(prompt).toContain('DevKit Assistant');
    expect(prompt).toContain('Specialty:');
    expect(prompt).toContain('Capabilities:');
  });
});
```

**Deliverables:**
- ✅ OrchestratorAgentRegistry class
- ✅ Tests (4 passing)
- ✅ YAML parsing with js-yaml
- ✅ Prompt formatting function

---

## 📦 Phase 3: Update Subtask Types

**Goal:** Add `agentId` field to subtask interface

### Tasks:

#### 3.1 Update Subtask interface

**File:** `packages/adaptive-orchestrator/src/types.ts`

```typescript
export interface Subtask {
  id: number;
  description: string;
  tier: LLMTier;              // 'small' | 'medium' | 'large'
  agentId?: string;           // NEW: Optional agent to execute this subtask
  reasoning?: string;         // NEW: Why this agent was chosen
}

export interface SubtaskResult {
  id: number;
  status: 'success' | 'failure';
  result: string;
  tier: LLMTier;
  agentId?: string;           // NEW: Which agent executed this
  tokens?: number;
  durationMs?: number;
  escalated?: boolean;
  escalationReason?: string;
}
```

#### 3.2 Update analytics to track agent usage

**File:** `packages/adaptive-orchestrator/src/analytics.ts`

Add agent tracking to events:

```typescript
trackSubtaskExecuted(result: SubtaskResult): void {
  if (!this.analytics) return;

  this.analytics.track(ORCHESTRATION_EVENTS.SUBTASK_EXECUTED, {
    subtask_id: result.id,
    status: result.status,
    tier: result.tier,
    agentId: result.agentId || 'generic',  // NEW: Track which agent
    tokens: result.tokens || 0,
    timestamp: Date.now(),
  });
}

// NEW: Track agent selection
trackAgentSelected(subtaskId: number, agentId: string, reason: string): void {
  if (!this.analytics) return;

  this.analytics.track('orchestration.agent.selected', {
    subtask_id: subtaskId,
    agent_id: agentId,
    reason_length: reason.length,
    timestamp: Date.now(),
  });
}
```

**Deliverables:**
- ✅ Updated Subtask interface
- ✅ Updated SubtaskResult interface
- ✅ New analytics events
- ✅ Backward compatibility (agentId optional)

---

## 📦 Phase 4: Planning with Agent Selection

**Goal:** Teach orchestrator to choose agents during planning

### Tasks:

#### 4.1 Update planning prompt

**File:** `packages/adaptive-orchestrator/src/orchestrator.ts`

```typescript
async function planSubtasks(
  task: string,
  tier: LLMTier,
  agentRegistry: OrchestratorAgentRegistry
): Promise<Subtask[]> {

  // Load available agents
  await agentRegistry.loadAgents();
  const agentsInfo = agentRegistry.toPromptFormat();

  const prompt = `
You are a master orchestrator for the KB Labs platform.

## Available Specialist Agents

${agentsInfo}

## Task Analysis

User task: "${task}"

## Your Job

Break down this task into subtasks and assign:
1. **Tier** (small/medium/large) - Based on complexity
2. **Agent** (optional) - Specialist agent if task matches their domain

## Agent Selection Guidelines

- Match task keywords to agent keywords/tags
- Use specialist when task clearly fits their domain
- Use "general-assistant" as fallback
- Leave agentId empty if unsure (will use generic LLM)

## Tier Selection Guidelines

- **small**: Simple, deterministic tasks (lookups, checks, validation)
- **medium**: Standard development tasks (analysis, basic implementation)
- **large**: Complex reasoning, architecture decisions, multi-file coordination

## Output Format

Return ONLY valid JSON (no markdown, no explanations):

{
  "subtasks": [
    {
      "id": 1,
      "description": "Check for broken imports using DevKit",
      "tier": "small",
      "agentId": "devkit-assistant",
      "reasoning": "DevKit assistant has kb-devkit-check-imports command and 'imports' keyword"
    },
    {
      "id": 2,
      "description": "Analyze import errors and suggest fixes",
      "tier": "medium",
      "agentId": "general-assistant",
      "reasoning": "General analysis task, no specific specialist needed"
    }
  ]
}

CRITICAL: Output ONLY the JSON object. No markdown fences, no explanations.
`;

  const llm = useLLM({ tier: 'large' });
  const response = await llm.chat(prompt);

  return parseSubtasks(response);
}
```

#### 4.2 Improve JSON parsing

```typescript
function parseSubtasks(response: string): Subtask[] {
  try {
    // Remove markdown code fences if present
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/```json\n?/, '').replace(/```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/```\n?/, '').replace(/```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) {
      throw new Error('Invalid subtasks format');
    }

    return parsed.subtasks.map((st: any) => ({
      id: st.id,
      description: st.description,
      tier: st.tier,
      agentId: st.agentId || undefined,  // Optional
      reasoning: st.reasoning || undefined,
    }));
  } catch (error) {
    throw new Error(`Failed to parse subtasks: ${error.message}`);
  }
}
```

**Deliverables:**
- ✅ Updated planning prompt with agents
- ✅ Robust JSON parsing
- ✅ Agent selection reasoning
- ✅ Fallback to generic if no agent

---

## 📦 Phase 5: Execution with Agent Context

**Goal:** Execute subtasks using agent-specific context

### Tasks:

#### 5.1 Load agent config and context

**File:** `packages/adaptive-orchestrator/src/executor.ts`

```typescript
import { AgentRegistry } from '@kb-labs/agent-core';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function loadAgentContext(agentId: string): Promise<{
  config: any;
  context: any;
  tools: any[];
}> {
  const registry = new AgentRegistry(/* ctx */);

  // Load agent config
  const config = await registry.loadConfig(agentId);

  // Load context.md if exists
  let contextMd = '';
  const contextPath = join('.kb/agents', agentId, 'context.md');
  try {
    contextMd = await readFile(contextPath, 'utf-8');
  } catch {
    // No context.md - that's ok
  }

  // Load agent-specific context
  const agentContext = await registry.loadContext(agentId, config);

  // Discover tools
  const toolDiscoverer = new ToolDiscoverer(/* ctx */);
  const tools = await toolDiscoverer.discover(config.tools || {});

  return {
    config,
    context: {
      ...agentContext,
      systemPrompt: config.prompt.systemPrompt,
      contextMd,  // Additional context from md file
    },
    tools,
  };
}
```

#### 5.2 Update executeSubtask

```typescript
async function executeSubtask(
  subtask: Subtask,
  agentRegistry: OrchestratorAgentRegistry,
  maxEscalations: number = 2
): Promise<SubtaskResult> {

  const startTime = Date.now();
  let currentTier = subtask.tier;
  let escalations = 0;

  // Track agent selection
  if (subtask.agentId && analytics) {
    analytics.trackAgentSelected(
      subtask.id,
      subtask.agentId,
      subtask.reasoning || 'No reasoning provided'
    );
  }

  while (escalations <= maxEscalations) {
    try {
      let result: string;

      // Execute with agent context if specified
      if (subtask.agentId) {
        const agentMeta = agentRegistry.get(subtask.agentId);

        if (!agentMeta) {
          throw new Error(`Agent not found: ${subtask.agentId}`);
        }

        // Load full agent config and context
        const { config, context, tools } = await loadAgentContext(subtask.agentId);

        // Execute with agent-specific context
        result = await executeWithAgentContext(
          subtask.description,
          context,
          tools,
          currentTier
        );
      } else {
        // Fallback - plain LLM call
        result = await executePlainLLM(subtask.description, currentTier);
      }

      return {
        id: subtask.id,
        status: 'success',
        result,
        tier: currentTier,
        agentId: subtask.agentId,
        tokens: /* track tokens */,
        durationMs: Date.now() - startTime,
        escalated: escalations > 0,
      };

    } catch (error) {
      // Escalation logic
      if (escalations < maxEscalations) {
        const nextTier = escalateTier(currentTier);
        analytics?.trackTierEscalated(
          subtask.id,
          currentTier,
          nextTier,
          error.message
        );
        currentTier = nextTier;
        escalations++;
      } else {
        throw error;
      }
    }
  }
}
```

#### 5.3 Execute with agent context

```typescript
async function executeWithAgentContext(
  task: string,
  context: any,
  tools: any[],
  tier: LLMTier
): Promise<string> {

  // Build prompt with agent context
  const systemPrompt = `
${context.systemPrompt}

${context.contextMd ? '\n## Additional Context\n' + context.contextMd : ''}

## Your Task
${task}
  `.trim();

  const llm = useLLM({ tier });

  // Execute with tools (native tool calling)
  const result = await llm.chatWithTools(
    systemPrompt,
    tools,
    { maxToolCalls: context.config?.llm?.maxToolCalls || 20 }
  );

  return result.content;
}
```

**Deliverables:**
- ✅ Agent context loading
- ✅ context.md support
- ✅ Tool discovery integration
- ✅ Agent-specific execution
- ✅ Fallback to generic LLM

---

## 📦 Phase 6: Progress Reporting

**Goal:** Update progress reporter to show agent assignments

### Tasks:

#### 6.1 Update ProgressEvent types

**File:** `packages/progress-reporter/src/types.ts`

```typescript
export type ProgressEvent =
  | {
      type: 'subtask_started';
      data: {
        subtaskId: number;
        description: string;
        tier: LLMTier;
        agentId?: string;        // NEW
        agentName?: string;      // NEW
      };
    }
  | {
      type: 'subtask_completed';
      data: {
        subtaskId: number;
        description: string;
        tier: LLMTier;
        agentId?: string;        // NEW
        agentName?: string;      // NEW
      };
    }
  // ... other events
```

#### 6.2 Update CLI output

**File:** `packages/agent-cli/src/cli/commands/run.ts`

```typescript
case 'subtask_started':
  const subtaskEmoji = getTierEmoji(event.data.tier);
  const agentLabel = event.data.agentName
    ? `[${event.data.agentName}]`
    : '';

  ctx.ui.write(
    `${timestamp} ${subtaskEmoji} [${event.data.subtaskId}] ${agentLabel} Starting: ${event.data.description}`
  );
  break;
```

**Example output:**
```
00:04 🟢 [1] [DevKit Assistant] Starting: Check broken imports
00:12 ✓ [1] [DevKit Assistant] Completed: Check broken imports
00:13 🟡 [2] [General Assistant] Starting: Analyze import errors
```

**Deliverables:**
- ✅ Updated progress events
- ✅ CLI output with agent names
- ✅ Visual distinction for specialists

---

## 📦 Phase 7: Testing & Documentation

### Tasks:

#### 7.1 Integration tests

```typescript
describe('Agent-Aware Orchestration', () => {
  it('should select devkit-assistant for import fixes', async () => {
    const orchestrator = new AdaptiveOrchestrator(logger);
    const result = await orchestrator.execute('Fix broken imports');

    expect(result.status).toBe('success');
    expect(result.subtaskResults?.some(r => r.agentId === 'devkit-assistant')).toBe(true);
  });

  it('should fallback to generic LLM when no agent matches', async () => {
    const orchestrator = new AdaptiveOrchestrator(logger);
    const result = await orchestrator.execute('Explain quantum computing');

    expect(result.status).toBe('success');
    expect(result.subtaskResults?.every(r => !r.agentId)).toBe(true);
  });
});
```

#### 7.2 Update documentation

**Files to update:**
- `ADAPTIVE-ORCHESTRATION-SUMMARY.md` - Add agent-aware section
- `ADAPTIVE-ORCHESTRATION-QUICKSTART.md` - Update examples
- `packages/adaptive-orchestrator/README.md` - Document agent selection

**Deliverables:**
- ✅ Integration tests (5+ scenarios)
- ✅ Updated documentation
- ✅ Migration guide for existing agents

---

## 🚀 Rollout Plan

### Stage 1: Core Infrastructure (Week 1)
- Phase 1: Agent metadata schema
- Phase 2: Agent registry
- Phase 3: Type updates

### Stage 2: Orchestrator Integration (Week 2)
- Phase 4: Planning with agents
- Phase 5: Execution with agents

### Stage 3: Polish & Testing (Week 3)
- Phase 6: Progress reporting
- Phase 7: Tests & docs
- Production deployment

---

## 📊 Success Metrics

**Functional:**
- ✅ Orchestrator selects correct specialist 80%+ of the time
- ✅ Agent selection reasoning is clear
- ✅ Fallback to generic works reliably
- ✅ 100% backward compatible (agents without metadata work)

**Performance:**
- ✅ Agent loading < 100ms
- ✅ Planning time < 5s (no regression)
- ✅ Cost savings maintained (67-80%)

**Quality:**
- ✅ All tests passing
- ✅ Zero breaking changes
- ✅ Clear documentation

---

## 🔧 Technical Decisions

### Why `metadata` section?
- Keeps orchestrator prompt lightweight
- Agent context.md can be detailed without bloating planning
- Easy to add new metadata fields without breaking changes

### Why optional `agentId`?
- Backward compatibility with existing agents
- Orchestrator can fallback to generic LLM
- Gradual migration path

### Why `contextFile` in prompt?
- Separates orchestrator view (brief) from agent execution (detailed)
- Reduces token usage in planning phase
- Allows rich context without prompt pollution

---

## 📝 Next Steps After Completion

1. **Agent Marketplace** - Allow plugins to register agents
2. **Agent Learning** - Track which agents work best for which tasks
3. **Multi-Agent Collaboration** - Agents can delegate to other agents
4. **RAG for Agent Discovery** - Semantic search over agent capabilities

---

**Ready to start Phase 1?** 🚀
