# KB Labs Agents - Production Roadmap

**Goal**: Transform the agent system into a production-ready platform for daily use through Studio UI/REST API.

**Current Status**:
- ✅ Core architecture: 9/10 (solid foundation)
- ✅ Observability: 9/10 (enterprise-grade analytics)
- ⚠️ UX/API: 6/10 (needs streaming, session management)
- ⚠️ Reliability: 7/10 (needs error recovery, graceful degradation)

**Target**: Replace Claude Code/Cursor with custom solution for full control over dev experience.

---

## Phase 1: Core REST API (Week 1-2) - CRITICAL

**Goal**: Enable Studio integration with real-time feedback

### 1.1 Orchestrator Run Endpoint (2-3 days) - P0

**Current**:
```typescript
// Commented out in manifest.v3.ts
POST /v1/plugins/agents/run
{ agentId: "researcher", task: "..." }
```

**Needed**:
```typescript
POST /v1/plugins/agents/orchestrate
{
  task: string,
  // Optional overrides
  agents?: string[],
  tier?: "small" | "medium" | "large",
  temperature?: number,
  stream?: boolean  // Default: false
}

Response (stream=false):
{
  success: true,
  sessionId: "abc123",
  plan: {
    subtasks: [
      {
        id: "subtask-1",
        agentId: "researcher",
        description: "...",
        dependencies: [],
        priority: 10,
        estimatedComplexity: "medium"
      }
    ]
  },
  result: {
    answer: "...",
    stats: { tokens: 5000, duration: 120000, cost: 0.015 }
  }
}

Response (stream=true):
{
  success: true,
  sessionId: "abc123",
  streamUrl: "/v1/plugins/agents/sessions/abc123/stream"
}
```

**Tasks**:
- [ ] Create Zod schema for orchestrate request/response
- [ ] Create REST handler `./rest/orchestrate.ts`
- [ ] Add route to manifest.v3.ts
- [ ] Map to existing orchestrator
- [ ] Add validation and error handling

**Files to create/modify**:
- `agent-contracts/src/rest-schemas.ts` - Add OrchestrateRequestSchema
- `agent-cli/src/rest/orchestrate.ts` - New handler
- `agent-cli/src/manifest.v3.ts` - Add route

### 1.2 SSE Streaming Endpoint (3-4 days) - P0

**CRITICAL**: Without streaming, Studio UI will be unusable (no real-time feedback)

```typescript
GET /v1/plugins/agents/sessions/:sessionId/stream

Server-Sent Events:
event: plan_created
data: { plan: {...} }

event: subtask_start
data: { id: "subtask-1", agentId: "researcher", description: "..." }

event: subtask_thinking
data: { id: "subtask-1", thought: "Analyzing codebase..." }

event: tool_call_start
data: { id: "subtask-1", tool: "mind:rag-query", args: {...} }

event: tool_call_complete
data: { id: "subtask-1", tool: "mind:rag-query", result: {...}, duration: 5000 }

event: subtask_complete
data: { id: "subtask-1", success: true, result: {...}, tokens: 1234, duration: 30000 }

event: synthesis_start
data: { subtasksCount: 3 }

event: synthesis_chunk
data: { partial: "Analytics events are emitted..." }

event: complete
data: {
  answer: "...",
  stats: { totalTokens: 5000, duration: 120000, cost: 0.015 },
  successRate: 100
}

event: error
data: { message: "...", code: "...", subtaskId: "..." }
```

**Tasks**:
- [ ] Modify orchestrator to accept streaming callbacks
- [ ] Create SSE endpoint handler `./rest/session-stream.ts`
- [ ] Implement event emission for all orchestrator phases
- [ ] Add session storage (in-memory for MVP)
- [ ] Handle client disconnection gracefully
- [ ] Add heartbeat/keep-alive events

**Files to create/modify**:
- `agent-orchestrator/src/orchestrator.ts` - Add callback support
- `agent-cli/src/rest/session-stream.ts` - New SSE handler
- `agent-cli/src/session-manager.ts` - Session state storage
- `agent-cli/src/manifest.v3.ts` - Add route

### 1.3 Session Management Endpoints (2 days) - P0

