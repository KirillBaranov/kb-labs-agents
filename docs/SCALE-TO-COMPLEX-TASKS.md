# Agent System: Scaling to Complex Business Tasks

**Status:** Planning
**Target:** Support 20+ subtasks, 30-50 files, 95%+ success rate
**Current State:** 5 subtasks, 100% success, ~7 minutes execution

## Problem Statement

Real business tasks are significantly more complex than current capabilities:
- **20+ subtasks** instead of 5
- **30-50 files** to create/modify instead of 3-5
- **100-200 minutes** sequential execution is unacceptable
- **Context loss** between agents working on same project
- **No recovery** from partial failures

## Architecture Goals

### 1. Background Jobs Foundation
**Problem:** Heavy tasks block CLI, no way to monitor/cancel long-running operations

**Solution:** Job queue + WebSocket streaming
```typescript
// User starts task
$ pnpm kb agent:run --task="..." --background
Created job: job-abc123
Monitor: pnpm kb jobs status job-abc123
Logs:    pnpm kb jobs logs job-abc123 --follow
Cancel:  pnpm kb jobs cancel job-abc123

// Studio UI shows real-time progress via WebSocket
```

**Implementation:**
- Use existing `@kb-labs/workflow` runtime for orchestration
- Job state in State Broker (persistent across restarts)
- WebSocket server for real-time updates
- CLI commands for job management

---

### 2. Universal Tool Caching Layer
**Problem:** Repeated calls to slow tools (mind:rag-query 20-40s, HTTP calls, etc.)

**Solution:** Session-scoped tool result caching with TTL
```typescript
interface SessionToolCache {
  // Cache any tool call result
  async execute<T>(tool: {
    name: string;           // "mind:rag-query", "http:get", etc.
    input: unknown;
    ttl?: number;          // Cache TTL in ms
    cacheKey?: string;     // Custom cache key
  }): Promise<T>;

  // Invalidate cache
  invalidate(pattern: string): Promise<void>;
}

// Example: mind:rag-query results cached for 5 minutes
// If 3 agents ask same question → 1 LLM call instead of 3
```

**Cacheable tools:**
- `mind:rag-query` - semantic search (TTL: 5min)
- `http:get` - API endpoint checks (TTL: 1min)
- `fs:read` - file reads (TTL: 30s, invalidate on write)
- Any plugin tool marked `cacheable: true`

**Benefits:**
- 50-70% reduction in redundant tool calls
- 3-5x speedup for research-heavy tasks
- Lower token costs (fewer LLM decompositions)

---

### 3. Session File Tracking & Rollback
**Problem:** No visibility into what agents changed, can't undo agent actions

**Solution:** Track all file operations per agent, support rollback
```typescript
interface SessionFileTracker {
  // Track every file operation
  trackWrite(path: string, content: string, agentId: string): Promise<void>;
  trackEdit(path: string, before: string, after: string, agentId: string): Promise<void>;

  // Get diff for Studio UI
  getDiff(criteria: {
    agentId?: string;
    sinceTimestamp?: number;
    paths?: string[];
  }): Promise<FileDiff[]>;

  // Rollback operations
  rollback(criteria: {
    agentId?: string;        // Rollback all changes by agent
    sinceTimestamp?: number; // Rollback changes after time
    paths?: string[];        // Rollback specific files
  }): Promise<void>;
}

// Studio UI shows real-time diff:
websocket.on('agent:file-changed', (event) => {
  showDiff({
    path: event.path,
    before: event.before,
    after: event.after,
    agentId: event.agentId,
    timestamp: event.timestamp,
    canRollback: true,
  });
});
```

**Features:**
- Real-time diff streaming to Studio UI
- Per-agent rollback (undo implementer changes, keep tester changes)
- Time-based rollback (undo last 5 minutes)
- Selective rollback (undo specific file changes)

---

### 4. Smart Retry & Orchestrator Feedback
**Problem:** When agent fails, retry dumbly or give up entirely

**Solution:** Intelligent retry with orchestrator re-planning
```typescript
enum RetryDecision {
  RETRY_SAME,           // Same subtask, same agent
  RETRY_SIMPLER,        // Simplify task or use different agent
  NOTIFY_ORCHESTRATOR,  // Critical failure → orchestrator re-plans
  SKIP_WITH_PARTIAL,    // Skip but preserve partial results
}

interface RetryStrategy {
  maxAttempts: 3;
  backoff: 'exponential'; // 1s, 2s, 4s

  onFailure(error: AgentError): RetryDecision;
}

// Example retry logic:
onFailure: (error) => {
  if (error.kind === 'timeout') return RETRY_SAME;
  if (error.kind === 'validation' && error.attempts < 2) return RETRY_SAME;
  if (error.kind === 'tool_failure') return NOTIFY_ORCHESTRATOR;
  if (error.attempts >= 2) return SKIP_WITH_PARTIAL;
  return RETRY_SIMPLER;
}

// Orchestrator handles feedback:
orchestrator.onAgentFailure((subtask, error, decision) => {
  if (decision === NOTIFY_ORCHESTRATOR) {
    // Re-plan with knowledge of failure
    const newPlan = await replan({
      failedSubtask: subtask,
      completedSubtasks: [...],
      partialResults: {...},
      errorContext: error.message,
    });
  }
});
```

