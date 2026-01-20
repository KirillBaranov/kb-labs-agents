# V2 Agent System: Implementation Plan

**Date:** 2026-01-19
**Status:** Planning
**Based on:** V2-AGENT-ARCHITECTURE.md

---

## 📋 Overview

This plan outlines the practical steps to evolve the current MVP orchestrator into a production-ready V2 agent system with:
- Smart specialists with deep domain context
- Proper error handling and retry mechanisms
- Context management and session state
- Cost optimization and model escalation
- Progress tracking via callbacks

**What's already working (MVP):**
- ✅ Tool-based orchestrator (15 LLM tools)
- ✅ 5 subtasks executed in 3 minutes
- ✅ Creates working code (Express + PostgreSQL + schema)
- ✅ 4 specialists: researcher, implementer, tester, reviewer
- ✅ YAML-based specialist definitions

**Technical foundations:**
- ✅ SDK composables: `useCache()`, `useLLM()` from `@kb-labs/sdk`
- ✅ Cache namespace permissions: `specialist:`, `orchestrator:`
- ✅ Callback interfaces for progress tracking

---

## 🎯 Phase 1: Context Management & File Structure

**Priority:** CRITICAL
**Estimated:** 1-2 days
**Owner:** TBD

### Problem
- ❌ Files created in wrong directory (project root instead of outputDir)
- ❌ Specialists don't know about previous results
- ❌ No working directory context passed to specialists

### Solution

#### 1.1 New Directory Structure for Specialists

```
.kb/specialists/
├── researcher/
│   ├── agent.yml              # Main configuration (matches current format)
│   ├── context.md             # Static knowledge (architecture, patterns)
│   └── examples.yml           # Successful approach examples
│
├── implementer/
│   ├── agent.yml
│   ├── context.md
│   └── examples.yml
│
├── tester/
│   ├── agent.yml
│   ├── context.md
│   └── examples.yml
│
└── reviewer/
    ├── agent.yml
    ├── context.md
    └── examples.yml
```

**Why separate files?**
- Clean separation: config vs knowledge vs examples
- Easy editing: context.md can be large (10KB+) markdown
- Git-friendly: better diffs for documentation
- Reusable: can share context between specialists

#### 1.2 Corrected agent.yml Format

**Current format (from V2-AGENT-ARCHITECTURE.md Section 19.2):**

```yaml
# .kb/specialists/researcher/agent.yml
schema: kb.specialist/1
id: researcher
version: 1.0.0

display:
  name: "Code Researcher"
  description: "Semantic code search and analysis specialist"
  emoji: "🔍"

# Core specialist role (short, without context)
role: |
  You are a code researcher specializing in semantic code exploration.
  Your job is to FIND and READ code, not to modify it.
  Use Mind RAG for semantic searches (NOT grep).
  Always provide file paths with line numbers in your findings.

# Tool strategies (NOT just strings!)
tools:
  # Tool strategy format from current codebase
  - id: mind:rag-query
    strategy: plugin
    pluginId: "@kb-labs/mind-cli"

  - id: fs:read
    strategy: builtin

  - id: fs:list
    strategy: builtin

  - id: fs:glob
    strategy: builtin

# Forced reasoning configuration
forcedReasoningInterval: 3

# LLM settings
llm:
  tier: small
  temperature: 0.3
  maxTokens: 4096

# Execution limits
limits:
  maxSteps: 10
  maxToolCalls: 15
  timeoutMs: 120000
```

**Key fix:** Tools are NOT simple strings, they have strategies:
- `builtin` - Built-in tools (fs:read, fs:write, etc.)
- `plugin` - Plugin-provided tools (mind:rag-query, etc.)

#### 1.3 ExecutionContext Interface

```typescript
// packages/agent-contracts/src/context.ts

export interface ExecutionContext {
  // Where to work
  workingDir: string;          // Current directory (process.cwd())
  projectRoot: string;          // Project root
  outputDir: string;            // Where to write outputs (extracted from task)

  // Task context
  taskDescription: string;
  subtaskId: string;

  // Results from dependencies
  previousResults: Map<string, SpecialistResult>;

  // Findings to reuse
  findings: string[];           // Key facts from researcher

  // Files created by previous specialists
  availableFiles: {
    created: string[];          // Newly created files
    modified: string[];         // Modified files
  };
}
```

#### 1.4 Update orchestrator-executor.ts

**Location:** `packages/agent-core/src/executor/orchestrator-executor.ts`

**Changes:**

1. **Extract outputDir from task:**
```typescript
private extractOutputDir(task: string): string {
  // Parse task for patterns like:
  // "создайте в директории ./orchestrator-output/task-management-app/"
  // "create in directory ./foo/bar/"

  const patterns = [
    /директории\s+([^\s"']+)/i,
    /directory\s+([^\s"']+)/i,
    /в\s+([^\s"']+)/i,
  ];

  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match) {
      return path.resolve(match[1]);
    }
  }

  // Fallback to default output directory
  return path.resolve('./orchestrator-output');
}
```

2. **Build ExecutionContext in delegateTask:**
```typescript
private async delegateTask(
  subtask: SubTask,
  delegatedResults: SpecialistResult[]
): Promise<SpecialistResult> {

  // Collect results from dependencies
  const previousResults = new Map<string, SpecialistResult>();
  for (const depId of subtask.dependencies) {
    const depResult = delegatedResults.find(r => r.subtaskId === depId);
    if (depResult) {
      previousResults.set(depId, depResult);
    }
  }

  // Extract findings
  const findings = this.extractFindings(previousResults);

  // Extract available files
  const availableFiles = {
    created: Array.from(previousResults.values()).flatMap(r => r.outputs?.created || []),
    modified: Array.from(previousResults.values()).flatMap(r => r.outputs?.modified || []),
  };

  // Build context
  const context: ExecutionContext = {
    workingDir: process.cwd(),
    projectRoot: this.getProjectRoot(),
    outputDir: this.extractOutputDir(this.task),
    taskDescription: subtask.description,
    subtaskId: subtask.id,
    previousResults,
    findings,
    availableFiles,
  };

  // Execute specialist with context
  const specialist = await this.loadSpecialist(subtask.agentId);
  return specialist.execute(subtask.description, context);
}

private extractFindings(results: Map<string, SpecialistResult>): string[] {
  const findings: string[] = [];

  for (const result of results.values()) {
    if (result.summary) {
      findings.push(result.summary);
    }
    if (result.facts) {
      findings.push(...result.facts);
    }
  }

  return findings;
}

private getProjectRoot(): string {
  // Walk up to find git root or package.json
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
```

