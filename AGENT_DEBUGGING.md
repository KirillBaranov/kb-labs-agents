# Agent Debugging Guide

Complete guide to debugging agent executions using incremental NDJSON tracing.

## Overview

KB Labs agents automatically generate comprehensive trace files that capture every aspect of execution:
- **Iterations** - Each reasoning step
- **LLM calls** - All API calls with tokens and cost
- **Tool executions** - Every tool call (mind:rag-query, fs:read, etc.)
- **Errors** - All exceptions and failures
- **Memory** - Agent memory snapshots
- **Decisions** - Decision points and stop conditions

**Key features:**
- ✅ **Incremental append-only** - Crash-safe, survives agent failures
- ✅ **NDJSON format** - One JSON object per line, easy to parse
- ✅ **AI-friendly** - All commands support `--json` for agent-to-agent debugging
- ✅ **Secure** - Path traversal protection, file size limits, input validation

## Quick Start

### 1. Run an agent and get task ID

```bash
pnpm kb agent run --task="Your task here"

# Output:
# ┌── Agent Run
# │ Task ID: task-2026-02-14-abc123  ← Copy this!
# ...
# └── Success
```

### 2. View trace statistics

```bash
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123
```

**Example output:**
```
📊 Trace Statistics

Status: ✅ Success
Iterations: 8

🤖 LLM Usage:
  Calls: 8
  Input tokens: 45,234
  Output tokens: 3,456
  Total tokens: 48,690

🔧 Tool Usage:
  Total calls: 15
  Successful: 14
  Failed: 1
  By tool:
    mind:rag-query: 5
    fs:read: 8
    fs:write: 2

⏱️  Timing:
  Started: 2026-02-14T10:00:00.000Z
  Completed: 2026-02-14T10:05:30.000Z
  Duration: 5m 30s

💰 Cost:
  Total: $0.0234 USD

⚠️  Errors: 1
```

### 3. Debug issues

**If errors occurred:**
```bash
# Show all error events
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=error:captured
```

**If stuck in a loop:**
```bash
# Check specific iteration
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=5
```

**If wrong tools used:**
```bash
# Show all tool executions
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=tool:execution
```

## Commands Reference

### trace:stats - Overall Statistics

Show comprehensive execution statistics.

**Usage:**
```bash
pnpm kb agent trace stats --task-id=<task-id> [--json]
```

**What it shows:**
- Status (success/failed)
- Iteration count
- LLM usage (calls, tokens, cost)
- Tool usage (by tool, success/fail)
- Timing (start, end, duration)
- Error count

**Example:**
```bash
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123 --json
```

### trace:iteration - Iteration Details

View all events for a specific iteration.

**Usage:**
```bash
pnpm kb agent trace iteration --task-id=<task-id> --iteration=<N> [--json]
```

**What it shows:**
- Event timeline for iteration N
- LLM calls in that iteration
- Tools used in that iteration
- Errors that occurred
- Iteration duration

**Example:**
```bash
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=3
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=5 --json
```

### trace:filter - Filter by Event Type

Show only events of a specific type.

**Usage:**
```bash
pnpm kb agent trace filter --task-id=<task-id> --type=<event-type> [--json]
```

**Available event types:**
- `iteration:detail` - Iteration summaries
- `llm:call` - LLM API calls (with tokens, cost)
- `tool:execution` - Tool calls (mind:rag-query, fs:read, etc.)
- `memory:snapshot` - Agent memory state
- `decision:point` - Decision points
- `synthesis:forced` - Forced synthesis events
- `error:captured` - Errors and exceptions
- `prompt:diff` - Prompt changes between iterations
- `tool:filter` - Tool filtering decisions
- `context:trim` - Context trimming events
- `stopping:analysis` - Stop condition analysis
- `llm:validation` - LLM validation events

**Examples:**
```bash
# Show all LLM calls
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=llm:call

# Show all tool executions
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=tool:execution

# Show all errors
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=error:captured

# JSON output for automation
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=llm:call --json
```

## Debugging Workflows

### Workflow 1: Agent Failed

**Symptoms:** Agent crashed or returned error

**Steps:**
```bash
# 1. Get task ID from error output
# Task ID: task-2026-02-14-abc123

# 2. Check overall stats
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123

# 3. Filter errors
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=error:captured

# 4. Check last iteration before crash
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=5
```

