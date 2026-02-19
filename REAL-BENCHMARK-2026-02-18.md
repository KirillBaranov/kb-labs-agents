# Real Agent Benchmarks - 2026-02-18

**Date:** 2026-02-18 (FRESH RUN)
**Purpose:** Validate current system performance with actual tests
**Previous Analysis:** Based on old docs (Feb 6) - **NOT ACCURATE**

---

## 🔥 Critical Finding: The Docs LIED!

### SIMPLE Task - Actually Works Well ✅

**Test:** "What is the VectorStore interface?"

**REAL Results (Feb 18):**
```
Duration: 19.8s
Tokens: 37,133 tokens
Quality: 7/10 (partial answer - found reference but not full definition)
Status: ✅ SUCCESS
Iterations: 5/5 (used all iterations)
```

**Old Docs Claimed (Feb 6):**
```
Duration: 22.9s
Tokens: 5,442 tokens
Quality: 10/10
```

**❌ MASSIVE DISCREPANCY:**
- Tokens: **5.4K → 37K (7x WORSE!)**
- Duration: **22.9s → 19.8s (slightly better)**
- Quality: **10/10 → 7/10 (worse)**

**Agent Behavior:**
```
Iteration 1: grep_search "VectorStore" → found 100 matches
Iteration 2: find_definition "VectorStore" → NOT FOUND
Iteration 3: reflect_on_progress + grep_search "interface VectorStore" → NOT FOUND
Iteration 4: grep_search "VectorStore" → found 5 matches (different scope)
Iteration 5: report_to_orchestrator → partial answer
```

**Answer Quality:**
- ❌ Did NOT find actual interface definition
- ✅ Found references to `IVectorStore as VectorStoreAdapter`
- ⚠️ Concluded it's "not explicitly defined" (incomplete investigation)

---

### RESEARCH Task - COMPLETE DISASTER ❌

**Test:** "Explain how the agent system works and what its key components are"

**REAL Results (Feb 18):**
```
Duration: ~3 minutes (180s+)
Tokens: ~200K+ (across 4 child agents)
Quality: 0/10 ❌
Status: FAILED
Child Agents: 4 spawned
Final Answer: "To identify patterns... I will explore... Then I'll summarize..."
```

**What Actually Happened:**

**Child Agent 1: "Review README and architecture docs"**
- Iterations: 3/12
- Tokens: 15,927
- Duration: 41.9s
- Result: "Reviewed README... no architecture docs found" ✅
- Quality: Acceptable (did what it was asked)

**Child Agent 2: "Inspect repository structure"**
- Iterations: 3/12
- Tokens: 24,423
- Duration: 17.8s
- Result: Listed directories (`.agent-sandbox`, `.kb`, `kb-labs-*`) ✅
- Quality: Acceptable (did what it was asked)

**Child Agent 3: "Examine core components"**
- Iterations: 5/12
- Tokens: 46,198
- Duration: 19.5s
- Result: Read `.agent-sandbox/src/` files (urlService.js, database.js, etc.) ❌
- Quality: **WRONG FILES** - read sandbox code, not agent system!

**Child Agent 4: "Identify patterns/conventions"**
- Iterations: 12/12 ❌ (hit max limit!)
- Tokens: 95,095
- Duration: 45.1s
- Result: "To identify patterns I need to inspect... I will explore... Then I'll summarize..." ❌
- Quality: **FAILED** - never synthesized, just described what it WOULD do

**Orchestrator Synthesis:**
- **SKIPPED** - No synthesis attempt visible in output
- Final response: Copy-paste of Child Agent 4's incomplete plan

---

## 📊 Current System State (REALITY)

### Performance Metrics

| Metric | SIMPLE | RESEARCH | Notes |
|--------|--------|----------|-------|
| **Success Rate** | 70% | 0% | SIMPLE: partial answers; RESEARCH: total failure |
| **Duration** | 19.8s | 180s+ | RESEARCH takes 9x longer |
| **Tokens** | 37K | 200K+ | Both are EXTREMELY high |
| **Quality** | 7/10 | 0/10 | SIMPLE works-ish, RESEARCH broken |
| **Tool Usage** | 5 tools | 20+ tools | RESEARCH wastes tools on wrong files |

### Token Usage Breakdown (SIMPLE Task)

```
Iteration 1: 7,076 tokens (grep_search)
Iteration 2: 7,264 tokens (find_definition)
Iteration 3: 4,103 + 7,323 = 11,426 tokens (reflect + grep)
Iteration 4: 7,382 tokens (grep_search again)
Iteration 5: 3,985 tokens (report)
Total: 37,133 tokens
```

**Problem:** Each iteration adds 4-7K tokens due to:
- ❌ Growing message history (no effective compression)
- ❌ Tool output included in full (truncation not working)
- ❌ Reflection adding overhead without benefit

---

## 🚨 Critical Issues (VALIDATED)

### Issue #1: Token Explosion (CRITICAL)

**Problem:** 37K tokens for simple lookup is **INSANE**