#### 1.5 Update AgentExecutor to Accept Context

**Location:** `packages/agent-core/src/executor/agent-executor.ts`

**Changes:**

1. **Update execute() signature:**
```typescript
async execute(
  task: string,
  context: ExecutionContext  // ✨ NEW parameter
): Promise<SpecialistResult> {

  // Build system prompt with context
  const systemPrompt = await this.buildSystemPromptWithContext(context);

  // Rest of execution...
}
```

2. **Build system prompt with context:**
```typescript
private async buildSystemPromptWithContext(context: ExecutionContext): Promise<string> {
  let prompt = this.definition.role;

  // Add static context from context.md (if exists)
  const contextMd = await this.loadContextMarkdown();
  if (contextMd) {
    prompt += `\n\n# Project Knowledge\n${contextMd}`;
  }

  // Add examples from examples.yml (if exists)
  const examples = await this.loadExamples();
  if (examples.length > 0) {
    prompt += `\n\n# Examples of Successful Approaches\n`;
    for (const ex of examples) {
      prompt += `
**Task:** ${ex.task}
**Approach:**
${ex.approach}
**Outcome:** ${ex.outcome}
`;
    }
  }

  // Add execution context
  prompt += `
# Current Task
${context.taskDescription}

# Working Directory
Output files should be created in: ${context.outputDir}

# Previous Findings
${context.findings.join('\n')}

# Available Files from Previous Specialists
${context.availableFiles.created.map(f => `- ${f}`).join('\n')}
`;

  return prompt;
}
```

#### 1.6 Update SpecialistLoader

**Location:** `packages/agent-core/src/registry/specialist-loader.ts`

**Changes:**

1. **Load from directory structure:**
```typescript
async load(roots: string[]): Promise<void> {
  for (const root of roots) {
    const specialistsDir = path.join(root, '.kb/specialists');
    if (!fs.existsSync(specialistsDir)) continue;

    // Find specialist directories
    const specialistDirs = fs.readdirSync(specialistsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(specialistsDir, d.name));

    for (const dir of specialistDirs) {
      const agentYmlPath = path.join(dir, 'agent.yml');

      if (!fs.existsSync(agentYmlPath)) {
        logger.warn('Missing agent.yml', { dir });
        continue;
      }

      // Load agent.yml
      const yml = parseYaml(fs.readFileSync(agentYmlPath, 'utf8'));

      // Validate schema
      if (yml.schema !== 'kb.specialist/1') {
        logger.warn('Invalid schema', { dir, schema: yml.schema });
        continue;
      }

      // Store paths to context.md and examples.yml
      const contextPath = path.join(dir, 'context.md');
      const examplesPath = path.join(dir, 'examples.yml');

      yml._contextPath = fs.existsSync(contextPath) ? contextPath : undefined;
      yml._examplesPath = fs.existsSync(examplesPath) ? examplesPath : undefined;

      this.definitions.set(yml.id, yml);

      logger.debug('Loaded specialist', {
        id: yml.id,
        hasContext: !!yml._contextPath,
        hasExamples: !!yml._examplesPath,
      });
    }
  }
}
```

2. **Helper methods for loading context:**
```typescript
async loadContextMarkdown(id: string): Promise<string | undefined> {
  const definition = this.definitions.get(id);
  if (!definition?._contextPath) return undefined;

  return fs.readFileSync(definition._contextPath, 'utf8');
}

async loadExamples(id: string): Promise<Example[]> {
  const definition = this.definitions.get(id);
  if (!definition?._examplesPath) return [];

  const yml = parseYaml(fs.readFileSync(definition._examplesPath, 'utf8'));
  return yml.examples || [];
}
```

### Tasks Breakdown

- [ ] Create `ExecutionContext` interface in `@kb-labs/agent-contracts`
- [ ] Update `orchestrator-executor.ts`:
  - [ ] Add `extractOutputDir()` method
  - [ ] Add `extractFindings()` method
  - [ ] Add `getProjectRoot()` method
  - [ ] Update `delegateTask()` to build and pass context
- [ ] Update `agent-executor.ts`:
  - [ ] Update `execute()` signature to accept context
  - [ ] Add `buildSystemPromptWithContext()` method
  - [ ] Add `loadContextMarkdown()` method
  - [ ] Add `loadExamples()` method
- [ ] Update `specialist-loader.ts`:
  - [ ] Update `load()` to scan directories
  - [ ] Add `loadContextMarkdown()` helper
  - [ ] Add `loadExamples()` helper
- [ ] Create directory structure `.kb/specialists/researcher/`
- [ ] Create `researcher/agent.yml` with tool strategies
- [ ] Create `researcher/context.md` with KB Labs architecture
- [ ] Create `researcher/examples.yml` with successful approaches
- [ ] Repeat for `implementer/`, `tester/`, `reviewer/`
- [ ] Test with orchestrator task and verify files created in correct outputDir

---

## 🎯 Phase 2: Static Context & Examples

**Priority:** HIGH
**Estimated:** 2-3 days
**Owner:** TBD

### Problem
- ❌ Specialists don't know project architecture
- ❌ No examples of successful approaches
- ❌ Start from scratch every time

### Solution

Create rich context.md and examples.yml for each specialist.

#### 2.1 researcher/context.md

```markdown
# KB Labs Architecture

## Project Structure
- **Monorepo:** 18 repositories, 90+ packages
- **Key packages:**
  - `mind` - AI-powered code search and RAG system
  - `workflow` - Workflow engine and orchestration
  - `plugin` - Plugin system and adapters
  - `core` - Core utilities, profiles, state management

## Mind RAG Usage
- **Always use Mind RAG** for semantic searches
- **Never use grep** for "how does X work" questions
- Mind RAG modes: instant (fast), auto (balanced), thinking (deep)
- Mind RAG command: `pnpm kb mind rag-query --text "query" --agent`