```typescript
GET /v1/plugins/agents/sessions/:sessionId
Response: {
  sessionId,
  status: "running" | "paused" | "completed" | "failed",
  plan: {...},
  progress: { completed: 2, total: 5, currentSubtask: "subtask-3" },
  stats: {...}
}

POST /v1/plugins/agents/sessions/:sessionId/pause
Response: { success: true, pausedAt: "subtask-3" }

POST /v1/plugins/agents/sessions/:sessionId/resume
Response: { success: true, resumedFrom: "subtask-3" }

DELETE /v1/plugins/agents/sessions/:sessionId/cancel
Response: { success: true, cancelledAt: "subtask-3" }

GET /v1/plugins/agents/sessions
Query: { limit: 20, offset: 0, status: "completed|failed|running" }
Response: {
  sessions: [...],
  total: 42
}
```

**Tasks**:
- [ ] Create session state model
- [ ] Implement pause/resume logic in orchestrator
- [ ] Add graceful cancellation (finish current subtask)
- [ ] Create REST handlers for session CRUD
- [ ] Add session persistence (file-based for MVP)

**Files to create/modify**:
- `agent-cli/src/session-manager.ts` - Session CRUD
- `agent-cli/src/rest/session-*.ts` - REST handlers
- `agent-orchestrator/src/orchestrator.ts` - Pause/resume support

---

## Phase 2: Advanced Control (Week 3-4) - HIGH PRIORITY

**Goal**: Give user full control over execution plan

### 2.1 Plan Modification API (3-4 days) - P1

```typescript
// Create plan without executing
POST /v1/plugins/agents/plan
{ task: "..." }
Response: {
  planId: "xyz",
  plan: {...},
  estimates: {
    durationMinutes: 5,
    tokens: 5000,
    cost: 0.015
  }
}

// Modify plan
PATCH /v1/plugins/agents/plans/:planId
{
  subtasks: [
    { id: "subtask-1", agentId: "implementer" },  // Changed agent
    { id: "subtask-3", delete: true }  // Remove subtask
  ]
}
Response: {
  planId: "xyz",
  plan: {...},  // Updated plan
  estimates: {...}  // Re-calculated
}

// Add subtask
POST /v1/plugins/agents/plans/:planId/subtasks
{
  description: "...",
  agentId: "reviewer",
  dependencies: ["subtask-1"],
  priority: 8
}

// Execute plan
POST /v1/plugins/agents/plans/:planId/execute
{ stream: true }
Response: { sessionId: "abc123", streamUrl: "..." }
```

**Tasks**:
- [ ] Create plan storage (separate from sessions)
- [ ] Implement plan validation after modifications
- [ ] Add dependency graph validation
- [ ] Create cost/time estimation logic (use analytics history)
- [ ] Create REST handlers for plan CRUD

**Files to create/modify**:
- `agent-cli/src/plan-manager.ts` - Plan CRUD and validation
- `agent-cli/src/estimator.ts` - Cost/time estimation
- `agent-cli/src/rest/plan-*.ts` - REST handlers

### 2.2 Cost/Time Estimation (2 days) - P1

**Goal**: Show user estimates before execution

```typescript
// In plan response
estimates: {
  durationMinutes: 5,      // Based on historical data
  tokensMin: 3000,         // Conservative estimate
  tokensMax: 7000,         // Pessimistic estimate
  tokensAvg: 5000,         // Most likely
  costMin: 0.009,
  costMax: 0.021,
  costAvg: 0.015,
  confidence: 0.7,         // Based on sample size
  breakdown: [
    {
      subtaskId: "subtask-1",
      agentId: "researcher",
      complexity: "medium",
      tokensAvg: 2000,
      durationMinutes: 2
    }
  ]
}
```

**Estimation Logic**:
- Query `.kb/analytics/buffer/events-*.jsonl`
- Find historical `orchestrator.specialist.completed` events
- Group by `specialist_id` + `complexity`
- Calculate percentiles (p50, p90, p95)
- Apply safety margin (+30%)

**Tasks**:
- [ ] Create analytics query service
- [ ] Build estimation model from historical data
- [ ] Add confidence scoring
- [ ] Integrate with plan creation

