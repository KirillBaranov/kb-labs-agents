# KB Labs Agents - Development Plan
## Orchestrator + Specialists + Playbooks Architecture

**Created:** 2026-01-15
**Status:** Planning Phase
**Goal:** Build hierarchical agent system with playbook guidance

---

## 🎯 Vision

Build a cost-effective, scalable agent system where:
- **Orchestrator** (expensive model) does high-level planning and delegation
- **Specialists** (cheap models) execute focused tasks with filtered tools
- **Playbooks** provide accumulated domain expertise for common patterns

**Target metrics:**
- 11x cheaper than Claude solo
- 126x cheaper than Senior Dev
- 2.4x faster than Claude solo
- Consistent 9/10 quality through playbooks

---

## 📋 Development Phases

### Phase 1: Tools Filtering System ⭐ START HERE

**Goal:** Enable granular control over which tools each specialist can use

**Why critical:**
- Prevents tool confusion (fs:search vs mind:rag-query)
- Enforces specialist boundaries
- Reduces context size for better LLM performance

#### Tasks:

**1.1 Update Type Definitions**
- File: `kb-labs-agents/packages/agent-contracts/src/agent-config.ts`
- Changes:
  ```typescript
  export interface AgentFilesystemConfig {
    enabled: boolean;
    mode?: 'allowlist' | 'denylist';  // NEW
    allow?: string[];                  // NEW
    deny?: string[];                   // NEW
    permissions?: AgentFilesystemPermissions;
  }

  export interface AgentKBLabsToolsConfig {
    enabled: boolean;
    mode: 'allowlist' | 'denylist';
    allow?: string[];
    deny?: string[];
  }

  export interface AgentShellConfig {
    enabled: boolean;
    mode?: 'allowlist' | 'denylist';  // NEW
    allow?: string[];                  // NEW (was allowedCommands)
    deny?: string[];                   // NEW
    allowedCommands?: string[];        // DEPRECATED (keep for compat)
  }
  ```

**1.2 Implement filterTools() in ToolDiscoverer**
- File: `kb-labs-agents/packages/agent-core/src/tools/tool-discoverer.ts`
- Add methods:
  ```typescript
  private filterTools(
    tools: ToolDefinition[],
    mode?: 'allowlist' | 'denylist',
    allow?: string[],
    deny?: string[]
  ): ToolDefinition[]

  private matchesPattern(toolName: string, pattern: string): boolean
  ```
- Support glob patterns: `"mind:*"`, `"devkit:check-*"`
- Update `discover()` method to filter filesystem, shell, kbLabs tools

**1.3 Update mind-assistant config**
- File: `.kb/agents/mind-assistant/agent.yml`
- Changes:
  ```yaml
  tools:
    filesystem:
      enabled: true
      mode: allowlist
      allow:
        - "fs:read"     # Only read found files
        - "fs:list"     # Only list directories
        # NO fs:search - use mind:rag-query instead

    kbLabs:
      enabled: true
      mode: allowlist
      allow:
        - "mind:rag-query"
        - "mind:rag-status"

    shell:
      enabled: false
  ```

**1.4 Build and Test**
- Build: `pnpm --filter @kb-labs/agent-core run build`
- Build: `pnpm --filter @kb-labs/agent-cli run build`
- Clear cache: `pnpm kb plugins clear-cache`
- Test: `pnpm kb agent:run --agentId=mind-assistant --task="What is VectorStore?"`
- Expected: Agent uses ONLY mind:rag-query (no fs:search available)

**Success criteria:**
- ✅ mind-assistant has only 3 tools: mind:rag-query, fs:read, fs:list
- ✅ Query "What is VectorStore?" uses mind:rag-query, NOT fs:search
- ✅ No tool confusion loops

**Estimated time:** 3-4 hours
**Estimated cost to test:** $0.05

---

### Phase 2: Specialized Agents

**Goal:** Create focused specialists with clear boundaries