## Naming Conventions
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Tests: `*.test.ts` or `*.spec.ts`

## Common Patterns
- Config files: `.kb/kb.config.json`
- Plugin manifests: `manifest.v3.ts`
- Tests: vitest framework
- Build: tsup bundler

## File Locations
- Plugin handlers: `packages/*/src/cli/commands/*.ts`
- REST endpoints: `packages/*/src/rest/*.ts`
- Types: `packages/*/src/types.ts` or `packages/*-contracts/`
- Tests: next to source files (`foo.test.ts` near `foo.ts`)

## Important Directories
- `.kb/mind/` - Mind RAG index data
- `.kb/cache/` - Platform cache
- `.kb/specialists/` - Specialist definitions
- `packages/` - Monorepo packages
```

#### 2.2 researcher/examples.yml

```yaml
examples:
  - task: "Find how authentication works"
    approach: |
      1. Use Mind RAG: pnpm kb mind rag-query --text "authentication flow JWT" --agent
      2. Read identified auth modules with fs:read
      3. Trace dependencies and exports
      4. Extract key classes and flow diagram
    outcome: "Found JWT auth in @kb-labs/core-auth with session management"

  - task: "Locate all API endpoints"
    approach: |
      1. Use Mind RAG: pnpm kb mind rag-query --text "REST API endpoints definitions" --agent
      2. List REST directories: fs:list packages/*/src/rest/
      3. Read manifest files to get routes
      4. Compile list with descriptions
    outcome: "Found 24 endpoints across 5 packages"

  - task: "Understand plugin loading system"
    approach: |
      1. Mind RAG query: "plugin loading discovery strategy"
      2. Read plugin loader implementation
      3. Trace WorkspaceStrategy and PkgStrategy flow
      4. Document discovery process
    outcome: "Plugins discovered via workspace: and link: strategies in manifest.v3.ts"
```

#### 2.3 implementer/context.md

```markdown
# KB Labs Code Style

## TypeScript
- Use strict mode
- Export types separately: `export type { Foo }`
- Prefer named exports over default
- Add JSDoc for public APIs
- Use `interface` for object shapes, `type` for unions/intersections

## Testing
- Framework: vitest
- Location: next to source (`foo.test.ts` near `foo.ts`)
- Mock external deps: `vi.mock('@kb-labs/foo')`
- Coverage: aim for >80%

## Build System
- Bundler: tsup
- Entry: `src/index.ts`
- Output: `dist/`
- Config: `tsup.config.ts`
- External dependencies marked in tsup config

## Common Patterns
- Error handling: throw typed errors, not strings
- Logging: use `getLogger()` from `@kb-labs/core-sys`
- Config: Zod schemas for validation
- Async: prefer async/await over promises

## File Organization
- One class per file (generally)
- Group related utilities
- Separate types into `types.ts` or contracts package
- Keep files under 300 lines when possible

## Dependencies
- Add to package.json dependencies (not devDependencies for runtime code)
- Use workspace versions for internal packages: `"@kb-labs/foo": "workspace:*"`
- External packages: specify version range

## REST API Patterns
- Handlers in `src/rest/*.ts`
- Define routes in `manifest.v3.ts`
- Use Zod for input/output schemas
- Export schema from contracts package: `@kb-labs/foo-contracts#BarSchema`

## CLI Command Patterns
- Handlers in `src/cli/commands/*.ts`
- Use `defineCommandFlags()` for flag definitions
- Add examples with `generateExamples()`
- Register in `manifest.v3.ts`
```

#### 2.4 implementer/examples.yml

```yaml
examples:
  - task: "Add new REST API endpoint"
    approach: |
      1. Read existing endpoints for pattern: fs:read packages/*/src/rest/
      2. Create handler in src/rest/new-endpoint.ts
      3. Define Zod schema in contracts package
      4. Add route to manifest.v3.ts with schema references
      5. Create test file: new-endpoint.test.ts
      6. Run tests: shell:exec "pnpm test"
    outcome: "New endpoint with validation, tests, and proper error handling"

  - task: "Add new CLI command"
    approach: |
      1. Read existing commands: fs:read packages/*/src/cli/commands/
      2. Create handler in src/cli/commands/new-command.ts
      3. Define flags with defineCommandFlags()
      4. Add command to manifest.v3.ts
      5. Test: shell:exec "pnpm kb <group>:<command> --help"
    outcome: "Working CLI command with proper help text and examples"

  - task: "Create new package in monorepo"
    approach: |
      1. Copy structure from similar package
      2. Create package.json with workspace dependencies
      3. Create tsup.config.ts for build
      4. Create src/index.ts as entry point
      5. Add to pnpm-workspace.yaml if needed
      6. Run: shell:exec "pnpm install"
    outcome: "New package properly integrated in monorepo"
```

#### 2.5 Adaptive Context Sizing

**Problem:** Large context.md files (10KB+) can exhaust context window for small tier models.

**Solution:** Adapt context size based on LLM tier.

**Location:** `packages/agent-core/src/executor/agent-executor.ts`

```typescript
import { useCache } from '@kb-labs/sdk';

private async loadContextMarkdown(): Promise<string | undefined> {
  const cache = useCache();

  if (cache) {
    // Try cache first (1 hour TTL)
    const cacheKey = `specialist:${this.definition.id}:context`;
    const cached = await cache.get<string>(cacheKey);

    if (cached) {
      return cached;
    }

    // Load from file
    const contextPath = this.definition._contextPath;
    if (!contextPath) return undefined;

    const content = fs.readFileSync(contextPath, 'utf8');

    // Cache for 1 hour (3600000ms)
    await cache.set(cacheKey, content, 3600000);

    return content;
  } else {
    // No cache - load directly
    const contextPath = this.definition._contextPath;
    if (!contextPath) return undefined;

    return fs.readFileSync(contextPath, 'utf8');
  }
}

private async buildSystemPromptWithContext(
  context: ExecutionContext,
  tier: 'small' | 'medium' | 'large'
): Promise<string> {

  let prompt = this.definition.role;

  // Load static context.md
  const contextMd = await this.loadContextMarkdown();

  if (contextMd) {
    // ✨ Adaptive sizing based on tier
    const adaptedContext = this.adaptContextForTier(contextMd, tier);
    prompt += `\n\n# Project Knowledge\n${adaptedContext}`;
  }

  // Load examples
  const examples = await this.loadExamples();

  if (examples.length > 0) {
    // ✨ Select examples based on tier
    const adaptedExamples = this.selectExamplesForTier(examples, tier);
    prompt += `\n\n# Examples of Successful Approaches\n`;
    for (const ex of adaptedExamples) {
      prompt += `
**Task:** ${ex.task}
**Approach:**
${ex.approach}
**Outcome:** ${ex.outcome}
`;
    }
  }

  // Add execution context (always included)
  prompt += `
# Current Task
${context.taskDescription}

# Working Directory
Output files should be created in: ${context.outputDir}

# Previous Findings
${context.findings.join('\n')}

# Available Files from Previous Specialists
${context.availableFiles.created.map(f => `- ${f}`).join('\n')}
`;

  return prompt;
}

/**
 * Adapt context.md size to model tier capabilities
 */
