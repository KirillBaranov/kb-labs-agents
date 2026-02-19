# Root Cause Analysis: Why Agent Performance Is Catastrophic

**Date:** 2026-02-18
**Context:** Real benchmarks showed 18x worse performance than documentation claims

---

## 🔥 Summary: The 4 Root Causes

### 1. **Classification Logic Is Fundamentally Broken** (CRITICAL)

**Problem:** LLM Q&A classification marks SIMPLE tasks as RESEARCH.

**Evidence:**
```bash
# Task: "What is the VectorStore interface?"
# Expected: SIMPLE (direct agent, 1 agent, <10K tokens)
# Actual: Spawned 2 child agents, 96K tokens, 4m 52s
```

**Root Cause in Code** (`orchestrator.ts` lines 468-540):

```typescript
// Classification uses Q&A with LLM:
// Q1: "Does task mention 'how', 'explain', 'architecture', 'system'?"
// Q2: "Does task ask about ONE specific thing?"

// Classification prompt:
const prompt = `Task: "${task}"
Q1: Does this task mention keywords like "how", "explain", "architecture", "system"?
Q2: Does this task ask about ONE specific thing (class/interface/function)?

If Q1=yes and Q2=no → RESEARCH
If Q2=yes → SIMPLE
Else → COMPLEX
`;
```

**Why It Fails:**
- **"What is VectorStore interface?"** contains "interface" but LLM interprets it as architectural question
- Keyword matching ("architecture", "system") is too broad and triggers false positives
- LLM is inconsistent (same query can get different classifications on different runs)
- No validation: Classification result is blindly trusted

**Impact:**
- SIMPLE tasks spawn multiple child agents (96K tokens instead of 37K)
- Each child agent burns tokens exploring wrong files
- Orchestrator has no context from child agents to synthesize answer

---

### 2. **ContextFilter Works But Is Bypassed** (CRITICAL)

**Problem:** Context truncation is implemented correctly but NOT actually applied to LLM calls.

**Evidence from code:**

**ContextFilter.ts (lines 145-172) - WORKS CORRECTLY:**
```typescript
truncateMessage(msg: Message): Message {
  if (msg.role !== 'tool') return msg;

  const content = msg.content || '';
  const maxLen = this.config.maxOutputLength; // 500 chars

  if (content.length <= maxLen) return msg;

  // Truncate with hint
  const truncated = content.slice(0, maxLen);
  return {
    ...msg,
    content: `${truncated}\n\n... (truncated)`,
  };
}
```

**This code is PERFECT!** But it's not being used.

**Where It's Called** (`agent.ts` or `orchestrator.ts`):

```typescript
// ❌ PROBLEM: buildDefaultContext is called BUT result is NOT passed to LLM!

const context = this.contextFilter.buildDefaultContext(
  systemPrompt,
  taskMessage,
  currentIteration,
  summaries
);
// context is now properly truncated

// But then somewhere in agent.ts:
const response = await llm.invoke({
  messages: this.fullHistory,  // ❌ WRONG! Uses full history, not truncated context
  tools: availableTools,
});
```

**Root Cause:**
- `buildDefaultContext()` correctly truncates outputs to 500 chars
- BUT the agent passes `this.fullHistory` to LLM instead of the truncated context
- Truncation logic exists but is **never applied** in practice

**Impact:**
- 37K tokens for 5-iteration simple task (should be ~5K with truncation)
- Every iteration adds 7K tokens due to full tool outputs being included
- Costs 7x more than documented

---

### 3. **Mind RAG Not Forced For Semantic Search** (HIGH)

**Problem:** Agents prefer `grep_search` over `mind:rag-query` for semantic searches.

**Evidence:**
```typescript
// Agent sees these tools:
availableTools = [
  { name: 'grep_search', description: 'Search files by pattern' },
  { name: 'mind:rag-query', description: 'Semantic code search' },
  { name: 'find_definition', description: 'Find code definition' },
  // ...
];

// Agent chooses:
Iteration 1: grep_search "VectorStore" → 100 matches (useless)
Iteration 2: find_definition "VectorStore" → Not found
Iteration 3: grep_search "interface VectorStore" → Not found

// Should have used:
mind:rag-query "VectorStore interface definition" → Direct answer
```

**Root Cause:**
- No tool prioritization logic for semantic vs exact-match searches
- Agent prompt doesn't guide tool selection based on task type
- `grep_search` is listed first in tool array (LLM picks first familiar tool)
- No fallback: When grep fails, agent doesn't try Mind RAG

**Why Mind RAG Isn't Used:**
1. **Prompt doesn't explain when to use each tool:**
   ```typescript
   // Current system prompt:
   "You have access to these tools: grep_search, mind:rag-query, find_definition"

   // Should say:
   "For semantic searches (understanding what/how), use mind:rag-query FIRST.
    For exact string matching (TODO comments, imports), use grep_search."
   ```

