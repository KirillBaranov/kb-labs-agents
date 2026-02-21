# KB Labs Agents

Autonomous AI agent system for [KB Labs](https://github.com/kirill-baranov/kb-labs). Executes natural-language tasks using LLM tool calling — reads files, writes code, runs commands, searches codebases, and validates results.

Part of the **KB Labs** ecosystem. Works through the platform CLI (`pnpm kb agent:run`) or REST/WebSocket APIs.

## Architecture

```
                    ┌─────────────┐
                    │  agent-cli  │   CLI / REST / WebSocket entry points
                    └──────┬──────┘
                           │
                 ┌─────────▼──────────┐
                 │  agent-task-runner  │   Plan → Execute → Verify pipeline
                 └─────────┬──────────┘
                           │
                    ┌──────▼──────┐
                    │  agent-core │   LLM orchestration, budget, quality gates
                    └──┬────┬────┘
                       │    │
              ┌────────▼┐  ┌▼──────────┐
              │  tools   │  │  tracing   │   Tool registry + NDJSON observability
              └────┬─────┘  └───────────┘
                   │
            ┌──────▼──────┐
            │   history    │   File snapshots, conflict resolution, rollback
            └─────────────┘

            ┌──────────────┐
            │  contracts   │   Shared types (used by every package above)
            └──────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| [`agent-contracts`](packages/agent-contracts/) | Type definitions, event schemas, API routes |
| [`agent-core`](packages/agent-core/) | Main agent engine — LLM loop, budget management, quality gates, 12 extracted modules |
| [`agent-cli`](packages/agent-cli/) | CLI plugin, REST handlers, WebSocket handlers for KB Labs platform |
| [`agent-tools`](packages/agent-tools/) | Tool registry — filesystem, search, shell, memory, delegation |
| [`agent-tracing`](packages/agent-tracing/) | Crash-safe NDJSON tracing, privacy redaction, trace analysis |
| [`agent-history`](packages/agent-history/) | File change tracking, snapshots, conflict detection and resolution |
| [`agent-task-runner`](packages/agent-task-runner/) | High-level plan/execute/verify pipeline with checkpointing |

## Quick Start

```bash
# From KB Labs root (kb-labs/)
pnpm install
pnpm --filter @kb-labs/agents run build

# Run an agent task
pnpm kb agent:run --task="Fix the login bug in auth.ts"

# Run with tracing
pnpm kb agent:run --task="Refactor the search module" --trace=./trace.ndjson

# Dry run (preview, no file changes)
pnpm kb agent:run --task="Add input validation" --dry-run
```

## How It Works

1. **Task Classification** — LLM classifies intent (action/discovery/analysis) and sets iteration budget
2. **Scope Extraction** — Narrows working directory to relevant subdirectory when possible
3. **Execution Loop** — LLM calls tools iteratively (read files, write code, run commands)
4. **Quality Gates** — Monitors drift, evidence density, tool error rate via EMA baselines
5. **Tier Escalation** — Upgrades to stronger LLM tier when task stalls or quality drops
6. **Completion Validation** — Heuristic + LLM-based evaluation of task success
7. **Tracing** — Every action logged to crash-safe NDJSON for debugging

## Development

```bash
# Build all packages
pnpm build

# Run tests (406 tests across 17 test files)
pnpm test

# Lint
pnpm lint

# Type check
pnpm type-check

# Full CI pipeline
pnpm ci
```

### Build Order

Packages must be built in dependency order:

```
1. agent-contracts   (no deps)
2. agent-history     (← contracts)
3. agent-tracing     (← contracts)
4. agent-tools       (← contracts)
5. agent-core        (← contracts, tools, history, tracing)
6. agent-task-runner (← contracts, core, tools)
7. agent-cli         (← contracts, core, tools, tracing)
```

`pnpm build` at root handles this automatically.

## agent-core Module Map

The core engine (`agent-core`) has been refactored from a single 5160-line file into focused modules:

| Module | Purpose |
|--------|---------|
| `execution/` | State machine, execution ledger, checkpoint |
| `budget/` | Iteration budget, quality gates, tier selection |
| `prompt/` | System prompt construction |
| `tool-input/` | Tool call validation and normalization |
| `progress/` | Progress tracking during execution |
| `search-signal/` | Search signal heuristics for discovery tasks |
| `analytics/` | Run metrics, KPI tracking, regression detection |
| `reflection/` | Self-evaluation between iterations |
| `todo-sync/` | Todo-list lifecycle for phase tracking |
| `task-classifier/` | LLM-based intent classification and scope extraction |
| `task-completion/` | Heuristic + LLM task completion validation |
| `context/` | Context filtering, sliding window, summarization |
| `memory/` | Short-term, long-term, working memory |
| `planning/` | Turn assembly and planning strategies |
| `modes/` | Execution modes (execute, plan, edit, debug) |

## Configuration

Agent configs live in `.kb/agents/` (JSON files defining tool permissions, LLM tiers, budgets).

Key environment variables:
- `OPENAI_API_KEY` — LLM provider API key
- `KB_AGENT_MAX_ITERATIONS` — Override default iteration budget
- `KB_AGENT_TRACE` — Enable tracing globally

## License

MIT