**Evidence:**
- Docs claimed "5.4K tokens" but reality is **37K (7x worse)**
- Phase 1.5 "Context Compression" clearly NOT working
- Phase 2 "Execution Memory" not preventing redundant context

**Root Cause:**
- ContextFilter not actually truncating outputs
- Sliding window not removing old iterations
- SmartSummarizer not running or ineffective

### Issue #2: RESEARCH Mode Catastrophic Failure (CRITICAL)

**Problem:** Child agents explore wrong code, hit iteration limits, never synthesize

**Evidence:**
- Child Agent 3: Read `.agent-sandbox/src/` files (sandbox code, not agents!)
- Child Agent 4: Hit 12/12 iterations without producing answer
- Orchestrator: No synthesis attempted - just copy-pasted incomplete plan

**Root Cause:**
1. **Wrong context extraction** - Agents don't understand what to search for
2. **No progressive synthesis** - Agents explore until iteration limit
3. **No orchestrator synthesis** - Orchestrator can't combine partial findings
4. **No task decomposition validation** - Subtasks don't match original question

### Issue #3: Tool Selection Chaos (HIGH)

**Problem:** Agents use wrong tools for the job

**Evidence (SIMPLE task):**
- `grep_search "VectorStore"` → 100 matches (too broad, useless)
- `find_definition "VectorStore"` → Not found (wrong tool)
- `grep_search "interface VectorStore"` → Not found (too specific)
- Should have used: `mind:rag-query "VectorStore interface definition"`

**Evidence (RESEARCH task):**
- Child Agent 3: Read sandbox code (`urlService.js`, `database.js`)
- Should have read: `kb-labs-agents/packages/agent-core/src/agent.ts`

**Root Cause:**
- Mind RAG not being used (agents prefer grep/glob/find)
- No tool recommendation based on task type
- Agents don't understand codebase structure

---

## 💡 What Actually Works

### ✅ Task Classification
- SIMPLE vs RESEARCH detection works
- RESEARCH spawns child agents correctly
- Iteration limits applied (5 for SIMPLE, 12 for RESEARCH)

### ✅ Tool Execution
- All tools executed without errors
- Deduplication prevented repeat calls
- Output formatting clean

### ✅ Observability
- Beautiful progress indicators
- Iteration tracking
- Token counting
- Duration metrics

---

## ❌ What's Broken

### 1. Context Management (CRITICAL)

**Claimed:** "50% token reduction via 3-tier optimization"
**Reality:** 37K tokens for 5-iteration simple task

**What's NOT working:**
- Output truncation (500 chars) - still seeing full outputs
- Sliding window (5 iterations) - all 5 iterations in context
- Async summarization - no evidence of summaries

### 2. RESEARCH Synthesis (CRITICAL)

**Claimed:** "Orchestrator synthesizes findings from child agents"
**Reality:** No synthesis - just copy-paste of last child agent

**What's NOT working:**
- Child agents don't produce reusable findings
- Child agents hit iteration limits before completing
- Orchestrator has no synthesis logic
- Final answer is "I will do X" instead of actual answer

### 3. Tool Selection (HIGH)

**Claimed:** "Agent uses appropriate tools based on task"
**Reality:** Agent uses grep instead of Mind RAG, explores wrong files

**What's NOT working:**
- Mind RAG not prioritized for semantic search
- No codebase structure awareness (reads sandbox, not agent code)
- Grep used for tasks better suited to Mind RAG

### 4. Error Recovery (MEDIUM)

**Claimed:** "Error recovery strategies generated"
**Reality:** Agent hit dead ends (find_definition failed) but didn't recover

**What's NOT working:**
- Recovery strategies logged but not executed (as documented)
- Agent doesn't try alternative approaches after tool failure
- No fallback to Mind RAG when grep fails

---

## 🎯 Real Improvement Priorities

### Priority 1: Fix Token Explosion (CRITICAL - 1 week)

**Goal:** Reduce SIMPLE task from 37K → <10K tokens

**Tasks:**
1. **Verify ContextFilter is actually running** (1 day)
   - Add debug logs to truncation logic
   - Verify outputs are truncated to 500 chars
   - Check if truncation bypassed somewhere

2. **Implement aggressive output filtering** (2 days)
   - Remove irrelevant tool outputs from context
   - Keep only last 2 iterations in full detail
   - Summarize older iterations

3. **Fix SmartSummarizer** (2 days)
   - Verify it's actually running (async job)
   - Ensure summaries replace old context
   - Add metrics to track compression ratio

**Expected Impact:**
- Tokens: 37K → 8-10K (70% reduction)
- Cost: $0.15 → $0.04 per SIMPLE task

---

### Priority 2: Force Mind RAG Usage (CRITICAL - 1 week)

**Goal:** Stop using grep for semantic search

**Tasks:**
1. **Add Mind RAG priority rule** (1 day)
   ```typescript
   // In task classification
   if (taskType === 'lookup' || taskType === 'research') {
     requiredTools = ['mind:rag-query'];  // Force Mind RAG first
     blockedTools = ['grep_search'];      // Block grep for semantic tasks
   }
   ```