#### 2.1 Redesign code-reviewer → Bug Hunter

Create: `.kb/agents/typescript-bug-hunter/agent.yml`

```yaml
schema: kb.agent/1
id: typescript-bug-hunter
name: TypeScript Bug Hunter
description: Finds common TypeScript bugs (null checks, type errors, async issues)

llm:
  model: gpt-4o-mini  # Cheap specialist
  temperature: 0.2
  maxTokens: 3000
  maxToolCalls: 10

prompt:
  system: |
    You are a TypeScript bug detection specialist.

    You ONLY look for these bug patterns:
    1. Missing null/undefined checks
    2. Unhandled promise rejections (async without try/catch)
    3. Type assertions that hide errors (as any, as unknown)
    4. React hooks in conditionals
    5. Missing error boundaries in React

    Output format (JSON):
    {
      "bugs": [
        {
          "file": "src/foo.ts",
          "line": 42,
          "severity": "HIGH|MEDIUM|LOW",
          "type": "missing-null-check",
          "description": "Variable 'user' could be null",
          "suggestion": "Add null check: if (!user) return;"
        }
      ]
    }

    DO NOT review: style, naming, performance (other specialists do that)

tools:
  filesystem:
    enabled: true
    mode: allowlist
    allow:
      - "fs:read"

  kbLabs:
    enabled: true
    mode: allowlist
    allow:
      - "mind:rag-query"  # Find similar bugs in codebase

  shell:
    enabled: false

policies:
  maxExecutionTime: 120000  # 2 minutes
  requireConfirmation: false
```

#### 2.2 Create security-scanner specialist

Create: `.kb/agents/security-scanner/agent.yml`

```yaml
id: security-scanner
name: Security Scanner
description: Finds security vulnerabilities (XSS, injection, exposed secrets)

prompt:
  system: |
    You are a security vulnerability specialist.

    You ONLY scan for:
    1. SQL injection risks (string concatenation in queries)
    2. XSS vulnerabilities (unescaped user input in HTML)
    3. Exposed API keys/secrets (hardcoded credentials)
    4. Unsafe eval/exec usage
    5. CORS misconfigurations

    Output: JSON with CVE-style severity ratings

tools:
  filesystem:
    enabled: true
    mode: allowlist
    allow: ["fs:read"]

  kbLabs:
    enabled: true
    mode: allowlist
    allow: ["mind:rag-query"]  # Find security patterns
```

#### 2.3 Create code-writer specialist

Create: `.kb/agents/code-writer/agent.yml`

```yaml
id: code-writer
name: Code Writer
description: Writes new code files following project patterns

llm:
  model: gpt-4o-mini
  temperature: 0.3
  maxTokens: 4000
  maxToolCalls: 15

prompt:
  system: |
    You are a code generation specialist.

    Your job:
    1. Find existing code patterns using mind:rag-query
    2. Follow discovered patterns exactly
    3. Write clean, well-structured code
    4. Verify code builds after creation

    Always:
    - Search for similar code first
    - Use consistent naming conventions
    - Follow project's TypeScript style
    - Add JSDoc comments for public APIs

tools:
  filesystem:
    enabled: true
    mode: allowlist
    allow:
      - "fs:read"
      - "fs:write"
      - "fs:list"

  kbLabs:
    enabled: true
    mode: allowlist
    allow:
      - "mind:rag-query"

  shell:
    enabled: true
    mode: allowlist
    allow:
      - "pnpm build"
      - "pnpm test"
```

#### 2.4 Create devkit-specialist

Create: `.kb/agents/devkit-specialist/agent.yml`

