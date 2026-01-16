# Agent Roadmap TODO

**Status:** In Progress
**Last Updated:** 2026-01-15

## ✅ Completed Phases

### Phase 1: Task Classification + ReAct Pattern
- ✅ Task Classifier (LLM-based)
- ✅ ReAct System Prompt (Thought → Action → Observation)
- ✅ ReAct Parser
- ✅ Integration with AgentExecutor

### Phase 2: Execution Memory (Partial ⚠️)
- ✅ Basic ExecutionMemory class
- ✅ Finding extraction from tool calls
- ✅ Memory injection into system prompt
- ❌ **Missing:**
  - `currentPhase` tracking (plan/execute/verify)
  - `triedApproaches` - failed attempts tracking
  - `hypotheses` - working theories
  - Full `StepSummary` with learnings and impactOnGoal

### Phase 3: Progress Tracking (Partial ⚠️)
- ✅ ProgressTracker with LLM estimation
- ✅ Progress percent calculation
- ✅ Stuck detection (isStuck flag)
- ✅ Blocker identification
- ❌ **Missing:**
  - Progressive Summarization (every 5 steps)
  - Context Compression for long tasks (15+ steps)
  - Phase transition triggers

### Phase 4: Error Recovery (Partial ⚠️)
- ✅ ErrorRecovery class with LLM-based strategy generation
- ✅ 5 recovery strategies (retry, alternative-tool, parameter-adjustment, escalate, give-up)
- ✅ Integration with loop detection
- ✅ Observability-first (logs strategies)
- ✅ **Bonus:** Fixed fs:search path usage bug (anti-hallucination)
- ❌ **Missing (Full ROADMAP Phase 4):**
  - Error Observation Collector (record errors in corpus)
  - Zero-Config Tool Introspection (analyze tools via LLM)
  - Pattern Extraction (learn from similar errors)
  - Learning-Enhanced Recovery (use patterns first, LLM fallback)
  - Vector search for similar past errors
  - Cross-session learning (patterns persist)

---

## 🚧 TODO: Complete Missing Features

### Priority 1: Finish Phase 4 (Self-Learning Error Recovery)

**Goal:** Full ROADMAP Phase 4 implementation

**Tasks:**
1. [ ] **Error Observation Collector** (`agent-core/src/learning/error-observer.ts`)
   - Record every error in cache/vectorstore
   - Link resolutions to original errors
   - Vector search for similar errors
   - Estimated: 1 day

2. [ ] **Zero-Config Tool Introspection** (`agent-core/src/learning/tool-analyzer.ts`)
   - LLM-based tool analysis from definition
   - Cache tool insights (30 day TTL)
   - Infer: purpose, resourceType, likelyErrors, prerequisites
   - Estimated: 0.5 days

3. [ ] **Pattern Extraction** (`agent-core/src/learning/pattern-extractor.ts`)
   - Background job to extract patterns from error corpus
   - Group similar errors via vector embeddings
   - LLM-based pattern generalization
   - Save patterns to cache
   - Estimated: 1 day

4. [ ] **Learning-Enhanced Recovery** (`agent-core/src/recovery/learning-recovery.ts`)
   - Check learned patterns first (fast path)
   - Vector search for similar resolved cases
   - Fallback to LLM analysis
   - Record successful recoveries
   - Estimated: 1 day

**Total Estimate:** 3-4 days

### Priority 2: Complete Phase 2 (Full Execution Memory)

**Goal:** Support long multi-step tasks (15+ steps)

**Tasks:**
1. [ ] Add `currentPhase` tracking
   - Track: plan, execute, verify phases
   - Phase transition logic
   - Estimated: 0.5 days

2. [ ] Add `triedApproaches` tracking
   - Record failed attempts with reasons
   - Prevent retry of known failures
   - Estimated: 0.5 days

3. [ ] Add `hypotheses` tracking
   - Current working theories
   - Hypothesis validation/invalidation
   - Estimated: 0.5 days

4. [ ] Enhance `StepSummary`
   - Add learnings field
   - Add impactOnGoal field
   - Estimated: 0.5 days

**Total Estimate:** 2 days

### Priority 3: Complete Phase 3 (Progressive Summarization)

**Goal:** Handle tasks with 20+ steps without token overflow

**Tasks:**
1. [ ] **Progressive Summarizer** (`agent-core/src/memory/summarizer.ts`)
   - Summarize every 5 steps via LLM
   - Compress old context
   - Keep recent steps detailed
   - Estimated: 1 day

2. [ ] **Context Compression Trigger**
   - Monitor token usage
   - Trigger summarization at 80% of limit
   - Estimated: 0.5 days

3. [ ] **Phase Transition Summarization**
   - Summarize when transitioning between phases
   - Estimated: 0.5 days

**Total Estimate:** 2 days

---

## 📅 Implementation Order

### Option A: Depth-first (Complete one phase at a time)
1. **Week 1-2:** Complete Phase 4 (Self-Learning Error Recovery) - 3-4 days
2. **Week 3:** Complete Phase 2 (Full Execution Memory) - 2 days
3. **Week 4:** Complete Phase 3 (Progressive Summarization) - 2 days
4. **Week 5:** Phase 5 (Observability & Analytics)

**Pros:** Full feature set per phase, easier to test
**Cons:** Longer before seeing full benefits

### Option B: Breadth-first (Critical features first)
1. **Week 1:** Error Observer + Tool Introspection (Phase 4.1 + 4.2)
2. **Week 2:** triedApproaches + Progressive Summarization (Phase 2.2 + 3.1)
3. **Week 3:** Pattern Extraction + Learning Recovery (Phase 4.3 + 4.4)
4. **Week 4:** Complete remaining features

**Pros:** Quick wins, iterative improvement
**Cons:** Features incomplete until later

**Recommended:** Option A (depth-first) - complete Phase 4 first

---

## 🎯 Success Metrics

### Phase 2 Complete (Full Memory)
- ✅ Agent remembers ALL attempted approaches
- ✅ No repeated failed attempts
- ✅ Clear phase transitions (plan → execute → verify)

### Phase 3 Complete (Summarization)
- ✅ Agent handles 20+ step tasks without token overflow
- ✅ Context stays under 50K tokens
- ✅ Progressive summaries maintain key information

### Phase 4 Complete (Self-Learning)
- ✅ 80% of errors recover without LLM (using patterns)
- ✅ Average recovery time < 500ms
- ✅ Pattern library grows automatically (10+ patterns per tool after 50 errors)
- ✅ Cross-session learning works (patterns persist)

---

## 📝 Notes

### Why This Order?

**Phase 4 first** because:
1. Error recovery is **most impactful** - directly increases success rate
2. Self-learning provides **long-term value** - improves over time
3. Builds foundation for **observability** - error corpus useful for analytics

**Phase 2-3 after** because:
1. Current implementation works for **short tasks** (3-10 steps)
2. Most real tasks are short (lookup, simple operations)
3. Long tasks (15+ steps) are edge cases currently

### Integration Points

- **Error Observer** uses `useCache()` and `useVectorStore()` from platform
- **Tool Introspection** uses `useLLM()` for analysis
- **Pattern Extraction** uses `useLLM()` and vector embeddings
- All features integrate with existing `ExecutionMemory` and `ProgressTracker`

---

**Last Updated:** 2026-01-15
**Next Review:** After Phase 4 completion
**Status:** Ready to continue implementation