**What to look for:**
- Error messages in `error:captured` events
- Last iteration number (agent stopped here)
- Tool calls that failed before crash
- LLM validation errors

### Workflow 2: Agent Stuck in Loop

**Symptoms:** Agent keeps retrying same operation

**Steps:**
```bash
# 1. Check iteration count
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123
# → Shows: Iterations: 25 (if hitting max)

# 2. Check iterations 20-25
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=20
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=25

# 3. Compare tool usage
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=tool:execution
```

**What to look for:**
- Repeated tool calls with same arguments
- Same LLM prompts in consecutive iterations
- Error → retry → error pattern

### Workflow 3: High Cost

**Symptoms:** Agent used too many tokens

**Steps:**
```bash
# 1. Check cost breakdown
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123
# → Shows total cost and token counts

# 2. Find expensive LLM calls
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=llm:call --json | \
  jq '.data.events[] | {iteration: .iteration, tokens: .response.usage.totalTokens, cost: .cost.totalCost}'

# 3. Check context trimming
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=context:trim
```

**What to look for:**
- Iterations with unusually high token counts
- Missing context:trim events (context growing unbounded)
- Large tool outputs being included in context

### Workflow 4: Wrong Result

**Symptoms:** Agent completed but result is wrong

**Steps:**
```bash
# 1. Check tool usage
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=tool:execution

# 2. Check decision points
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=decision:point

# 3. Check stopping analysis
pnpm kb agent trace filter --task-id=task-2026-02-14-abc123 --type=stopping:analysis

# 4. Review iteration by iteration
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=1
pnpm kb agent trace iteration --task-id=task-2026-02-14-abc123 --iteration=2
# ...
```

**What to look for:**
- Agent stopped too early (check stopping:analysis)
- Used wrong tools (e.g., grep instead of mind:rag-query)
- Skipped necessary steps

## AI-Friendly JSON Output

All trace commands support `--json` flag for programmatic access.

### JSON Response Structure

```typescript
interface TraceCommandResponse<T = any> {
  success: boolean;           // Whether command succeeded
  command: string;            // Command name (e.g., "trace:stats")
  taskId: string;             // Task ID analyzed
  data?: T;                   // Command-specific data
  error?: {                   // Error details (if success = false)
    code: string;
    message: string;
    details?: any;
  };
  summary: {
    message: string;          // One-liner summary
    severity: 'info' | 'warning' | 'error' | 'critical';
    actionable: boolean;      // Whether user should take action
  };
}
```

### Example: Parse stats with jq

```bash
# Get total cost
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123 --json | \
  jq '.data.cost.total'

# Get tool usage breakdown
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123 --json | \
  jq '.data.tools.byTool'

# Get iteration count
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123 --json | \
  jq '.data.iterations.total'
```

### Example: Agent-to-Agent Debugging

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function debugAgent(taskId: string) {
  // Get stats
  const { stdout } = await execAsync(
    `pnpm kb agent trace stats --task-id=${taskId} --json`
  );
  const stats = JSON.parse(stdout);

  if (!stats.success) {
    console.error('Trace not found:', stats.error.message);
    return;
  }

  // Check for errors
  if (stats.data.errors > 0) {
    console.log(`⚠️ Found ${stats.data.errors} errors`);

    // Get error details
    const { stdout: errorsJson } = await execAsync(
      `pnpm kb agent trace filter --task-id=${taskId} --type=error:captured --json`
    );
    const errors = JSON.parse(errorsJson);

    console.log('Error events:', errors.data.events);
  }

  // Check cost
  if (stats.data.cost.total > 0.10) {
    console.log(`💰 High cost: $${stats.data.cost.total.toFixed(4)}`);
  }

  // Check iteration count
  if (stats.data.iterations.total >= 25) {
    console.log('⚠️ Hit max iterations - possible loop');
  }
}
```

## Trace File Format

Traces use **NDJSON** (newline-delimited JSON) format:
- One JSON object per line
- Append-only (crash-safe)
- Can be read line-by-line (memory efficient)

### File Location

```
.kb/traces/incremental/<task-id>.ndjson
```

### Example Trace File

```jsonl
{"seq":1,"type":"iteration:detail","iteration":1,"timestamp":"2026-02-14T10:00:00.000Z","startedAt":"2026-02-14T10:00:00.000Z"}
{"seq":2,"type":"llm:call","iteration":1,"timestamp":"2026-02-14T10:00:01.234Z","request":{"model":"gpt-4","temperature":0.1},"response":{"usage":{"inputTokens":500,"outputTokens":100,"totalTokens":600}},"cost":{"inputCost":0.0050,"outputCost":0.0030,"totalCost":0.0080},"timing":{"durationMs":1234}}
{"seq":3,"type":"tool:execution","iteration":1,"timestamp":"2026-02-14T10:00:02.456Z","tool":{"name":"mind:rag-query","args":{"text":"How does X work?"}},"output":{"success":true,"data":"..."},"timing":{"durationMs":5432}}
{"seq":4,"type":"error:captured","iteration":1,"timestamp":"2026-02-14T10:00:03.789Z","error":{"message":"File not found","code":"ENOENT","stack":"..."}}
```

### Reading Traces Manually

**With jq:**
```bash
# Count events
cat .kb/traces/incremental/task-2026-02-14-abc123.ndjson | wc -l