```yaml
id: devkit-specialist
name: DevKit Specialist
description: Validates dependencies, build order, and monorepo health

llm:
  model: gpt-4o-mini
  temperature: 0.1
  maxTokens: 3000
  maxToolCalls: 12

prompt:
  system: |
    You are a monorepo integration specialist.

    Your job:
    1. Check for missing dependencies (kb-devkit-check-imports)
    2. Validate build order (kb-devkit-build-order)
    3. Check for circular dependencies
    4. Ensure packages build successfully
    5. Run full devkit CI if needed

    Always fix issues found by devkit tools.

tools:
  filesystem:
    enabled: true
    mode: allowlist
    allow:
      - "fs:read"
      - "fs:edit"  # Fix package.json

  shell:
    enabled: true
    mode: allowlist
    allow:
      - "pnpm install"
      - "npx kb-devkit-*"  # All devkit commands
      - "pnpm --filter * run build"
```

#### 2.5 Create docs-writer specialist

Already exists in `.kb/agents/`, just needs tools filtering:

```yaml
tools:
  filesystem:
    enabled: true
    mode: allowlist
    allow:
      - "fs:read"
      - "fs:write"  # Can create/edit docs
      - "fs:list"

  kbLabs:
    enabled: true
    mode: allowlist
    allow:
      - "mind:rag-query"  # Find existing doc patterns
```

**Success criteria:**
- ✅ 5 focused specialists created
- ✅ Each has clear, narrow responsibility
- ✅ Tools properly filtered for safety
- ✅ All use cheap gpt-4o-mini model

**Estimated time:** 4-5 hours
**Estimated cost to test:** $0.20

---

### Phase 3: Playbooks Plugin (Separate from Agents)

**Goal:** Playbooks as an independent plugin with RAG-based search

**Architecture Decision:** Playbooks are NOT tightly coupled with agents.
- Playbooks = hints/guidance stored in vector store
- Orchestrator can REQUEST hints via `playbooks:search` tool
- Orchestrator DECIDES whether to use hints or ignore them
- Loose coupling = flexibility + testability

#### 3.0 Prerequisites: VectorStore Namespace Support (Breaking Change)

**Architecture Decision:** `platform.vectorStore(namespace)` - function-based API.

No backward compatibility. Clean break from `platform.vectorStore` as object.

##### 3.0.1 New API Design

```typescript
// PlatformServices interface (kb-labs-plugin/packages/plugin-contracts)
interface PlatformServices {
  // OLD (remove):
  // vectorStore: IVectorStore;

  // NEW: Function that returns scoped store
  vectorStore(namespace: string): IVectorStore;
}

// Usage in plugin
const playbooks = platform.vectorStore('playbooks');  // scoped to 'playbooks'
const templates = platform.vectorStore('templates');  // scoped to 'templates'

await playbooks.upsert(vectors);   // writes to 'playbooks' namespace
await playbooks.search(query, 10); // searches in 'playbooks' namespace

// Permission denied if namespace not in manifest
const mind = platform.vectorStore('mind');  // ❌ PermissionError
```

##### 3.0.2 IVectorStore Interface (unchanged, simple)

**File:** `kb-labs-core/packages/core-platform/src/adapters/vector-store.ts`

```typescript
// IVectorStore stays simple - no namespace logic here
export interface IVectorStore {
  search(query: number[], limit: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;
  upsert(vectors: VectorRecord[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  count(): Promise<number>;
  get?(ids: string[]): Promise<VectorRecord[]>;
  query?(filter: VectorFilter): Promise<VectorRecord[]>;
}
```

##### 3.0.3 Internal VectorStore Provider (new)

**File:** `kb-labs-core/packages/core-platform/src/adapters/vector-store-provider.ts`

```typescript
/**
 * Internal interface for vector store implementations.
 * NOT exposed to plugins - only used by platform internally.
 */
export interface IVectorStoreProvider {
  /** Get scoped store for namespace (creates if not exists) */
  collection(namespace: string): IVectorStore;

  /** List all namespaces (optional) */
  listNamespaces?(): Promise<string[]>;

  /** Delete namespace (admin operation) */
  deleteNamespace?(namespace: string): Promise<void>;
}
```