private adaptContextForTier(contextMd: string, tier: 'small' | 'medium' | 'large'): string {

  const limits = {
    small: 2048,      // 2KB (~500 tokens)
    medium: 5120,     // 5KB (~1200 tokens)
    large: Infinity,  // No limit
  };

  const maxChars = limits[tier];

  if (contextMd.length <= maxChars) {
    return contextMd;
  }

  // Truncate with marker
  const truncated = contextMd.slice(0, maxChars - 120);
  return `${truncated}\n\n...(truncated for ${tier} tier model - full context available on escalation)\n`;
}

/**
 * Select examples based on tier budget
 */
private selectExamplesForTier(examples: Example[], tier: 'small' | 'medium' | 'large'): Example[] {

  const limits = {
    small: 2,         // 2 examples
    medium: 4,        // 4 examples
    large: Infinity,  // All examples
  };

  const maxExamples = limits[tier];

  if (examples.length <= maxExamples) {
    return examples;
  }

  // Return first N examples (could be smarter - semantic selection)
  return examples.slice(0, maxExamples);
}
```

**Benefits:**
- ✅ Small tier: Fast, cheap, limited context (~2KB + 2 examples)
- ✅ Medium tier: Balanced (~5KB + 4 examples)
- ✅ Large tier: Full context after escalation
- ✅ Cache: 1 hour TTL via `useCache()` from SDK

### Tasks Breakdown

- [ ] Write `researcher/context.md` with KB Labs architecture
- [ ] Write `researcher/examples.yml` with 3-5 real examples
- [ ] Write `implementer/context.md` with code style guide
- [ ] Write `implementer/examples.yml` with 3-5 implementation examples
- [ ] Write `tester/context.md` with testing patterns
- [ ] Write `tester/examples.yml` with test writing examples
- [ ] Write `reviewer/context.md` with review guidelines
- [ ] Write `reviewer/examples.yml` with review examples
- [ ] Implement `useCache()` integration in specialist-loader
- [ ] Implement `adaptContextForTier()` method in agent-executor
- [ ] Implement `selectExamplesForTier()` method in agent-executor
- [ ] Update manifest.v3.ts with cache permissions: `['orchestrator:', 'specialist:']`
- [ ] Test loading and verify context appears in prompts
- [ ] Test adaptive sizing with different tiers (small/medium/large)
- [ ] Run orchestrator task and verify specialists use examples

---

## 🎯 Phase 3: Error Handling & Retry

**Priority:** HIGH
**Estimated:** 2-3 days
**Owner:** TBD

### Problem
- ❌ On specialist failure, all work is lost
- ❌ No retry mechanism
- ❌ No partial results saved

### Solution

Implement `SpecialistOutcome` contract with partial results and retry logic.

#### 3.1 Create SpecialistOutcome Types

**Location:** `packages/agent-contracts/src/outcome.ts`

```typescript
export interface RunMeta {
  durationMs: number;
  tokenUsage: {
    prompt: number;
    completion: number;
  };
  toolCalls: number;
  modelTier: 'small' | 'medium' | 'large';
}

export interface FailureReport {
  kind: 'tool_error' | 'timeout' | 'validation_failed' | 'stuck' | 'policy_denied' | 'unknown';
  message: string;
  lastToolCalls?: Array<{
    tool: string;
    args: any;
    error?: string;
  }>;
  suggestedRetry?: boolean;
}

export type SpecialistOutcome =
  | { ok: true; result: SpecialistResult; meta: RunMeta }
  | { ok: false; failure: FailureReport; partial?: SpecialistResult; meta: RunMeta };
```

#### 3.2 Update AgentExecutor Return Type

**Location:** `packages/agent-core/src/executor/agent-executor.ts`

```typescript
async execute(
  task: string,
  context: ExecutionContext
): Promise<SpecialistOutcome> {

  const startTime = Date.now();
  const meta: RunMeta = {
    durationMs: 0,
    tokenUsage: { prompt: 0, completion: 0 },
    toolCalls: 0,
    modelTier: this.definition.llm?.tier || 'small',
  };

  // Track partial result during execution
  const partialResult: Partial<SpecialistResult> = {
    subtaskId: context.subtaskId,
    success: false,
    outputs: { created: [], modified: [] },
  };

  try {
    // Execution loop...
    for (const step of steps) {
      const toolResult = await this.executeTool(step);
      meta.toolCalls++;

      // Track partial outputs
      if (toolResult.tool === 'fs:write' && toolResult.success) {
        partialResult.outputs!.created!.push(toolResult.args.path);
      }
      if (toolResult.tool === 'fs:edit' && toolResult.success) {
        partialResult.outputs!.modified!.push(toolResult.args.path);
      }
    }

    // Success
    partialResult.success = true;
    meta.durationMs = Date.now() - startTime;

    return {
      ok: true,
      result: partialResult as SpecialistResult,
      meta,
    };

  } catch (error) {
    meta.durationMs = Date.now() - startTime;

    // Classify error
    const failure: FailureReport = {
      kind: this.classifyError(error),
      message: error instanceof Error ? error.message : String(error),
      lastToolCalls: this.getLastToolCalls(5),
      suggestedRetry: this.shouldRetry(error),
    };

    // Return with partial result (don't lose work!)
    return {
      ok: false,
      failure,
      partial: partialResult as SpecialistResult,
      meta,
    };
  }
}