# Filter LLM calls
cat .kb/traces/incremental/task-2026-02-14-abc123.ndjson | \
  jq 'select(.type == "llm:call")'

# Sum total cost
cat .kb/traces/incremental/task-2026-02-14-abc123.ndjson | \
  jq 'select(.type == "llm:call") | .cost.totalCost' | \
  awk '{sum+=$1} END {print sum}'
```

**With grep:**
```bash
# Find all errors
grep '"type":"error:captured"' .kb/traces/incremental/task-2026-02-14-abc123.ndjson

# Count iterations
grep '"type":"iteration:detail"' .kb/traces/incremental/task-2026-02-14-abc123.ndjson | wc -l
```

## Security Features

### Path Traversal Protection

Task IDs are validated to prevent directory traversal attacks:

```typescript
// ✅ Valid task IDs
task-2026-02-14-abc123
my-task-2026
task_with_underscores

// ❌ Invalid task IDs (rejected)
../../../etc/passwd
task-../../secrets
../../malicious
```

**Validation:**
- Only alphanumeric, hyphens, and underscores allowed
- `path.relative()` check ensures resolved path is within `.kb/traces/incremental/`
- Prevents both Unix and Windows path traversal

### File Size Limits

Trace files are limited to **100MB** to prevent memory exhaustion:

```typescript
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const fileStats = await fs.stat(tracePath);
if (fileStats.size > MAX_FILE_SIZE) {
  throw new Error('FILE_TOO_LARGE');
}
```

**Why 100MB?**
- Typical trace: 1-10 KB per event
- 100MB = ~10,000-100,000 events
- Protects against malicious large files
- Prevents server OOM crashes

### Error-Tolerant Parsing

Malformed NDJSON lines are skipped gracefully:

```typescript
const events: DetailedTraceEntry[] = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    console.warn(`Skipped malformed NDJSON line: ${line.substring(0, 50)}...`);
  }
}
```

**Benefits:**
- Corrupted trace files don't crash commands
- Partial traces can still be analyzed
- Useful for debugging crashes (trace survives)

## Best Practices

### DO ✅

- **Start with stats** - Always check `trace:stats` first for overview
- **Use --json for automation** - Parse output programmatically
- **Filter by event type** - Focus on relevant events (errors, LLM calls, tools)
- **Check specific iterations** - When you know which iteration failed
- **Compare successful vs failed runs** - Use same task to understand differences

### DON'T ❌

- **Don't manually edit trace files** - They're auto-generated and append-only
- **Don't assume task IDs** - Always get task ID from agent run output
- **Don't skip stats** - Stats show overall health at a glance
- **Don't parse NDJSON manually** - Use `--json` flag or jq
- **Don't delete traces prematurely** - Keep for historical comparison

## Troubleshooting

### "Trace file not found"

**Cause:** Task ID doesn't exist or was mistyped

**Solution:**
```bash
# List all trace files
ls -la .kb/traces/incremental/

# Check task ID in original agent run output
pnpm kb agent run --task="..."
# → Task ID: task-2026-02-14-abc123
```

### "Invalid task ID"

**Cause:** Task ID contains invalid characters

**Solution:**
- Only use task IDs from agent run output
- Don't manually construct task IDs
- Valid format: `task-YYYY-MM-DD-<random>` or package names like `@kb-labs/package-name`

### "File too large"

**Cause:** Trace file exceeds 100MB limit

**Solution:**
```bash
# Check file size
ls -lh .kb/traces/incremental/task-2026-02-14-abc123.ndjson