##### 3.0.4 Permission Check in governed.ts

**File:** `kb-labs-plugin/packages/plugin-runtime/src/platform/governed.ts`

```typescript
// OLD (remove):
// vectorStore: permissions.platform?.vectorStore
//   ? raw.vectorStore
//   : createDeniedService('vectorStore'),

// NEW: Function with permission check
vectorStore: (namespace: string): IVectorStore => {
  const allowed = permissions.platform?.vectorStore;

  // No permission at all
  if (!allowed) {
    throw new PermissionError('VectorStore access denied');
  }

  // Check namespace permission
  if (allowed !== true) {
    const collections = (allowed as { collections?: string[] }).collections ?? [];
    if (!collections.includes('*') && !collections.includes(namespace)) {
      throw new PermissionError(
        `VectorStore namespace '${namespace}' not allowed. ` +
        `Permitted: ${collections.join(', ')}`
      );
    }
  }

  // Return scoped store from internal provider
  return raw.vectorStoreProvider.collection(namespace);
}
```

##### 3.0.5 Manifest Permission Format

```typescript
// Playbooks plugin - access to 'playbooks' namespace only
permissions: {
  platform: {
    vectorStore: { collections: ['playbooks'] }
  }
}

// Mind plugin - access to 'mind' namespace (or '*' for all)
permissions: {
  platform: {
    vectorStore: { collections: ['mind'] }
    // or: vectorStore: true  // legacy, equivalent to ['*']
  }
}

// Multi-namespace plugin
permissions: {
  platform: {
    vectorStore: { collections: ['templates', 'snippets'] }
  }
}
```

##### 3.0.6 Implementation Updates Required

1. **IVectorStoreProvider** - new internal interface
2. **QdrantVectorStore** - implement `IVectorStoreProvider.collection()` using Qdrant collections
3. **MemoryVectorStore** - implement with `Map<namespace, VectorRecord[]>`
4. **LocalVectorStore** - implement with folders per namespace
5. **governed.ts** - change from object to function
6. **PlatformServices** - update interface
7. **Mind plugin** - update all usages: `platform.vectorStore` → `platform.vectorStore('mind')`
8. **useVectorStore()** helper - update or deprecate

##### 3.0.7 Migration for Mind Plugin

```typescript
// OLD (mind-engine)
const vectorStore = ctx.platform.vectorStore;
await vectorStore.upsert(chunks);

// NEW
const vectorStore = ctx.platform.vectorStore('mind');
await vectorStore.upsert(chunks);
```

**Estimated time for 3.0:** 3-4 hours
**Risk:** Breaking change, requires updating all vectorStore usages

#### 3.1 Create Playbooks Monorepo

```
kb-labs-playbooks/
├── packages/
│   ├── playbooks-store/        # Vector storage + indexing
│   │   └── src/
│   │       ├── indexer.ts      # Index .playbook.yml → vector store
│   │       ├── searcher.ts     # RAG search
│   │       └── schema.ts       # PlaybookV1 types
│   │
│   └── playbooks-cli/          # CLI plugin
│       └── src/
│           ├── commands/
│           │   ├── search.ts   # playbooks:search (RAG)
│           │   ├── get.ts      # playbooks:get (by ID)
│           │   ├── list.ts     # playbooks:list
│           │   └── index.ts    # playbooks:index (admin)
│           └── manifest.v3.ts
│
└── .kb/playbooks/              # Where playbooks are stored
    ├── add-feature.playbook.yml
    ├── refactor-code.playbook.yml
    └── debug-issue.playbook.yml
```

#### 3.2 Playbook Schema (with metadata for RAG)