private classifyError(error: unknown): FailureReport['kind'] {
  if (error instanceof Error) {
    if (error.message.includes('timeout')) return 'timeout';
    if (error.message.includes('tool')) return 'tool_error';
    if (error.message.includes('validation')) return 'validation_failed';
    if (error.message.includes('stuck') || error.message.includes('loop')) return 'stuck';
    if (error.message.includes('policy') || error.message.includes('denied')) return 'policy_denied';
  }
  return 'unknown';
}

private shouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    // Don't retry validation errors or policy violations
    if (error.message.includes('validation')) return false;
    if (error.message.includes('policy')) return false;

    // Retry timeouts and tool errors
    if (error.message.includes('timeout')) return true;
    if (error.message.includes('tool')) return true;
  }
  return true; // Default: retry
}

private getLastToolCalls(count: number): Array<{ tool: string; args: any; error?: string }> {
  // Return last N tool calls from execution history
  return this.toolCallHistory.slice(-count);
}
```

#### 3.3 Implement Retry Logic in Orchestrator

**Location:** `packages/agent-core/src/executor/orchestrator-executor.ts`

```typescript
private async executeWithRetry(
  subtask: SubTask,
  context: ExecutionContext,
  maxRetries = 2
): Promise<SpecialistOutcome> {

  let lastOutcome: SpecialistOutcome | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    this.ctx.platform.logger.info('Executing specialist', {
      subtaskId: subtask.id,
      specialist: subtask.agentId,
      attempt,
      maxRetries,
    });

    try {
      const specialist = await this.loadSpecialist(subtask.agentId);
      const outcome = await specialist.execute(subtask.description, context);

      if (outcome.ok) {
        // Success!
        this.analytics.trackSpecialistSuccess(subtask, outcome.meta);
        return outcome;
      }

      // Failed, but got partial result
      lastOutcome = outcome;

      this.ctx.platform.logger.warn('Specialist failed', {
        subtaskId: subtask.id,
        attempt,
        kind: outcome.failure.kind,
        message: outcome.failure.message,
        hasPartial: !!outcome.partial,
        partialFiles: outcome.partial?.outputs?.created?.length || 0,
      });

      // If suggestedRetry = false, don't retry
      if (outcome.failure.suggestedRetry === false) {
        this.analytics.trackSpecialistFailure(subtask, outcome.failure, outcome.meta);
        return outcome;
      }

      // If last attempt, return as-is
      if (attempt === maxRetries) {
        this.analytics.trackSpecialistFailure(subtask, outcome.failure, outcome.meta);
        return outcome;
      }

      // Exponential backoff before retry
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      this.ctx.platform.logger.info('Retrying after backoff', {
        subtaskId: subtask.id,
        backoffMs,
        nextAttempt: attempt + 1,
      });

      await this.sleep(backoffMs);

    } catch (error) {
      // Unexpected error
      this.ctx.platform.logger.error('Unexpected error in specialist execution', {
        subtaskId: subtask.id,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt === maxRetries) {
        // Final attempt failed with exception
        return {
          ok: false,
          failure: {
            kind: 'unknown',
            message: error instanceof Error ? error.message : String(error),
            suggestedRetry: false,
          },
          meta: {
            durationMs: 0,
            tokenUsage: { prompt: 0, completion: 0 },
            toolCalls: 0,
            modelTier: 'small',
          },
        };
      }

      await this.sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  // Should never reach here, but TypeScript needs it
  return lastOutcome!;
}

private sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

#### 3.4 Update delegateTask to Use Retry

```typescript
private async delegateTask(
  subtask: SubTask,
  delegatedResults: SpecialistResult[]
): Promise<SpecialistResult> {

  // Build execution context (from Phase 1)
  const context = this.buildExecutionContext(subtask, delegatedResults);

  // Execute with retry
  const outcome = await this.executeWithRetry(subtask, context);

  if (outcome.ok) {
    return outcome.result;
  }

  // Failed even after retries
  // Return partial result if available, or error result
  if (outcome.partial) {
    this.ctx.platform.logger.warn('Returning partial result after failure', {
      subtaskId: subtask.id,
      filesCreated: outcome.partial.outputs?.created?.length || 0,
    });
    return outcome.partial;
  }

  // No partial result, return error
  return {
    subtaskId: subtask.id,
    agentId: subtask.agentId,
    success: false,
    summary: `Failed: ${outcome.failure.message}`,
    tokensUsed: outcome.meta.tokenUsage.prompt + outcome.meta.tokenUsage.completion,
  };
}
```

### Tasks Breakdown

- [ ] Create `SpecialistOutcome` types in `@kb-labs/agent-contracts`
- [ ] Update `AgentExecutor.execute()` to return `SpecialistOutcome`
- [ ] Implement `classifyError()` in AgentExecutor
- [ ] Implement `shouldRetry()` in AgentExecutor
- [ ] Track partial results during execution
- [ ] Implement `executeWithRetry()` in orchestrator
- [ ] Add exponential backoff between retries
- [ ] Update `delegateTask()` to use retry logic
- [ ] Add analytics tracking for retries
- [ ] Test failure scenarios and verify partial results saved

---

## 🎯 Phase 4: Model Escalation

**Priority:** MEDIUM
**Estimated:** 2 days
**Owner:** TBD

### Problem
- ❌ All specialists use single tier (small/medium)
- ❌ No escalation to more powerful models on complex tasks
- ❌ No cost tracking

### Solution

Implement escalation ladder and cost tracking.

#### 4.1 Add Escalation Ladder to agent.yml

```yaml
# .kb/specialists/researcher/agent.yml
llm:
  tier: small                    # Start with small
  escalationLadder:              # Escalate on errors
    - small
    - medium                     # But NOT large (too expensive for researcher)
  temperature: 0.3
  maxTokens: 4096
```

#### 4.2 Escalation Policy in Config

```json
// .kb/kb.config.json
{
  "orchestrator": {
    "escalation": {
      "maxEscalationsPerSpecialist": 2,
      "maxLargeTierUsesPerRun": 3,
      "maxCostUsdPerRun": 1.00,        // Optional: null for e2e конвейеры
      "warnCostUsdThreshold": 0.50
    }
  }
}
```

**Note on budgets for e2e pipelines:**

Для e2e конвейеров которые могут работать **часами** и генерировать **большие бюджеты**, текущий подход с `maxCostUsdPerRun` не подходит.

**For MVP:** Просто установите `maxCostUsdPerRun: null` для таких задач.

**Post-MVP:** Будет использоваться система tenant quotas (`@kb-labs/tenant`) с rate limiting и background jobs с независимыми бюджетами.

#### 4.3 Cost Tracking

```typescript
// In AnalyticsTracker
interface CostEstimate {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

class AnalyticsTracker {
  private totalCost = 0;

  trackSpecialistRun(meta: RunMeta): CostEstimate {
    // Rough estimates (OpenAI pricing as baseline)
    const rates = {
      small: { prompt: 0.15 / 1_000_000, completion: 0.60 / 1_000_000 },  // GPT-4o-mini
      medium: { prompt: 2.50 / 1_000_000, completion: 10.00 / 1_000_000 }, // GPT-4o
      large: { prompt: 15.00 / 1_000_000, completion: 60.00 / 1_000_000 }, // GPT-4
    };

    const rate = rates[meta.modelTier];
    const cost =
      meta.tokenUsage.prompt * rate.prompt +
      meta.tokenUsage.completion * rate.completion;

    this.totalCost += cost;

    return {
      promptTokens: meta.tokenUsage.prompt,
      completionTokens: meta.tokenUsage.completion,
      estimatedCostUsd: cost,
    };
  }

  getTotalCost(): number {
    return this.totalCost;
  }
}
```

#### 4.4 Implement Tier Escalation

```typescript
private async executeWithEscalation(
  subtask: SubTask,
  context: ExecutionContext
): Promise<SpecialistOutcome> {

  const specialist = await this.loadSpecialist(subtask.agentId);
  const ladder = specialist.definition.llm?.escalationLadder || ['small'];

  for (let tierIndex = 0; tierIndex < ladder.length; tierIndex++) {
    const tier = ladder[tierIndex];

    // Check budget before using expensive tier
    if (tier === 'large') {
      const currentCost = this.analytics.getTotalCost();
      const policy = this.getEscalationPolicy();

      if (currentCost >= policy.maxCostUsdPerRun) {
        this.ctx.platform.logger.warn('Budget exceeded, cannot escalate to large tier', {
          currentCost,
          maxCost: policy.maxCostUsdPerRun,
        });

        return {
          ok: false,
          failure: {
            kind: 'policy_denied',
            message: `Budget exceeded: $${currentCost.toFixed(2)} >= $${policy.maxCostUsdPerRun}`,
            suggestedRetry: false,
          },
          meta: { durationMs: 0, tokenUsage: { prompt: 0, completion: 0 }, toolCalls: 0, modelTier: tier },
        };
      }
    }

    // Execute with current tier
    this.ctx.platform.logger.info('Executing with tier', {
      subtaskId: subtask.id,
      tier,
      tierIndex,
      totalTiers: ladder.length,
    });

    const outcome = await specialist.execute(subtask.description, context, { tier });

    if (outcome.ok) {
      return outcome;
    }

    // Failed, escalate to next tier if available
    if (tierIndex < ladder.length - 1) {
      const nextTier = ladder[tierIndex + 1];
      this.ctx.platform.logger.warn('Escalating model tier', {
        subtaskId: subtask.id,
        from: tier,
        to: nextTier,
        reason: outcome.failure.kind,
      });

      this.analytics.trackEscalation(subtask.id, tier, nextTier, outcome.failure.kind);
    } else {
      // No more tiers to try
      return outcome;
    }
  }

  throw new Error('Unreachable');
}
```

### Tasks Breakdown

- [ ] Add `escalationLadder` to specialist YAML schema
- [ ] Add escalation policy to kb.config.json schema
- [ ] Implement cost estimation in AnalyticsTracker
- [ ] Implement `executeWithEscalation()` in orchestrator
- [ ] Add budget checks before expensive tier usage
- [ ] Combine retry + escalation logic
- [ ] Add escalation analytics tracking
- [ ] Test with complex task that triggers escalation
- [ ] Verify budget limits enforced

---

## 🎯 Phase 5: Progress Tracking

**Priority:** MEDIUM
**Estimated:** 1 day
**Owner:** TBD

### Problem
- ❌ No visibility into progress during execution
- ❌ Emoji markers (📋/✅/❌) not appearing in stdout

### Solution

Callback-based progress tracking for clean separation between orchestrator logic and output formatting.

#### 5.1 OrchestratorCallbacks Interface

**Location:** `packages/agent-contracts/src/callbacks.ts`

```typescript
export interface OrchestratorCallbacks {
  /**
   * Called after plan is created
   */
  onPlanCreated?: (plan: ExecutionPlan) => void;

  /**
   * Called when subtask starts
   */
  onSubtaskStart?: (
    subtask: SubTask,
    progress: { current: number; total: number }
  ) => void;

  /**
   * Called when subtask completes successfully
   */
  onSubtaskComplete?: (
    subtask: SubTask,
    result: SpecialistResult,
    progress: { current: number; total: number }
  ) => void;

  /**
   * Called when subtask fails (after retries)
   */
  onSubtaskFailed?: (
    subtask: SubTask,
    error: FailureReport,
    progress: { current: number; total: number }
  ) => void;

  /**
   * Called when plan is adapted (new subtasks added)
   */
  onAdaptation?: (
    reason: string,
    newSubtasks: SubTask[],
    currentProgress: { current: number; total: number }
  ) => void;

  /**
   * Called when orchestrator completes
   */
  onComplete?: (finalResult: string, stats: ExecutionStats) => void;
}

export interface ExecutionStats {
  totalSubtasks: number;
  successfulSubtasks: number;
  failedSubtasks: number;
  totalDurationMs: number;
  totalTokensUsed: number;
  totalCostUsd: number;
}
```

#### 5.2 Orchestrator Integration

**Location:** `packages/agent-core/src/executor/orchestrator-executor.ts`

```typescript
export class OrchestratorExecutor {

  private callbacks?: OrchestratorCallbacks;

  async execute(
    task: string,
    callbacks?: OrchestratorCallbacks  // ✨ Accept callbacks
  ): Promise<string> {

    this.callbacks = callbacks;

    // Phase 1: Planning
    const plan = await this.planExecution(task);
    this.callbacks?.onPlanCreated?.(plan);  // ✨ Notify

    // Phase 2: Delegation
    const results: SpecialistResult[] = [];

    for (let i = 0; i < plan.length; i++) {
      const subtask = plan[i];
      const progress = { current: i + 1, total: plan.length };

      // ✨ Notify start
      this.callbacks?.onSubtaskStart?.(subtask, progress);

      try {
        const outcome = await this.executeWithRetryAndEscalation(subtask, results);

        if (outcome.ok) {
          // ✨ Notify success
          this.callbacks?.onSubtaskComplete?.(subtask, outcome.result, progress);
          results.push(outcome.result);
        } else {
          // ✨ Notify failure
          this.callbacks?.onSubtaskFailed?.(subtask, outcome.failure, progress);

          if (outcome.partial) {
            results.push(outcome.partial);
          }
        }
      } catch (error) {
        // ✨ Notify unexpected error
        const failure: FailureReport = {
          kind: 'unknown',
          message: error instanceof Error ? error.message : String(error),
          suggestedRetry: false,
        };

        this.callbacks?.onSubtaskFailed?.(subtask, failure, progress);
      }
    }

    // Phase 3: Synthesis
    const finalResult = await this.synthesizeResults(results);

    const stats: ExecutionStats = {
      totalSubtasks: plan.length,
      successfulSubtasks: results.filter(r => r.success).length,
      failedSubtasks: results.filter(r => !r.success).length,
      totalDurationMs: results.reduce((sum, r) => sum + (r.durationMs || 0), 0),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
      totalCostUsd: this.analytics.getTotalCost(),
    };

    // ✨ Notify completion
    this.callbacks?.onComplete?.(finalResult, stats);

    return finalResult;
  }
}
```

#### 5.3 CLI Usage (Human-Friendly Output)

**Location:** `packages/agent-cli/src/cli/commands/orchestrator-run.ts`

```typescript
import type { OrchestratorCallbacks } from '@kb-labs/agent-contracts';

export default defineCommand({
  async handler(ctx, argv, flags) {

    const orchestrator = new OrchestratorExecutor(ctx);

    // Define callbacks for CLI output
    const callbacks: OrchestratorCallbacks = {

      onPlanCreated: (plan) => {
        console.log(`\n📋 Plan created: ${plan.length} subtasks\n`);
      },

      onSubtaskStart: (subtask, progress) => {
        const percentage = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(
          `📋 [${progress.current}/${progress.total}] ${percentage}% - ${subtask.id} (${subtask.agentId}): ${subtask.description}\n`
        );
      },

      onSubtaskComplete: (subtask, result, progress) => {
        const percentage = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(
          `✅ [${progress.current}/${progress.total}] ${percentage}% - ${subtask.id} completed (${result.tokensUsed} tokens)\n`
        );
      },

      onSubtaskFailed: (subtask, error, progress) => {
        const percentage = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(
          `❌ [${progress.current}/${progress.total}] ${percentage}% - ${subtask.id} failed: ${error.message}\n`
        );
      },

      onAdaptation: (reason, newSubtasks, progress) => {
        console.log(`\n🔄 Plan adapted: ${reason}`);
        console.log(`   Added ${newSubtasks.length} new subtask(s)\n`);
      },

      onComplete: (finalResult, stats) => {
        console.log(`\n✅ Orchestrator complete\n`);
        console.log(`📊 Statistics:`);
        console.log(`   Total subtasks:     ${stats.totalSubtasks}`);
        console.log(`   Successful:         ${stats.successfulSubtasks}`);
        console.log(`   Failed:             ${stats.failedSubtasks}`);
        console.log(`   Total duration:     ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
        console.log(`   Total tokens:       ${stats.totalTokensUsed.toLocaleString()}`);
        console.log(`   Estimated cost:     $${stats.totalCostUsd.toFixed(4)}\n`);
      },
    };

    // Execute with callbacks
    const result = await orchestrator.execute(flags.task, callbacks);

    ctx.ui.success('Done', result);
  },
});
```

#### 5.4 REST API Usage (Event Collection)

**Location:** `packages/agent-cli/src/rest/run-orchestrator.ts`

```typescript
import type { OrchestratorCallbacks } from '@kb-labs/agent-contracts';