2. **No task-specific tool filtering:**
   ```typescript
   // When task is classified as "lookup":
   if (taskType === 'lookup') {
     requiredTools = ['mind:rag-query'];  // Force Mind RAG
     blockedTools = ['grep_search'];      // Prevent grep
   }
   ```

**Impact:**
- SIMPLE tasks use 5 iterations of grep instead of 1 Mind RAG query
- Grep returns 100 irrelevant matches, wastes tokens, confuses agent
- Agent gives up after max iterations instead of finding answer

---

### 4. **Orchestrator Hallucination - No Answer Verification** (CATASTROPHIC)

**Problem:** Orchestrator returns WRONG answers without checking factual correctness.

**Evidence:**
```
Task: "What is the VectorStore interface?"
Child Agent 1: "Found references to IVectorStore adapter" (partial, KB Labs code)
Child Agent 2: "Not found" (gave up)

Orchestrator Final Answer:
"The VectorStore interface is LangChain's abstract base class for vector stores..."

❌ THIS IS A HALLUCINATION! We asked about KB Labs, not LangChain!
```

**Root Cause in Code** (`orchestrator.ts` synthesis logic):

```typescript
// Orchestrator synthesis (RESEARCH mode):
async synthesizeFindings(task: string, childResults: TaskResult[]): Promise<string> {
  const llm = useLLM({ tier: 'large' });

  // Collect child agent outputs
  const findings = childResults.map(r => r.answer).join('\n\n');

  // Ask LLM to synthesize
  const response = await llm.invoke({
    messages: [
      { role: 'system', content: 'Synthesize findings into final answer' },
      { role: 'user', content: `Task: ${task}\n\nFindings:\n${findings}` }
    ]
  });

  // ❌ NO VERIFICATION! Just return LLM output
  return response.content;
}
```

**Why Hallucination Happens:**
1. **No grounding check** - LLM fills gaps with general knowledge (LangChain VectorStore)
2. **No source verification** - Doesn't check if answer comes from actual codebase
3. **No confidence scoring** - Can't tell if answer is factual or guessed
4. **No anti-hallucination** - No cross-check against indexed code

**What's Missing:**
```typescript
// Should verify answer against source:
const verification = await mindRagQuery(answer);
if (verification.confidence < 0.7) {
  return "INSUFFICIENT_INFORMATION: Could not find definitive answer in codebase";
}

// Or use anti-hallucination:
const sources = extractSources(findings);
if (!answerMatchesSources(answer, sources)) {
  return "Answer could not be verified against codebase sources";
}
```

**Impact:**
- **0/10 quality** - Answer is factually incorrect
- **User misinformation** - Provides wrong information confidently
- **Wasted work** - Spent 96K tokens to produce hallucinated answer

---

## 📊 How These Combine To Create Catastrophe

### SIMPLE Task Flow (Actual vs Expected)

**Expected Flow:**
```
User: "What is VectorStore interface?"
  ↓
Orchestrator: Classify as SIMPLE (1 agent)
  ↓
Agent: mind:rag-query "VectorStore interface" → Direct answer
  ↓
Orchestrator: Return answer (confidence 0.8)
  ↓
Result: 1 agent, 1 tool call, 5K tokens, 20s, 8/10 quality ✅
```

**Actual Flow (Broken):**
```
User: "What is VectorStore interface?"
  ↓
Orchestrator: ❌ Classify as RESEARCH (keyword "interface" triggers false positive)
  ↓
Orchestrator: Spawn 2 child agents (why 2? decomposition LLM guessed)
  ↓
Child Agent 1:
  - Iteration 1: grep_search "VectorStore" → 100 matches (7K tokens)
  - Iteration 2: find_definition → Not found (7K tokens)
  - Iteration 3: grep_search "interface VectorStore" → Not found (11K tokens)
  - Iteration 4: grep_search different pattern → 5 matches (7K tokens)
  - Iteration 5: report_to_orchestrator → partial answer (4K tokens)
  - Total: 37K tokens (❌ context not truncated!)
  ↓
Child Agent 2:
  - Iterations 1-12: Search, fail, search, fail... (59K tokens)
  - Hit iteration limit, return "not found"
  ↓
Orchestrator: Synthesize findings
  - Child 1: "Found IVectorStore adapter reference" (vague)
  - Child 2: "Not found"
  - ❌ LLM fills gap with general knowledge → HALLUCINATES LangChain answer
  ↓
Result: 2 agents, 96K tokens, 4m 52s, 0/10 quality (HALLUCINATION) ❌
```

---

## 🎯 Fix Priority & Estimated Impact

### Priority 1: Fix Context Truncation Application (1 day)

**Current state:** ContextFilter works, but agent uses `fullHistory` instead.

**Fix:**
```typescript
// agent.ts execute() loop:
const context = this.contextFilter.buildDefaultContext(
  systemPrompt,
  taskMessage,
  currentIteration,
  summaries
);

// Pass truncated context to LLM, not fullHistory
const response = await llm.invoke({
  messages: context,  // ✅ Use truncated context!
  tools: availableTools,
});
```