```yaml
# .kb/playbooks/add-feature.playbook.yml

# === METADATA (for indexing & search) ===
id: add-feature
name: Add New Feature
version: 1.0.0

# For vector search (embedded as text)
description: |
  Best practices for adding new features to KB Labs monorepo.
  Covers project scaffolding, integration, documentation.

# For metadata filtering
tags:
  - feature
  - scaffolding
  - monorepo

triggers:  # Keyword fallback if vector search fails
  - "add feature"
  - "new feature"
  - "implement"

domain: kb-labs  # For multi-tenant filtering

# === CONTENT (returned to orchestrator as hints) ===
guidance:
  approach: |
    1. DISCOVERY: Find similar features using mind:rag-query
    2. DESIGN: Plan structure based on discovered patterns
    3. SCAFFOLD: Create packages following patterns
    4. INTEGRATE: Validate with devkit checks
    5. DOCUMENT: Update README and CLAUDE.md

  specialists:
    - id: mind-assistant
      when: "Finding existing patterns"
    - id: code-writer
      when: "Creating new files"
    - id: devkit-specialist
      when: "Validating dependencies"
    - id: docs-writer
      when: "Creating documentation"

  pitfalls:
    - "Don't create new patterns when existing ones work"
    - "Always run devkit-ci before committing"
    - "Update CLAUDE.md for AI discoverability"

  examples:
    - task: "Add notifications service"
      steps:
        - "mind-assistant: Find kb-labs-workflow structure"
        - "code-writer: Create kb-labs-notifications"
        - "devkit-specialist: Integrate into workspace"

  cost_estimate: "$0.10-0.15 typical"
```

#### 3.3 Plugin Commands

**`playbooks:search`** - RAG-based semantic search

```typescript
// Orchestrator calls this tool
{
  name: 'playbooks:search',
  input: {
    query: "How to add new feature to platform?",
    topK: 3,
    minConfidence: 0.5
  }
}

// Returns
{
  results: [
    {
      id: "add-feature",
      name: "Add New Feature",
      confidence: 0.87,
      matchedBy: "vector",  // or "triggers", "tags"
      summary: "Best practices for adding features..."
    }
  ]
}
```

**`playbooks:get`** - Get full playbook content

```typescript
{
  name: 'playbooks:get',
  input: {
    id: "add-feature",
    sections: ["guidance"]  // or "all"
  }
}

// Returns full guidance content
```

**`playbooks:list`** - List available playbooks

**`playbooks:index`** - Index playbooks (admin command)

```bash
pnpm kb playbooks:index --path=.kb/playbooks/
```

#### 3.4 How Orchestrator Uses Playbooks (Loose Coupling)

Orchestrator has `playbooks:search` and `playbooks:get` as available tools.
Orchestrator DECIDES when to use them - not automatic!

```
User: "Add notifications feature"

Orchestrator thinks:
  "Complex task, maybe there's a playbook for this"
  → Calls playbooks:search query="add feature"

  Result: [{ id: "add-feature", confidence: 0.87 }]

  "Found relevant playbook, let me get details"
  → Calls playbooks:get id="add-feature"

  Result: { guidance: { approach: "...", specialists: [...] } }

  "Playbook suggests: discovery → scaffold → integrate → document"
  "I'll follow this approach"
  → Delegates to mind-assistant, code-writer, etc.
```

**Key point:** Playbooks are HINTS, not commands. Orchestrator can ignore them.

#### 3.5 Example Playbooks to Create

1. **add-feature.playbook.yml** - Adding new features/projects
2. **refactor-code.playbook.yml** - Code refactoring patterns
3. **debug-issue.playbook.yml** - Debugging systematic approach
4. **write-docs.playbook.yml** - Documentation patterns
5. **code-review.playbook.yml** - Code review checklist

**Success criteria:**
- ✅ Playbooks plugin created (separate monorepo)
- ✅ VectorStore namespace support added
- ✅ RAG search works for playbooks
- ✅ Orchestrator can use `playbooks:search` and `playbooks:get`
- ✅ 5 example playbooks indexed
- ✅ Loose coupling - orchestrator works with or without playbooks

**Estimated time:** 6-8 hours
**Estimated cost to test:** $0.25