**Retry scenarios:**
- **Timeout** → Retry same (network glitch)
- **Validation error** → Retry up to 2x (LLM inconsistency)
- **Tool failure** → Notify orchestrator (structural problem)
- **2+ failures** → Skip with partial (don't waste tokens)

---

### 5. Structured Logging & Agent Tracing
**Problem:** Hard to debug 20 parallel agents, logs scattered everywhere

**Solution:** Centralized tracing with agent context
```typescript
// Every agent execution has trace context
interface AgentTrace {
  traceId: string;           // "trace-xyz789"
  agentId: string;           // "implementer"
  sessionId: string;         // "session-abc123"
  jobId: string;             // "job-def456"
  subtaskId: string;         // "subtask-2"
  parentTraceId?: string;    // For hierarchical agents
}

// All logs use platform.logger with context
logger.info('Agent started', agentTrace);
logger.debug('Tool called', { ...agentTrace, tool: 'fs:write', path: '...' });
logger.error('Agent failed', { ...agentTrace, error: error.message });

// Studio UI aggregates by trace:
// - Timeline: When each agent ran
// - Trace tree: Call hierarchy
// - Stats: Tool calls, tokens, duration per agent
```

**Views in Studio:**
1. **Timeline View** - Gantt chart of agent execution
2. **Trace View** - Nested tree of agent calls
3. **Stats Dashboard** - Tokens, cost, duration aggregated
4. **Error Explorer** - Filter by error type, agent, time

---

### 6. FAQ Knowledge Base (Vector-backed)
**Problem:** Agents repeatedly ask same questions, no learning from past tasks

**Solution:** Separate service with vector search for problem/solution pairs
```typescript
interface FAQService {
  // Search for similar problems
  search(query: string, limit: number): Promise<FAQEntry[]>;

  // Add new entry from failed task
  add(entry: {
    problem: string;        // "How to handle auth in this codebase?"
    solution: string;       // "Use @kb-labs/auth-provider"
    context: string;        // Code examples, file paths
    metadata: {
      tags: string[];       // ["auth", "api", "security"]
      confidence: number;   // 0.0-1.0
      usageCount: number;   // How many times used
    };
  }): Promise<void>;
}

// Agent system prompt includes relevant FAQ:
context:
  static:
    system: |
      # Common Patterns (from FAQ)
      Q: How to handle authentication?
      A: Use @kb-labs/auth-provider, see packages/api/src/auth.ts

      Q: What testing framework to use?
      A: vitest (unit), playwright (e2e)
```

**FAQ storage:**
- Vector DB (Qdrant) for semantic search
- Indexed on: problem text, solution text, tags
- Retrieved: top 5 most relevant for agent's task
- Updated: manually or auto-extracted from successful tasks

**Learning loop:**
```typescript
// After successful task:
await faqService.extractLearnings({
  task: "Create auth module",
  agentResults: [...],
  filesCreated: [...],
  patterns: await detectPatterns(agentResults),
});

// FAQ grows over time with project-specific knowledge
```

---

## Implementation Phases

### Phase 1: Tool Caching (Week 1)
**Goal:** Reduce redundant tool calls by 50-70%

**Tasks:**
- [ ] Implement SessionToolCache with State Broker backend
- [ ] Add cache TTL management
- [ ] Integrate into agent tool executor
- [ ] Add cache invalidation on fs:write
- [ ] Metrics: cache hit rate, time saved

**Success Criteria:**
- 70%+ cache hit rate for mind:rag-query
- 3-5x faster execution for research-heavy tasks
- No cache consistency bugs

---

### Phase 2: Background Jobs (Week 2)
**Goal:** Don't block CLI, support long-running tasks

**Tasks:**
- [ ] Create Job queue using workflow runtime
- [ ] Job state persistence (State Broker)
- [ ] CLI commands: `kb jobs status/logs/cancel`
- [ ] WebSocket server for real-time updates
- [ ] Studio UI integration (progress bar, logs)

**Success Criteria:**
- CLI returns immediately after job creation
- Real-time progress visible in Studio
- Jobs survive process restart
- Can cancel jobs mid-execution

---

### Phase 3: Session File Tracking (Week 3)
**Goal:** Visibility + rollback capability

**Tasks:**
- [ ] SessionFileTracker with edit history
- [ ] Real-time diff generation
- [ ] WebSocket events for file changes
- [ ] Studio UI diff viewer with rollback button
- [ ] Rollback by agent/time/path

**Success Criteria:**
- All file changes tracked with agent attribution
- Real-time diff visible in Studio
- Rollback works correctly (no data loss)
- Can undo last N minutes of changes

---

### Phase 4: Smart Retry & Orchestrator Feedback (Week 4)
**Goal:** 95%+ success rate on complex tasks

**Tasks:**
- [ ] RetryStrategy implementation
- [ ] Failure classification (timeout, validation, tool, etc.)
- [ ] Orchestrator re-planning API
- [ ] Partial results preservation
- [ ] Retry backoff (exponential)

**Success Criteria:**
- 95%+ success rate on 10-subtask tests
- Intelligent retry (not just blind repeat)
- Orchestrator adapts plan when agents fail
- Graceful degradation (skip non-critical subtasks)

---

### Phase 5: Structured Logging & Tracing (Week 5)
**Goal:** Debug 20+ agent executions easily

**Tasks:**
- [ ] Agent trace context injection
- [ ] Centralized logging (platform.logger)
- [ ] Log aggregation service
- [ ] Studio UI: Timeline/Trace/Stats views
- [ ] Error explorer with filtering

**Success Criteria:**
- All agent logs have trace context
- Can reconstruct full execution timeline
- Studio shows real-time agent activity
- Easy to find root cause of failures

---

### Phase 6: FAQ Knowledge Base (Week 6)
**Goal:** Agents learn from past tasks

**Tasks:**
- [ ] FAQ vector store (Qdrant)
- [ ] FAQ search API (semantic similarity)
- [ ] Auto-injection into agent prompts
- [ ] Learning pipeline (extract patterns from tasks)
- [ ] CLI commands for FAQ management

**Success Criteria:**
- FAQ contains 50+ project-specific patterns
- Agents use FAQ to answer common questions
- Reduces redundant mind:rag-query calls
- FAQ auto-grows from successful tasks

---

## Expected Impact

### Before (Current State)
- **5 subtasks** → 5 agents × 2min = **10 minutes**
- **Simple tasks only** (3-5 files)
- **100% success** on simple tasks
- **No recovery** from failures
- **No visibility** into agent actions

### After Phase 1-2 (Tool Caching + Background Jobs)
- **10 subtasks** → 10 agents × 1min (cached) = **10 minutes**
- **Moderate tasks** (10-15 files)
- **Non-blocking** execution
- **Real-time monitoring**

### After Phase 3-4 (File Tracking + Smart Retry)
- **15 subtasks** → 15 agents × 1min = **15 minutes**
- **Complex tasks** (20-30 files)
- **95%+ success** with smart retry
- **Rollback capability** on failures

### After Phase 5-6 (Logging + FAQ)
- **20+ subtasks** → 20 agents × 0.8min (cached + FAQ) = **16 minutes**
- **Very complex tasks** (30-50 files)
- **95%+ success** maintained
- **Self-learning** system (FAQ grows)
- **Easy debugging** (structured logs)

---

## Architecture Decisions

### Why Not Multi-Process Parallelization?
**Decision:** Use async in single process for Phase 1-4, consider workers later

**Reasoning:**
- Simpler to implement and debug
- State Broker handles concurrent access
- Can add worker pool in Phase 7 if needed
- Most time is spent in LLM calls (I/O bound, not CPU bound)

### Why State Broker for Jobs?
**Decision:** Store job state in State Broker, not separate DB

**Reasoning:**
- Already have State Broker with persistence
- No new infrastructure dependency
- Built-in TTL and cleanup
- Fast in-memory access

### Why Vector DB for FAQ?
**Decision:** Separate service, not part of agent configs

**Reasoning:**
- FAQ is shared across all agents
- Semantic search requires embeddings
- Grows dynamically (can't be in static YAML)
- Reuses existing Mind RAG infrastructure (Qdrant)

---

## Next Steps

1. **Week 1:** Implement SessionToolCache (Phase 1)
2. **Week 2:** Build Job queue + WebSocket (Phase 2)
3. **Week 3:** Add File tracking + Rollback (Phase 3)
4. **Week 4:** Smart retry + Re-planning (Phase 4)
5. **Week 5:** Logging + Studio views (Phase 5)
6. **Week 6:** FAQ service + Learning (Phase 6)

**Milestone:** By Week 6, support 20-subtask, 50-file tasks with 95%+ success rate in ~20 minutes.

---

## Open Questions

1. **Concurrency limit:** How many agents run in parallel? (Start with 5, make configurable)
2. **Cache size limit:** Max cache entries per session? (1000 entries, 100MB)
3. **Job retention:** How long to keep completed jobs? (7 days)
4. **FAQ ranking:** How to rank FAQ entries? (By usage count + confidence score)
5. **Cost control:** Hard limit on tokens per job? (Optional, configurable)

---

## References

- [ADR-0001: Structured Agent Output](./adr/0001-structured-agent-output.md)
- [State Broker README](../../kb-labs-core/packages/state-broker/README.md)
- [Workflow Engine README](../../kb-labs-workflow/README.md)
- [Mind RAG Architecture](../../kb-labs-mind/packages/mind-engine/README.md)