2. **Add codebase context prompt** (2 days)
   ```
   You are working in the KB Labs monorepo.
   Key directories:
   - kb-labs-agents/ - Agent system implementation
   - kb-labs-mind/ - Mind RAG search engine
   - kb-labs-workflow/ - Workflow orchestration

   When searching for "agent system", use mind:rag-query NOT grep_search.
   ```

3. **Add tool failure fallback** (2 days)
   ```typescript
   // If grep/find fails, auto-fallback to Mind RAG
   if (toolName === 'grep_search' && !result.success) {
     logger.info('grep failed, falling back to Mind RAG');
     return await executeTool('mind:rag-query', transformArgs(args));
   }
   ```

**Expected Impact:**
- SIMPLE success rate: 70% → 90%
- RESEARCH success rate: 0% → 40%
- Answer quality: 7/10 → 9/10

---

### Priority 3: Fix RESEARCH Synthesis (CRITICAL - 2 weeks)

**Goal:** Get actual answers, not "I will do X" plans

**Tasks:**
1. **Add progressive synthesis to child agents** (1 week)
   - Every 5 iterations, synthesize partial answer
   - Store findings in structured format
   - Stop when answer is complete (don't hit iteration limit)

2. **Implement orchestrator synthesis** (1 week)
   - Collect findings from all child agents
   - Use LLM to synthesize final answer
   - Return actual answer, not plan

**Expected Impact:**
- RESEARCH success rate: 0% → 60%
- Duration: 180s → 90s (stop earlier)
- Quality: 0/10 → 7/10

---

### Priority 4: Add Sanity Checks (HIGH - 3 days)

**Goal:** Prevent agents from exploring wrong code

**Tasks:**
1. **Add file relevance check** (1 day)
   ```typescript
   // Before reading file
   if (taskAbout === 'agent system' && filePath.includes('.agent-sandbox')) {
     logger.warn('Skipping irrelevant file', { file: filePath });
     return { error: 'File not relevant to task' };
   }
   ```

2. **Add iteration budget warnings** (1 day)
   ```
   Iteration 9/12: ⚠️ You have 3 iterations left.
   If you don't have enough information to answer, REPORT NOW with partial answer.
   ```

3. **Add confidence gating** (1 day)
   ```typescript
   // Before reporting
   if (confidence < 0.7 && iterationsLeft > 2) {
     return { error: 'Confidence too low, continue searching' };
   }
   ```

**Expected Impact:**
- Prevent wasted work on wrong files
- Agents report partial answers instead of hitting limits
- Better resource usage

---

## 📅 Revised Roadmap

### Week 1-2: Emergency Fixes
- ✅ Fix token explosion (Priority 1)
- ✅ Force Mind RAG usage (Priority 2)
- ✅ Add sanity checks (Priority 4)

**Expected: SIMPLE works great, RESEARCH still broken but faster**

### Week 3-4: RESEARCH Mode
- ✅ Fix RESEARCH synthesis (Priority 3)
- ✅ Add progressive synthesis
- ✅ Implement orchestrator synthesis

**Expected: RESEARCH works at 60% success rate**

### Week 5+: Performance & Polish
- Parallel execution
- Self-learning error recovery
- Performance optimizations

---

## 🔍 Testing Protocol (NEW)

**Before claiming improvements:**

1. **Run these exact tests:**
   ```bash
   pnpm kb agent:run --task="What is the VectorStore interface?"
   pnpm kb agent:run --task="Explain how the agent system works"
   ```

2. **Record ACTUAL metrics:**
   - Tokens (from output)
   - Duration (from output)
   - Quality (manual review of answer)
   - Tool calls (from trace)

3. **Update benchmarks:**
   - [REAL-BENCHMARK-YYYY-MM-DD.md](REAL-BENCHMARK-2026-02-18.md)
   - Don't rely on old docs!

4. **Compare before/after:**
   - Use REAL numbers, not theoretical
   - Validate claims with actual runs

---

## 📋 Summary

### The Truth

**SIMPLE tasks:**
- ✅ Work (70% success)
- ❌ WAY too expensive (37K tokens vs claimed 5.4K)
- ⚠️ Partial answers (7/10 quality vs claimed 10/10)

**RESEARCH tasks:**
- ❌ Completely broken (0% success)
- ❌ Extremely expensive (200K+ tokens)
- ❌ Wrong behavior (explores sandbox code instead of agent system)

### The Lies

Old docs claimed (Feb 6):
- ✅ "5.4K tokens for SIMPLE" - **WRONG: Actually 37K**
- ✅ "10/10 quality" - **WRONG: Actually 7/10**
- ✅ "Context compression working" - **WRONG: Not working**
- ✅ "60% RESEARCH success" - **WRONG: Actually 0%**

### The Fix

**Focus on these 3 things:**
1. **Stop token explosion** - Fix ContextFilter and output truncation
2. **Force Mind RAG** - Stop using grep for semantic search
3. **Fix RESEARCH synthesis** - Progressive synthesis + orchestrator synthesis

---

**Last Updated:** 2026-02-18
**Next Run:** After Priority 1 fixes (1 week)
**Status:** REALITY CHECK COMPLETE