---

### Phase 4: Agent-to-Agent Communication

**Goal:** Orchestrator can invoke specialists and get structured results

#### 4.1 Design Agent Invocation API

Create: `kb-labs-agents/packages/agent-core/src/orchestration/agent-invoker.ts`

```typescript
export interface AgentInvocationRequest {
  agentId: string;
  task: string;
  context?: Record<string, any>;
  timeout?: number;
}

export interface AgentInvocationResult {
  success: boolean;
  result?: any;  // Specialist's structured output
  error?: {
    code: string;
    message: string;
  };
  metadata: {
    steps: number;
    tokensUsed: number;
    durationMs: number;
    cost: number;
  };
}

export class AgentInvoker {
  constructor(private ctx: PluginContextV3) {}

  /**
   * Invoke another agent and wait for result
   */
  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult>
}
```

#### 4.2 Add to Platform Context

Update: `@kb-labs/sdk` (or plugin-contracts)

```typescript
export interface PlatformAgents {
  /**
   * Invoke another agent
   */
  invoke(agentId: string, task: string): Promise<AgentInvocationResult>;

  /**
   * List available agents
   */
  list(): Promise<AgentMetadata[]>;
}

// Add to PluginContextV3
export interface PluginContextV3 {
  // ... existing
  platform: {
    // ... existing
    agents: PlatformAgents;  // NEW
  };
}
```

#### 4.3 Create Orchestrator Tool

Add to orchestrator's available tools:

```typescript
{
  name: 'agent:invoke',
  description: 'Invoke a specialist agent to perform a focused task',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        enum: ['mind-assistant', 'code-writer', 'devkit-specialist', 'docs-writer', 'typescript-bug-hunter'],
        description: 'ID of specialist agent to invoke'
      },
      task: {
        type: 'string',
        description: 'Task description for the specialist'
      }
    },
    required: ['agentId', 'task']
  }
}
```

**Success criteria:**
- ✅ Orchestrator can call `agent:invoke` tool
- ✅ Specialists execute and return structured results
- ✅ Results include metadata (cost, tokens, duration)

**Estimated time:** 3-4 hours
**Estimated cost to test:** $0.20

---

### Phase 5: End-to-End Integration & Testing

**Goal:** Full orchestrator → playbook → specialists flow works

#### 5.1 Create Orchestrator Agent

Create: `.kb/agents/orchestrator/agent.yml`

```yaml
schema: kb.agent/1
id: orchestrator
name: Main Orchestrator
description: High-level task planning and specialist delegation

llm:
  model: claude-sonnet-4.5  # Expensive but smart
  temperature: 0.2
  maxTokens: 8000
  maxToolCalls: 30

prompt:
  system: |
    You are a senior engineering manager who delegates to specialist agents.

    Your responsibilities:
    1. Understand high-level user tasks
    2. Break down into subtasks
    3. Delegate to appropriate specialists
    4. Synthesize results into final answer

    Available specialists:
    - mind-assistant: Semantic code search
    - code-writer: Write new code
    - typescript-bug-hunter: Find TypeScript bugs
    - security-scanner: Find security issues
    - devkit-specialist: Monorepo validation
    - docs-writer: Documentation

    Use agent:invoke tool to delegate subtasks.
    Always follow playbook guidance when available.

tools:
  kbLabs:
    enabled: true
    mode: allowlist
    allow:
      - "agent:invoke"  # Can call other agents
      - "agent:list"

  filesystem:
    enabled: true
    mode: allowlist
    allow:
      - "fs:read"   # Can read for context
      - "fs:list"

  shell:
    enabled: false  # Delegates to specialists
```

#### 5.2 Integration Test: Add Feature

Test scenario: "Add notifications feature"

```bash
pnpm kb agent:run \
  --agentId=orchestrator \
  --task="Add kb-labs-notifications project with email and push providers"
```