type ProgressEvent = {
  type: string;
  timestamp: number;
  data: any;
};

export default defineHandler({
  async handler(ctx, input) {

    const orchestrator = new OrchestratorExecutor(ctx);

    // Collect events for response
    const events: ProgressEvent[] = [];

    const callbacks: OrchestratorCallbacks = {
      onPlanCreated: (plan) => {
        events.push({
          type: 'plan_created',
          timestamp: Date.now(),
          data: { subtaskCount: plan.length },
        });
      },

      onSubtaskStart: (subtask, progress) => {
        events.push({
          type: 'subtask_start',
          timestamp: Date.now(),
          data: {
            subtaskId: subtask.id,
            specialist: subtask.agentId,
            description: subtask.description,
            progress,
          },
        });
      },

      onSubtaskComplete: (subtask, result, progress) => {
        events.push({
          type: 'subtask_complete',
          timestamp: Date.now(),
          data: {
            subtaskId: subtask.id,
            tokensUsed: result.tokensUsed,
            progress,
          },
        });
      },

      onSubtaskFailed: (subtask, error, progress) => {
        events.push({
          type: 'subtask_failed',
          timestamp: Date.now(),
          data: {
            subtaskId: subtask.id,
            error: error.message,
            progress,
          },
        });
      },

      onComplete: (finalResult, stats) => {
        events.push({
          type: 'complete',
          timestamp: Date.now(),
          data: { stats },
        });
      },
    };

    // Execute
    const result = await orchestrator.execute(input.task, callbacks);

    // Return result + events
    return {
      result,
      events,
    };
  },
});
```

**Future enhancement (Post-MVP):**
Add Server-Sent Events (SSE) or WebSocket streaming for real-time progress in Studio UI.

### Tasks Breakdown

- [ ] Create `OrchestratorCallbacks` interface in `@kb-labs/agent-contracts`
- [ ] Create `ExecutionStats` interface in `@kb-labs/agent-contracts`
- [ ] Update `OrchestratorExecutor.execute()` to accept callbacks parameter
- [ ] Add callback invocations in orchestrator:
  - [ ] `onPlanCreated()` after planning
  - [ ] `onSubtaskStart()` before specialist execution
  - [ ] `onSubtaskComplete()` after successful execution
  - [ ] `onSubtaskFailed()` after failed execution (after retries)
  - [ ] `onAdaptation()` when plan is revised
  - [ ] `onComplete()` with final stats
- [ ] Implement CLI callbacks in `orchestrator-run.ts`:
  - [ ] Console output with emoji markers
  - [ ] Progress percentages
  - [ ] Statistics summary
- [ ] Implement REST callbacks in `run-orchestrator.ts`:
  - [ ] Event collection
  - [ ] Return events in response
- [ ] Test callbacks work for both CLI and REST
- [ ] Verify stdout appears immediately in CLI

---

## 🎯 Phase 6: Quality Validation (Post-MVP)

**Priority:** LOW
**Estimated:** 2-3 days
**Owner:** TBD

### Problem
- ❌ No validation of code quality
- ❌ Reviewer feedback not used

### Solution

Quality gates and reviewer feedback loop.

*(Detailed implementation deferred to Post-MVP)*

---

## 🎯 Phase 7: FAQ Knowledge Base (Post-MVP)

**Priority:** LOW
**Estimated:** 3-4 days
**Owner:** TBD

### Problem
- ❌ No knowledge reuse between tasks

### Solution

FAQ collection in Mind RAG.

*(Detailed implementation deferred to Post-MVP)*

---

## 📊 Timeline & Priorities

### Critical Path (Week 1-2)
1. **Phase 1: Context Management** (1-2 days)
2. **Phase 2: Static Context** (2-3 days)
3. **Phase 3: Error Handling** (2-3 days)

**Total:** ~1.5 weeks

### Important (Week 3)
4. **Phase 4: Model Escalation** (2 days)
5. **Phase 5: Progress Tracking** (1 day)

**Total:** +3 days

### Post-MVP
6. **Phase 6: Quality Validation** (2-3 days)
7. **Phase 7: FAQ System** (3-4 days)

---

## ✅ Success Criteria

**Phase 1 Complete:**
- [ ] Files created in correct outputDir
- [ ] Specialists receive context from previous results
- [ ] context.md and examples.yml loaded and injected into prompts

**Phase 2 Complete:**
- [ ] All 4 specialists have rich context.md
- [ ] All 4 specialists have 3-5 examples
- [ ] Specialists reference examples in their reasoning

**Phase 3 Complete:**
- [ ] Failed specialists return partial results
- [ ] Automatic retry with exponential backoff
- [ ] No loss of work on failure

**Phase 4 Complete:**
- [ ] Automatic tier escalation on failure
- [ ] Budget limits enforced
- [ ] Cost tracking per specialist

**Phase 5 Complete:**
- [ ] Real-time progress markers in stdout
- [ ] Clear visibility into which subtask is running

---

## 🔄 Next Steps

1. Review this plan
2. Prioritize phases
3. Assign ownership
4. Start with Phase 1: Context Management

---

## 📝 Appendix: Technical Details

### A. Updated manifest.v3.ts Permissions

**Location:** `packages/agent-cli/src/manifest.v3.ts`

```typescript
import type { PermissionSpec } from '@kb-labs/sdk';

