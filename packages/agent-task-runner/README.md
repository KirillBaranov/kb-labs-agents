# @kb-labs/agent-task-runner

High-level task execution pipeline for KB Labs agents. Orchestrates the full plan → execute → verify lifecycle with checkpointing and failure recovery.

## Architecture

```
┌───────────┐     ┌───────────┐     ┌───────────┐
│  Planner  │ ──→ │ Executor  │ ──→ │ Verifier  │
│           │     │           │     │           │
│ Decompose │     │ Run steps │     │ Validate  │
│ task into │     │ with tool │     │ results + │
│ steps     │     │ calls     │     │ quality   │
└───────────┘     └─────┬─────┘     └───────────┘
                        │
                 ┌──────▼──────┐
                 │ Checkpoint  │   Save/restore state
                 └──────┬──────┘
                        │
                 ┌──────▼──────┐
                 │ Escalation  │   Recovery strategies
                 └─────────────┘
```

## Components

### TaskRunner

Main orchestrator that coordinates all phases.

```typescript
import { TaskRunner } from '@kb-labs/agent-task-runner';

const runner = new TaskRunner(agent, config);
const result = await runner.run('Implement user authentication');
```

### Planner

Decomposes a natural-language task into a sequence of executable steps.

### Executor

Executes planned steps by invoking tools through the agent's tool registry.

### Verifier

Validates execution results against quality criteria and task requirements.

### Checkpoint

Saves execution state at key points for crash recovery. On restart, the runner resumes from the last checkpoint.

### Escalation

Handles failures with configurable recovery strategies:
- Retry with different parameters
- Escalate to stronger LLM tier
- Fall back to simpler approach
- Request human intervention

## Dependencies

- `@kb-labs/agent-core` — agent engine
- `@kb-labs/agent-contracts` — shared types
- `@kb-labs/agent-tools` — tool registry
- `@kb-labs/sdk` — platform SDK