Expected flow:
1. Orchestrator loads "add-feature" playbook
2. Invokes mind-assistant: "Find similar project structures"
3. Invokes code-writer: "Create notifications packages"
4. Invokes devkit-specialist: "Integrate into monorepo"
5. Invokes docs-writer: "Create documentation"
6. Returns summary to user

Expected metrics:
- Time: ~9 minutes
- Cost: ~$0.71
- Quality: 9/10

#### 5.3 Integration Test: Debug Bug

Test scenario: "Investigate why tests are failing"

```bash
pnpm kb agent:run \
  --agentId=orchestrator \
  --task="Tests in workflow-runtime are failing. Find and fix the issue."
```

Expected flow:
1. Orchestrator loads "debug-production" playbook
2. Invokes mind-assistant: "Find related test code"
3. Invokes typescript-bug-hunter: "Scan for common bugs"
4. Invokes code-writer: "Fix identified bugs"
5. Returns fix summary

#### 5.4 Integration Test: Refactor

Test scenario: "Refactor notification service"

```bash
pnpm kb agent:run \
  --agentId=orchestrator \
  --task="Refactor NotificationService to use observer pattern"
```

Expected flow:
1. Orchestrator loads "refactor-code" playbook
2. Invokes mind-assistant: "Find all NotificationService usages"
3. Invokes code-writer: "Refactor incrementally"
4. Invokes devkit-specialist: "Validate no breakage"

**Success criteria:**
- ✅ All 3 integration tests pass
- ✅ Costs match projections (~$0.71 per task)
- ✅ Time matches projections (~9 min per task)
- ✅ Quality is 9/10 or higher

**Estimated time:** 4-5 hours
**Estimated cost to test:** $2.50

---

### Phase 6: Documentation & ADR

#### 6.1 Write ADR

Create: `kb-labs-agents/docs/adr/0006-orchestrator-specialists-playbooks.md`

Structure:
```markdown
# ADR-0006: Orchestrator + Specialists + Playbooks Architecture

## Status
Accepted

## Context
- Current single-agent approach is expensive (Sonnet 4.5 for everything)
- Need consistent quality across multiple tasks
- Want to accumulate domain expertise over time

## Decision
Implement hierarchical agent system:
1. Orchestrator (expensive model) - planning/delegation
2. Specialists (cheap models) - focused execution
3. Playbooks (YAML) - accumulated expertise

## Consequences

### Positive
- 11x cheaper than Claude solo
- 126x cheaper than Senior Dev
- Consistent quality through playbooks
- Scales linearly with task volume

### Negative
- More complex architecture
- Need to maintain playbooks
- Specialists need tools filtering

## Implementation
[Link to DEVELOPMENT-PLAN.md]
```

#### 6.2 Update CLAUDE.md

Add section about agent architecture:
```markdown
## Agent System - Orchestrator + Specialists

KB Labs includes a hierarchical agent system for autonomous task execution.

### Architecture

Orchestrator (expensive, smart) delegates to Specialists (cheap, focused):
- mind-assistant: Semantic code search
- code-writer: Generate code following patterns
- typescript-bug-hunter: Find TypeScript bugs
- devkit-specialist: Monorepo validation
- docs-writer: Documentation

Playbooks provide best practices for common patterns.

### Usage

Run orchestrator:
\`\`\`bash
pnpm kb agent:run --agentId=orchestrator --task="Your task"
\`\`\`

Run specialist directly:
\`\`\`bash
pnpm kb agent:run --agentId=mind-assistant --task="Find VectorStore"
\`\`\`

### Cost
~$0.71 per complex task (add feature)
~$0.10 per simple task (code search)
```

#### 6.3 Create Playbook Template

Create: `.kb/playbooks/TEMPLATE.playbook.yml`