**Files to create/modify**:
- `agent-cli/src/estimator.ts` - Estimation engine
- `agent-cli/src/analytics-query.ts` - Query analytics events

### 2.3 Error Recovery & Graceful Degradation (3 days) - P1

**Current Issue**: If one subtask fails, entire task fails (as seen in our test)

**Needed**:
- Retry failed subtasks (up to 3 times)
- Fallback to simpler plan if complex plan fails
- Partial results if synthesis fails
- Continue with remaining subtasks if one fails (when safe)

```typescript
// In orchestrator
{
  errorRecovery: {
    retryCount: 3,
    retryBackoff: "exponential",  // 1s, 2s, 4s
    partialResults: true,         // Return what we have
    continueOnError: true         // Skip failed subtask, continue with others
  }
}

// In session status
{
  sessionId: "abc123",
  status: "partial_success",
  completedSubtasks: ["subtask-1", "subtask-2"],
  failedSubtasks: [
    {
      id: "subtask-3",
      agentId: "reviewer",
      error: "...",
      retries: 3,
      skipped: true
    }
  ],
  partialResult: "Based on completed subtasks..."
}
```

**Tasks**:
- [ ] Add retry logic to orchestrator
- [ ] Implement partial synthesis (when some subtasks fail)
- [ ] Add circuit breaker for LLM API
- [ ] Graceful degradation (simpler plan on failure)
- [ ] Save checkpoint before each subtask

**Files to create/modify**:
- `agent-orchestrator/src/orchestrator.ts` - Retry and recovery logic
- `agent-orchestrator/src/circuit-breaker.ts` - LLM API protection
- `agent-cli/src/session-manager.ts` - Checkpoint support

---

## Phase 3: Performance & UX (Week 5-6) - MEDIUM PRIORITY

### 3.1 Parallel Subtask Execution (4-5 days) - P1

**Current**: Subtasks execute sequentially (slow!)

**Needed**: Execute independent subtasks in parallel

```typescript
// Plan with parallelization
{
  subtasks: [
    { id: "s1", dependencies: [] },      // Layer 1
    { id: "s2", dependencies: [] },      // Layer 1 (parallel with s1)
    { id: "s3", dependencies: ["s1"] },  // Layer 2 (after s1)
    { id: "s4", dependencies: ["s1", "s2"] }, // Layer 3 (after both)
  ],
  executionLayers: [
    ["s1", "s2"],        // Execute in parallel
    ["s3"],              // Wait for s1
    ["s4"]               // Wait for s1, s2
  ]
}

// Execution stats
{
  sequentialDuration: 180000,  // If run sequentially
  parallelDuration: 90000,     // Actual with parallelization
  speedup: 2.0,
  maxConcurrency: 2
}
```

**Tasks**:
- [ ] Build dependency graph from plan
- [ ] Calculate execution layers (topological sort)
- [ ] Implement parallel executor (Promise.allSettled)
- [ ] Add concurrency limits (max 3-5 concurrent)
- [ ] Update progress tracking for parallel execution

**Files to create/modify**:
- `agent-orchestrator/src/dependency-graph.ts` - Graph analysis
- `agent-orchestrator/src/parallel-executor.ts` - Parallel execution
- `agent-orchestrator/src/orchestrator.ts` - Use parallel executor

### 3.2 Smart Context Management (3-4 days) - P2

**Goal**: Reduce token usage by including only relevant context

**Current**: Agents might include too much or too little context

**Needed**:
- Auto-discover relevant files for task
- Include only necessary context in prompts
- Reuse context across subtasks

```typescript
// Context builder
const contextBuilder = new SmartContextBuilder({
  maxTokens: 8000,
  strategy: "relevance"  // vs "comprehensive"
})

// Before subtask execution
const context = await contextBuilder.buildContext({
  task: "Implement feature X",
  agentId: "implementer",
  previousSubtasks: [/* results from researcher */]
})

// Context includes:
// - Files mentioned in previous subtasks
// - Related files found via Mind RAG
// - Relevant documentation
// - Code examples
```

**Tasks**:
- [ ] Create context builder service
- [ ] Integrate with Mind RAG for relevance search
- [ ] Add context caching (reuse across subtasks)
- [ ] Token counting and pruning
- [ ] Context deduplication