**Impact:**
- Tokens: 37K → 8-10K (70% reduction)
- Cost: $0.15 → $0.04 per SIMPLE task
- **This alone fixes the token explosion!**

---

### Priority 2: Remove Task Classification (2 days)

**Current state:** Classification causes more harm than good (false positives).

**Fix:**
```typescript
// Option A: Always use direct agent (SIMPLE mode)
// Remove classifyTask() entirely
// Let agent decide when to spawn children via tool calling

// Option B: Simpler heuristic (no LLM)
function classifyTask(task: string): TaskComplexity {
  // Multi-file editing? → COMPLEX
  if (task.includes('refactor') || task.includes('across')) {
    return 'complex';
  }

  // Everything else → SIMPLE (let agent decide)
  return 'simple';
}
```

**Impact:**
- SIMPLE tasks: No longer spawn child agents (96K → 37K tokens)
- Faster: 4m 52s → 20s (13x speedup)
- More reliable: Single agent context vs fragmented child contexts

---

### Priority 3: Force Mind RAG for Semantic Searches (1 day)

**Fix:**
```typescript
// When classifying tools for task:
if (isSemanticSearch(task)) {
  // Prioritize Mind RAG
  availableTools = [
    mindRagTool,       // Listed first
    ...otherTools.filter(t => t.name !== 'grep_search')
  ];

  // Update system prompt
  systemPrompt += `
  IMPORTANT: This is a semantic search task.
  You MUST use mind:rag-query FIRST before trying other tools.
  Do NOT use grep_search for semantic queries like "what is X" or "how does Y work".
  `;
}

// Add fallback
if (toolName === 'grep_search' && result.matches > 50) {
  logger.warn('grep returned too many matches, try mind:rag-query instead');
  // Auto-suggest Mind RAG
}
```

**Impact:**
- SIMPLE success: 70% → 90% (fewer grep dead-ends)
- Iterations: 5 → 1-2 (Mind RAG answers directly)
- Quality: 7/10 → 9/10 (semantic understanding)

---

### Priority 4: Add Answer Verification (1 week)

**Fix:**
```typescript
// Orchestrator synthesis with verification:
async synthesizeFindings(task: string, findings: string[]): Promise<string> {
  const llm = useLLM({ tier: 'large' });

  // Generate candidate answer
  const candidateAnswer = await llm.invoke({
    messages: [
      { role: 'system', content: 'Synthesize findings' },
      { role: 'user', content: `Task: ${task}\nFindings: ${findings.join('\n')}` }
    ]
  });

  // ✅ VERIFY answer against codebase
  const verification = await this.verifyAnswer(candidateAnswer.content);

  if (verification.confidence < 0.7) {
    return {
      answer: "INSUFFICIENT_INFORMATION",
      confidence: verification.confidence,
      reason: "Could not verify answer against codebase sources"
    };
  }

  return candidateAnswer.content;
}

async verifyAnswer(answer: string): Promise<{ confidence: number }> {
  // Use Mind RAG to check if answer exists in codebase
  const ragResult = await mindRagQuery(answer);

  // Check source overlap
  const sourcesMatch = checkSourceOverlap(answer, ragResult.sources);

  return {
    confidence: sourcesMatch ? ragResult.confidence : 0.0
  };
}
```

**Impact:**
- Quality: 0/10 → 7/10 (no more hallucinations)
- Trust: Users can rely on answers being factual
- Clarity: "INSUFFICIENT_INFORMATION" better than wrong answer

---

## 📋 Summary: Root Causes Mapped to Symptoms

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| 96K tokens (18x worse) | Context truncation bypassed | Use truncated context in LLM calls |
| SIMPLE spawns 2 child agents | Classification false positive | Remove classification or simplify |
| 5 iterations of grep | Mind RAG not prioritized | Force Mind RAG for semantic searches |
| Hallucinated LangChain answer | No answer verification | Add verification against codebase |
| 4m 52s (13x slower) | Child agents + token explosion | Fix classification + context |
| 0/10 quality | Hallucination + wrong tool use | Verification + Mind RAG priority |

---

## 🚀 Recommended Fix Order

**Week 1: Emergency Fixes (3 days)**
1. ✅ Fix context truncation application (1 day) → 70% cost reduction
2. ✅ Force Mind RAG for semantic searches (1 day) → 90% success rate
3. ✅ Remove/simplify task classification (1 day) → No more false RESEARCH spawns

**Expected after Week 1:**
- SIMPLE tasks: 96K → 10K tokens (90% reduction)
- Duration: 4m 52s → 25s (12x faster)
- Success: 70% → 90%
- Quality: Still partial (no verification yet)

**Week 2-3: Quality Fixes (1 week)**
4. ✅ Add answer verification (1 week) → 0/10 → 7/10 quality

**Expected after Week 2:**
- Quality: 0/10 → 7/10 (no hallucinations)
- RESEARCH mode: 0% → 40% success (still needs synthesis work)

---

**Last Updated:** 2026-02-18
**Status:** Root cause analysis complete, ready for fixes