const pluginPermissions: PermissionSpec = {
  fs: {
    read: ['.kb/**', '.kb/specialists/**', '.kb/cache/**', '**'],
    write: ['.kb/**', '.kb/specialists/**', '.kb/cache/**', '**'],
  },
  shell: {
    allow: ['*'],
  },
  env: {
    read: ['*'],
  },
  platform: {
    llm: true,
    cache: ['orchestrator:', 'specialist:'], // ✨ Namespace isolation
  },
  quotas: {
    timeoutMs: 3600000, // 1 hour for testing (background jobs in future)
    memoryMb: 512,
  },
};
```

**Key changes:**
- ✅ Added `cache: ['orchestrator:', 'specialist:']` for namespace isolation
- ✅ Restricted to specific namespaces (not `true` for all)
- ✅ Follows governed cache access pattern from platform

### B. SDK Imports Pattern

All cache access MUST go through `@kb-labs/sdk`:

```typescript
// ✅ CORRECT
import { useCache, isCacheAvailable } from '@kb-labs/sdk';

const cache = useCache();
if (cache) {
  await cache.set('specialist:researcher:context', content, 3600000);
}

// ❌ WRONG - Don't import from shared-command-kit directly
import { useCache } from '@kb-labs/shared-command-kit';
```

**Why SDK?**
- Plugin code communicates only through SDK
- SDK re-exports from shared-command-kit
- Future SDK changes won't break plugin code

### C. Cache Namespace Conventions

| Namespace | Purpose | Example Keys | TTL |
|-----------|---------|--------------|-----|
| `specialist:{id}:context` | Static context.md content | `specialist:researcher:context` | 1 hour |
| `specialist:{id}:examples` | Examples.yml content | `specialist:implementer:examples` | 1 hour |
| `specialist:{id}:config` | Parsed agent.yml config | `specialist:tester:config` | 1 hour |
| `orchestrator:plan:{hash}` | Cached execution plans | `orchestrator:plan:abc123` | 30 min |

**Best practices:**
- Always include namespace prefix for permission checks
- Use consistent naming: `namespace:entity:attribute`
- Set appropriate TTL (don't cache indefinitely)
- Clear cache on specialist definition changes

---

**End of Plan**