**Files to create/modify**:
- `agent-core/src/context-builder.ts` - Smart context
- `agent-orchestrator/src/orchestrator.ts` - Use context builder

### 3.3 Aggressive Tool Caching (2 days) - P2

**Current**: 60s TTL for tool results

**Optimization**:
- Increase TTL for immutable operations (file reads of committed code)
- Cache Mind RAG queries longer (5 minutes)
- Share cache across subtasks in same session
- Invalidate cache on file writes

**Tasks**:
- [ ] Add session-scoped cache keys
- [ ] Implement cache tags (invalidate by tag)
- [ ] Increase TTL for read-only operations
- [ ] Add cache warming (preload common queries)

**Files to modify**:
- `agent-executor/src/tool-cache.ts` - Enhanced caching logic

---

## Phase 4: Studio UI Integration (Week 7-8) - HIGH PRIORITY

**Goal**: Build UI that makes the system enjoyable to use

### 4.1 Agent Chat Component (4-5 days) - P0

**Features**:
- Text input for task
- SSE client for streaming
- Real-time progress display
- Plan visualization before execution
- Ability to modify plan in UI
- Message history

**Components**:
```typescript
<AgentChat>
  <ChatInput onSubmit={handleTask} />
  <PlanPreview
    plan={plan}
    onEdit={handlePlanEdit}
    onExecute={handleExecute}
  />
  <ExecutionProgress
    session={session}
    events={sseEvents}
  />
  <ResultDisplay result={result} />
</AgentChat>
```

**Tasks**:
- [ ] Create SSE client hook
- [ ] Build chat input component
- [ ] Create plan preview component
- [ ] Create progress display component
- [ ] Add result rendering (markdown, code blocks)

### 4.2 Plan Editor UI (3-4 days) - P1

**Features**:
- Visual dependency graph (use mermaid or react-flow)
- Drag-and-drop subtask reordering
- Agent selection dropdown
- Add/remove subtasks
- Live validation
- Cost/time estimates update

**Tasks**:
- [ ] Create dependency graph visualization
- [ ] Build subtask editor component
- [ ] Add drag-and-drop
- [ ] Integrate with plan modification API

### 4.3 Session Management UI (2-3 days) - P1

**Features**:
- List of active/recent sessions
- Pause/Resume/Cancel buttons
- Progress bars
- Session details modal
- History search/filter

**Tasks**:
- [ ] Create session list component
- [ ] Build session details view
- [ ] Add control buttons
- [ ] Integrate with session API

---

## Phase 5: Production Polish (Week 9-10) - MEDIUM PRIORITY

### 5.1 Comprehensive Testing (1 week) - P1

**Unit Tests**:
- [ ] Orchestrator logic
- [ ] Plan validation
- [ ] Session management
- [ ] Estimation engine

**Integration Tests**:
- [ ] REST API endpoints
- [ ] SSE streaming
- [ ] Error recovery
- [ ] Parallel execution

**E2E Tests**:
- [ ] Full task execution
- [ ] Plan modification workflow
- [ ] Session pause/resume
- [ ] Error scenarios

### 5.2 Documentation (3-4 days) - P1

**API Docs**:
- [ ] OpenAPI spec for REST endpoints
- [ ] SSE event schemas
- [ ] Authentication guide
- [ ] Rate limiting

**User Guides**:
- [ ] Studio usage guide
- [ ] Agent configuration guide
- [ ] Troubleshooting guide
- [ ] Best practices

### 5.3 Performance Optimization (3-4 days) - P2

**Targets**:
- [ ] SSE latency < 100ms
- [ ] Plan creation < 5s
- [ ] Session list query < 200ms
- [ ] 100+ concurrent sessions

**Tasks**:
- [ ] Add caching layers
- [ ] Database indexing (if using DB)
- [ ] Connection pooling
- [ ] Load testing

---

## Phase 6: Advanced Features (Week 11+) - LOW PRIORITY

### 6.1 WebSocket Support (1 week) - P2

**Why**: Bidirectional communication for interactive mode

```typescript
// Client can send mid-execution
ws.send({ type: "clarification", message: "Use TypeScript instead" })

// Server broadcasts to client
ws.send({ type: "asking_user", question: "Which library?" })
```