```yaml
id: your-playbook-id
name: Your Playbook Name
description: Brief description
triggers:
  - "pattern to match"
  - "another pattern"

guidance:
  overview: |
    High-level approach for this type of task

  specialists_to_use:
    - specialist: specialist-id
      purpose: "Why use this specialist"

  common_pitfalls:
    - "Mistake to avoid"

  decision_tree:
    - question: "Key decision point?"
      yes: "Action if yes"
      no: "Action if no"

cost_estimation:
  typical_breakdown:
    phase1: "$X.XX"
  total_typical: "$X.XX"
```

**Success criteria:**
- ✅ ADR written and comprehensive
- ✅ CLAUDE.md updated with agent docs
- ✅ Playbook template created

**Estimated time:** 2-3 hours

---

## 📊 Total Estimates

| Phase | Time | Test Cost | Deliverables |
|-------|------|-----------|--------------|
| Phase 1: Tools Filtering | 3-4 hours | $0.05 | filterTools(), updated configs |
| Phase 2: Specialists | 4-5 hours | $0.20 | 5 specialist agents |
| Phase 3: Playbooks | 4-5 hours | $0.15 | Playbook system + 3 playbooks |
| Phase 4: Agent Communication | 3-4 hours | $0.20 | agent:invoke tool |
| Phase 5: Integration | 4-5 hours | $2.50 | E2E tests |
| Phase 6: Documentation | 2-3 hours | $0 | ADR, docs |
| **TOTAL** | **20-26 hours** | **$3.10** | **Full system** |

**Timeline:** 3-4 days of focused work

---

## 🚀 Execution Strategy

### Day 1: Tools Filtering + Basic Specialists
- Morning: Phase 1 (tools filtering)
- Afternoon: Phase 2.1-2.3 (3 specialists)
- Test: mind-assistant with filtered tools

### Day 2: Playbooks + Integration
- Morning: Phase 2.4-2.5 (2 more specialists)
- Afternoon: Phase 3 (playbook system)
- Test: Playbook loading works

### Day 3: Agent Communication + E2E
- Morning: Phase 4 (agent:invoke)
- Afternoon: Phase 5.1-5.2 (orchestrator + 1 test)
- Test: Orchestrator → specialist flow

### Day 4: Testing + Documentation
- Morning: Phase 5.3-5.4 (2 more integration tests)
- Afternoon: Phase 6 (ADR + docs)
- Final validation: All tests pass

---

## 🎯 Success Metrics

After completion, we should have:

**Architecture:**
- ✅ 1 orchestrator agent (Sonnet 4.5)
- ✅ 5+ specialist agents (gpt-4o-mini)
- ✅ 3+ playbooks with domain expertise
- ✅ Tools filtering enforces boundaries

**Performance:**
- ✅ Complex task (add feature): ~9 min, ~$0.71
- ✅ Simple task (code search): ~1 min, ~$0.01
- ✅ Quality: consistent 9/10

**Cost efficiency:**
- ✅ 11x cheaper than Claude solo
- ✅ 126x cheaper than Senior Dev
- ✅ Linear scaling (1000 tasks = $710)

**Maintainability:**
- ✅ Clear specialist boundaries
- ✅ Playbooks accumulate expertise
- ✅ Tools filtering prevents confusion
- ✅ Comprehensive documentation

---

## 📝 Notes

**Key decisions made:**
1. Use gpt-4o-mini for specialists (balance of cost/quality)
2. Simple string matching for playbook discovery (RAG in v2)
3. YAML format for playbooks (human-readable)
4. Tools filtering mandatory for specialists

**Future enhancements (v2):**
- RAG-based playbook discovery (embeddings)
- Caching specialist results
- Batch operations
- Playbook versioning
- Specialist marketplace

**Questions for user:**
- Which orchestrator model? (Sonnet 4.5, GPT-5, Opus)
- Which specialist model? (gpt-4o-mini confirmed)
- Playbook storage location? (.kb/playbooks/ confirmed)

---

## 🏁 Ready to Start

**First task:** Phase 1.1 - Update type definitions

Let's begin! 🚀
