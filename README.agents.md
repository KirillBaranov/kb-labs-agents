# KB Labs Agents

> **Autonomous task execution with comprehensive debugging and tracing**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-orange.svg)](https://pnpm.io/)

## Overview

KB Labs Agents is a comprehensive system for autonomous task execution with:
- ✅ **Incremental tracing** - Real-time NDJSON trace files with 12 event types
- ✅ **AI-friendly CLI** - Debug traces with `--json` output
- ✅ **Privacy-safe** - Automatic secret redaction
- ✅ **Cost tracking** - Automatic LLM token usage and cost calculation
- ✅ **Performance metrics** - Duration tracking at event and iteration level

## Quick Start

```bash
# Install dependencies
pnpm install

# Build packages
pnpm --filter @kb-labs/agent-core run build
pnpm --filter @kb-labs/agent-cli run build
pnpm --filter @kb-labs/agent-contracts run build

# Run an agent
pnpm kb agent run --task="Your task here"

# View trace statistics
pnpm kb agent trace stats --task-id=task-2026-02-14-abc123

# Filter trace events
pnpm kb agent trace filter --task-id=task-abc --type=llm:call

# View specific iteration
pnpm kb agent trace iteration --task-id=task-abc --iteration=3
```

## Documentation

📘 **[Agent Debugging Guide](./AGENT_DEBUGGING.md)** - Comprehensive guide to debugging agents with trace commands

## Features

### Incremental Tracing System

Real-time trace writing with:
- **NDJSON format** - Append-only, crash-safe
- **Dual flush** - 100ms OR 10 events (whichever comes first)
- **12 event types** - Complete execution visibility
- **Privacy redaction** - Automatic secret and path sanitization
- **Security** - Path traversal protection, file size limits, error-tolerant parsing

**Trace location:** `.kb/traces/incremental/{taskId}.ndjson`

### 12 Detailed Event Types

| Category | Event Types |
|----------|-------------|
| **Core** | `iteration:detail`, `llm:call`, `tool:execution`, `memory:snapshot` |
| **Analysis** | `decision:point`, `synthesis:forced`, `error:captured`, `prompt:diff` |
| **Optimization** | `tool:filter`, `context:trim`, `stopping:analysis`, `llm:validation` |

### AI-Friendly CLI Commands

All trace commands support `--json` flag for programmatic access:

```bash
# Human-readable output (default)
pnpm kb agent trace stats --task-id=abc
# → Pretty-printed with emojis, colors, formatting

# JSON output (for AI agents)
pnpm kb agent trace stats --task-id=abc --json
# → { "success": true, "data": {...}, "summary": {...} }
```

### Cost Tracking

Automatic cost calculation in every `llm:call` event:

```json
{
  "type": "llm:call",
  "cost": {
    "inputCost": 0.007374,
    "outputCost": 0.048615,
    "totalCost": 0.055989,
    "currency": "USD",
    "model": "claude-sonnet-4-5"
  }
}
```

**Pricing (2026-01-29):**
- Input: $3.00 per 1M tokens
- Output: $15.00 per 1M tokens

## Documentation

- 📘 **[Agent Tracing Guide](./docs/AGENT_TRACING.md)** - Complete user documentation (500+ lines)
- 🏗️ **[ADR-0001](./docs/adr/0001-incremental-agent-tracing.md)** - Architecture decision record (400+ lines)

## Packages

### @kb-labs/agent-core

Core agent execution and tracing infrastructure:

```typescript
import { AgentExecutor, IncrementalTraceWriter } from '@kb-labs/agent-core';

const executor = new AgentExecutor({
  agentId: 'my-agent',
  taskId: 'task-abc',
  traceConfig: {
    privacy: {
      redactSecrets: true,
      redactPaths: true,
    },
  },
});

await executor.execute(task, tools);
// Trace written to: .kb/traces/incremental/task-abc.ndjson
```

### @kb-labs/agent-cli

CLI commands for agent execution and trace analysis:

```bash
# Run agent
pnpm kb agent:run --agent-id=my-agent --task="Task description"

# View statistics
pnpm kb agent tracestats --task-id=task-abc [--json]

# Filter events
pnpm kb agent tracefilter --task-id=task-abc --type=llm:call [--json]

# View iteration
pnpm kb agent traceiteration --task-id=task-abc --iteration=3 [--json]
```

### @kb-labs/agent-contracts

Type-safe contracts and schemas:

```typescript
import type {
  DetailedTraceEntry,
  LLMCallEvent,
  ToolExecutionEvent,
  TraceCommandResponse,
  StatsResponse,
} from '@kb-labs/agent-contracts';
```

## Usage Examples

### 1. View Trace Statistics

```bash
pnpm kb agent tracestats --task-id=task-2026-01-29-abc123
```

**Output:**

```
📊 Trace Statistics

Status: ✅ Success
Iterations: 5

🤖 LLM Usage:
  Calls: 8
  Input tokens: 12,458
  Output tokens: 3,241
  Total tokens: 15,699

🔧 Tool Usage:
  Total calls: 15
  Successful: 14
  Failed: 1
  By tool:
    fs:read: 8
    mind:rag-query: 4
    fs:write: 3

⏱️  Timing:
  Started: 2026-01-29T10:15:30.000Z
  Completed: 2026-01-29T10:18:45.000Z
  Duration: 3m 15s

💰 Cost:
  Total: $0.0589 USD
```

### 2. Filter Events by Type

```bash
# View all LLM calls
pnpm kb agent tracefilter --task-id=task-abc --type=llm:call

# View tool executions (JSON)
pnpm kb agent tracefilter --task-id=task-abc --type=tool:execution --json
```

### 3. View Iteration Details

```bash
pnpm kb agent traceiteration --task-id=task-abc --iteration=3
```

**Output:**

```
🔄 Iteration 3

📊 Summary:
  Total events: 12
  LLM calls: 2
  Tool calls: 5
  Errors: 0
  Duration: 45382ms

📝 Events Timeline:

  iteration:detail: 1
  llm:call: 2
    Model: claude-sonnet-4-5
    Tokens: 3241
    Cost: $0.014523
  tool:execution: 5
    Tools: fs:read, mind:rag-query, fs:write
  memory:snapshot: 1
  decision:point: 2
  stopping:analysis: 1
```

## Privacy & Security

### Automatic Secret Redaction

Default patterns detected and redacted:

- API keys: `sk-[a-zA-Z0-9]+`, `pk_[a-zA-Z0-9]+`
- Tokens: `[a-f0-9]{32,}` (32+ hex chars)
- Passwords: `"password":\s*"[^"]+"`
- Bearer tokens: `Bearer\s+[A-Za-z0-9\-._~+/]+=*`
- AWS keys: `AKIA[0-9A-Z]{16}`

### Custom Patterns

```typescript
const executor = new AgentExecutor({
  agentId: 'my-agent',
  taskId: 'task-abc',
  traceConfig: {
    privacy: {
      secretPatterns: [
        'MY_CUSTOM_SECRET_\\w+',
        'internal-token-[a-z0-9]+',
      ],
    },
  },
});
```

### Path Replacement

```typescript
traceConfig: {
  privacy: {
    pathReplacements: {
      '/Users/john/company-secrets': '/home/user/redacted',
    },
  },
}
```

## Performance

### Dual Flush Mechanism

- **Time-based**: Flush every 100ms
- **Event-based**: Flush when buffer reaches 10 events
- **Whichever comes first** ensures low latency

### Shallow Clone Optimization

Privacy redaction only clones objects if secrets are detected:

- **No secrets**: ~0.1ms per event (no clone)
- **With secrets**: ~1-2ms per event (clone + redact)
- **Net overhead**: ~0.11ms per event average

## Architecture

### Core Components

1. **IncrementalTraceWriter** (`@kb-labs/agent-core`)
   - Real-time NDJSON writing with dual flush
   - Privacy redaction with shallow clone optimization
   - Automatic index generation

2. **Trace CLI Commands** (`@kb-labs/agent-cli`)
   - `agent tracestats` - Statistics with cost analysis
   - `agent tracefilter` - Filter events by type
   - `agent traceiteration` - View iteration details

3. **Privacy Redactor** (`@kb-labs/agent-core`)
   - Pattern-based secret detection
   - Path replacement for privacy
   - Shallow clone optimization

### Event Flow

```
Agent Execution
    ↓
Event Generated (llm:call, tool:execution, etc.)
    ↓
Privacy Redaction (if secrets detected)
    ↓
Buffer (10 events OR 100ms timeout)
    ↓
Flush to NDJSON file (.kb/traces/incremental/{taskId}.ndjson)
    ↓
Index Update (.kb/traces/incremental/{taskId}.index.json)
```

## Building

```bash
# Build all packages
pnpm --filter @kb-labs/agent-core run build
pnpm --filter @kb-labs/agent-cli run build
pnpm --filter @kb-labs/agent-contracts run build

# Or build all at once
pnpm run build
```

## Testing

```bash
# Run tests
pnpm --filter @kb-labs/agent-core run test
pnpm --filter @kb-labs/agent-cli run test

# With coverage
pnpm test -- --coverage
```

## Best Practices

### DO ✅

- **Always use `--json` for programmatic access** - Structured output for agents
- **Check trace files after agent failures** - Full execution history preserved
- **Use `trace:stats` for quick overview** - Cost, performance, errors at a glance
- **Enable privacy redaction in production** - Prevent secret leakage
- **Archive old trace files** - Keep `.kb/traces/incremental/` clean

### DON'T ❌

- **Don't disable tracing in production** - Critical for debugging
- **Don't commit trace files to git** - Large files, may contain secrets
- **Don't parse NDJSON manually** - Use trace CLI commands
- **Don't modify trace files** - Append-only format, corruption risk

## Troubleshooting

### Trace file not found

```bash
ls -la .kb/traces/incremental/
# Verify task ID matches filename
```

### Empty trace file

```bash
pnpm kb agent tracestats --task-id=task-abc --json
# → "CORRUPTED_TRACE: Trace file is empty"
```

### Invalid event type

```bash
pnpm kb agent tracefilter --task-id=task-abc --type=invalid
# → Shows all 12 valid event types
```

## Future Enhancements

**Planned for Phase 9+:**

- [ ] `trace:analyze` - Pattern detection (retry loops, context loss)
- [ ] `trace:compare` - Compare two traces side-by-side
- [ ] `trace:snapshot` - View memory state at specific iteration
- [ ] `trace:export` - Export to JSON/Markdown/HTML
- [ ] `trace:replay` - Programmatic replay for testing
- [ ] Web UI for trace visualization
- [ ] Real-time trace streaming via WebSocket

## License

MIT © KB Labs

---

**Version:** 1.0.0
**Last Updated:** 2026-01-29
**Status:** ✅ Production Ready