# If legitimate large trace, process manually with streaming:
cat .kb/traces/incremental/task-2026-02-14-abc123.ndjson | \
  jq -c 'select(.type == "error:captured")' | \
  head -20
```

### "Skipped malformed NDJSON line"

**Cause:** Corrupted line in trace file (e.g., agent crashed mid-write)

**Impact:**
- Warning only, not an error
- Command continues processing valid lines
- Useful for debugging crashes

**Action:**
- Check if agent crashed (process killed, OOM, etc.)
- Review events before corruption point
- Malformed lines are logged with first 50 characters

## Real-World Case Study

### Case: Agent Overwrites Root Files Instead of Creating Subdirectory

**Date:** 2026-02-14
**Trace ID:** `task-1771096807514`

**Problem:**
User asked agent to create a new service in `kb-labs-code-review/` directory, but agent wrote files to project root instead:
- Overwrote `package.json` in root
- Overwrote `tsconfig.json` in root
- Overwrote `.gitignore` in root

**How tracing revealed the root cause:**

**Step 1: Get task ID and stats**
```bash
ls -lt .kb/traces/incremental/
# → task-1771096807514.ndjson

pnpm kb agent trace stats --taskId=task-1771096807514
# → 2 iterations, 1 fs_write call
```

**Step 2: Check what files were written**
```bash
grep '"type":"tool:execution"' .kb/traces/incremental/task-1771096807514.ndjson | \
  jq '.input.path'
# → "package.json" (no subdirectory prefix!)
```

**Step 3: Check agent's thinking**
```bash
grep '"type":"llm_response"' .kb/traces/incremental/task-1771096807514.ndjson | \
  jq -r '.data.content'
# → "Now let me create the monorepo structure for the kb-labs-code-review project:"
```

Agent thought "kb-labs-code-review" was just the **name** of the project, not a **subdirectory to create**.

**Step 4: Check task context in memory**
```bash
grep '"type":"task_start"' .kb/traces/incremental/task-1771096807514.ndjson | \
  jq -r '.data.systemPrompt' | grep "Previous Context from Memory"
# → Only shows decomposed subtask, NOT original user task
```

**Root cause found:**

Original user task:
```
"5. Структура:
   - Создать в kb-labs-code-review/  ← CRITICAL CONTEXT!
   - Стандартная структура: packages/code-review-{core,cli,rest,contracts}"
```

Subtask given to agent (via orchestrator decomposition):
```
"Initialize the kb-labs-code-review project directory with a monorepo structure"
```

**Lost context:** "Create IN kb-labs-code-review/" (create subdirectory)

**Solution:** See [Orchestrator Context Preservation Plan](../../docs/plans/2026-02-14-orchestrator-context-preservation.md)

**Key learnings:**
1. ✅ Tracing made root cause obvious in 5 minutes
2. ✅ Problem was NOT in agent logic, but in orchestrator decomposition
3. ✅ Memory snapshots revealed missing original task context
4. ✅ Tool execution traces showed exact paths written

**Prevention:**
- Pass original user task to agent memory
- Extract global constraints (target directory, etc.)
- Add validation in fs_write for potentially destructive operations

## Related Files

- [trace-stats.ts](packages/agent-cli/src/cli/commands/trace-stats.ts) - Stats command implementation
- [trace-iteration.ts](packages/agent-cli/src/cli/commands/trace-iteration.ts) - Iteration command
- [trace-filter.ts](packages/agent-cli/src/cli/commands/trace-filter.ts) - Filter command
- [trace-command-response.ts](packages/agent-contracts/src/trace-command-response.ts) - Response types
- [incremental-ndjson-trace-writer.ts](packages/agent-core/src/tracing/incremental-ndjson-trace-writer.ts) - Trace writer

## Future Enhancements

Planned features for agent debugging:

- **trace:compare** - Compare two agent runs side-by-side
- **trace:analyze** - Pattern detection (retry loops, context loss, etc.)
- **trace:export** - Export to markdown/HTML for sharing
- **trace:replay** - Programmatic replay of agent execution
- **trace:snapshot** - Memory snapshot restoration
- **Web UI** - Visual trace explorer with timeline

---

**Last Updated:** 2026-02-14
**Version:** 1.0.0
**Status:** ✅ Production-ready