### 6.2 Learning from Feedback (1 week) - P2

**Goal**: Improve over time based on user feedback

```typescript
// After task completion
POST /v1/plugins/agents/sessions/:sessionId/feedback
{
  rating: 4,
  comments: "Used wrong agent for subtask-2",
  corrections: [
    { subtaskId: "subtask-2", suggestedAgent: "implementer" }
  ]
}

// System learns:
// - Store in .kb/analytics as feedback.* events
// - Build preference model
// - Adjust agent selection in future plans
```

### 6.3 Multi-Agent Collaboration (1-2 weeks) - P2

**Goal**: Agents can ask each other for help

```typescript
// During execution, researcher calls implementer
{
  event: "agent_collaboration",
  data: {
    from: "researcher",
    to: "implementer",
    question: "Can you check if this pattern is used elsewhere?",
    response: "..."
  }
}
```

### 6.4 Templates & Workflows (1 week) - P2

**Goal**: Save and reuse successful plans

```typescript
// Save plan as template
POST /v1/plugins/agents/templates
{
  name: "Code Analysis + Implementation",
  plan: {...},
  variables: ["featureName", "targetFile"]
}

// Use template
POST /v1/plugins/agents/orchestrate
{
  templateId: "template-123",
  variables: { featureName: "Auth", targetFile: "app.ts" }
}
```

---

## Success Metrics

**Phase 1 (Week 1-2)**:
- ✅ Can execute task via REST API
- ✅ Can stream events to Studio UI
- ✅ Can pause/resume/cancel sessions
- 🎯 Target: Basic Studio integration working

**Phase 2 (Week 3-4)**:
- ✅ Can modify plan before execution
- ✅ See cost/time estimates
- ✅ Partial results on failure
- 🎯 Target: User has full control

**Phase 3 (Week 5-6)**:
- ✅ 2x speedup from parallelization
- ✅ 30% token reduction from smart context
- ✅ 50% cache hit rate
- 🎯 Target: Fast and efficient

**Phase 4 (Week 7-8)**:
- ✅ Complete Studio UI
- ✅ Visual plan editor
- ✅ Session management dashboard
- 🎯 Target: Delightful UX

**Overall Success**:
- 🎯 **Replace Claude Code for daily work**
- 🎯 **<5min for simple tasks** (research, analysis)
- 🎯 **<15min for complex tasks** (implement + review + test)
- 🎯 **>90% success rate**
- 🎯 **<$0.50 per complex task**

---

## Current Bottlenecks

**Blockers (must fix)**:
1. ❌ No streaming API - Studio can't show progress
2. ❌ No session management - Can't pause/resume
3. ❌ No plan modification - User has no control

**Pain points (should fix)**:
4. ⚠️ No error recovery - One failure = total failure
5. ⚠️ No cost estimates - User doesn't know price upfront
6. ⚠️ Sequential execution - Slow for independent subtasks

**Nice to have (later)**:
7. 💡 No templates - Can't reuse successful patterns
8. 💡 No learning - System doesn't improve over time
9. 💡 No collaboration - Agents work in isolation

---

## Timeline Summary

| Phase | Duration | Priority | Deliverable |
|-------|----------|----------|-------------|
| **Phase 1** | 1-2 weeks | P0 | Core REST API with streaming |
| **Phase 2** | 2-3 weeks | P1 | Plan control & error recovery |
| **Phase 3** | 2-3 weeks | P1 | Performance optimization |
| **Phase 4** | 2-3 weeks | P0 | Studio UI integration |
| **Phase 5** | 2 weeks | P1 | Testing & documentation |
| **Phase 6** | 4+ weeks | P2 | Advanced features |

**Total to MVP**: ~8-10 weeks
**Total to production**: ~12-14 weeks

---

## Next Steps

**Immediate (This Week)**:
1. Create REST endpoint for orchestrator
2. Implement SSE streaming
3. Build session management

**Week 2**:
4. Add plan modification API
5. Create cost/time estimation
6. Implement error recovery

**Week 3**:
7. Start Studio UI components
8. SSE client integration
9. Basic chat interface

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Status**: PLANNING
