# @kb-labs/progress-reporter

UX-only progress feedback system for adaptive agent orchestration.

## Overview

Provides real-time progress events for CLI and Web UI without affecting orchestrator logic.

**Key Features:**
- ✅ **UX-only** - Events invisible to orchestrator
- ✅ **Real-time** - Immediate user feedback
- ✅ **Visual** - Tier color coding (🟢🟡🔴)
- ✅ **Cost-aware** - Displays cost breakdown
- ✅ **Streamable** - WebSocket/SSE support

## Installation

```bash
pnpm add @kb-labs/progress-reporter
```

## Quick Start

### CLI Usage

```typescript
import { ProgressReporter } from '@kb-labs/progress-reporter';
import { useLogger } from '@kb-labs/sdk';

const logger = useLogger();
const reporter = new ProgressReporter(logger);

// Start tracking
reporter.start('Implement user authentication');

// Classification
reporter.classified('medium', 'high', 'heuristic');

// Planning
reporter.planning('started');
reporter.planning('completed', { subtaskCount: 3 });

// Subtask execution
reporter.subtask(1, 'Create auth service', 'medium', 'started');
reporter.subtask(1, 'Create auth service', 'medium', 'progress', { progress: 50 });
reporter.subtask(1, 'Create auth service', 'medium', 'completed');

// Escalation (if needed)
reporter.escalated(2, 'small', 'medium', 'Task too complex for small model');

// Completion
reporter.complete('success', {
  total: '$0.05',
  small: '$0.00',
  medium: '$0.05',
  large: '$0.00'
});
```

**Console Output:**
```
🎯 Task started: Implement user authentication
🟡 Classified as 'medium' tier (high confidence, heuristic)
📋 Planning subtasks...
📋 Plan ready: 3 subtasks
🟡 [1] Starting: Create auth service
🟡 [1] Progress: 50%
✅ [1] Completed: Create auth service
⚠️  [2] Escalating small → medium: Task too complex for small model
✅ Task success in 45.2s
💰 Cost: $0.05
   🟢 Small:  $0.00 | 🟡 Medium: $0.05 | 🔴 Large:  $0.00
```

### Web UI Usage (with WebSocket)

```typescript
import { ProgressReporter } from '@kb-labs/progress-reporter';
import { useLogger } from '@kb-labs/sdk';

const logger = useLogger();

// Create reporter with callback for streaming
const reporter = new ProgressReporter(logger, (event) => {
  // Stream to frontend via WebSocket
  ws.send(JSON.stringify(event));
});

// All events will be streamed to frontend in real-time
reporter.start('Build new feature');
// → ws.send({ type: 'task_started', timestamp: ..., data: {...} })
```

**Frontend Example (React):**
```typescript
function TaskProgress() {
  const [events, setEvents] = useState<ProgressEvent[]>([]);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3000');

    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      setEvents(prev => [...prev, event]);
    };

    return () => ws.close();
  }, []);

  return (
    <div>
      {events.map((event, i) => (
        <EventCard key={i} event={event} />
      ))}
    </div>
  );
}
```

## Event Types

### Task Lifecycle

**task_started**
```typescript
{
  type: 'task_started',
  timestamp: 1234567890,
  data: { taskDescription: 'Implement feature X' }
}
```

**task_classified**
```typescript
{
  type: 'task_classified',
  timestamp: 1234567891,
  data: {
    tier: 'medium',
    confidence: 'high',
    method: 'heuristic'
  }
}
```

**task_completed**
```typescript
{
  type: 'task_completed',
  timestamp: 1234567999,
  data: {
    status: 'success',
    totalDuration: 45200,
    costBreakdown: {
      total: '$0.05',
      small: '$0.00',
      medium: '$0.05',
      large: '$0.00'
    }
  }
}
```

### Planning Phase

**planning_started**
```typescript
{
  type: 'planning_started',
  timestamp: 1234567892,
  data: {}
}
```

**planning_completed**
```typescript
{
  type: 'planning_completed',
  timestamp: 1234567895,
  data: { subtaskCount: 3 }
}
```

### Subtask Execution

**subtask_started**
```typescript
{
  type: 'subtask_started',
  timestamp: 1234567900,
  data: {
    subtaskId: 1,
    description: 'Create auth service',
    tier: 'medium'
  }
}
```

**subtask_progress**
```typescript
{
  type: 'subtask_progress',
  timestamp: 1234567920,
  data: {
    subtaskId: 1,
    description: 'Create auth service',
    tier: 'medium',
    progress: 50
  }
}
```

**subtask_completed**
```typescript
{
  type: 'subtask_completed',
  timestamp: 1234567940,
  data: {
    subtaskId: 1,
    description: 'Create auth service',
    tier: 'medium'
  }
}
```

**subtask_failed**
```typescript
{
  type: 'subtask_failed',
  timestamp: 1234567950,
  data: {
    subtaskId: 2,
    description: 'Setup database',
    tier: 'small',
    error: 'Connection timeout'
  }
}
```

### Tier Escalation

**tier_escalated**
```typescript
{
  type: 'tier_escalated',
  timestamp: 1234567960,
  data: {
    subtaskId: 2,
    fromTier: 'small',
    toTier: 'medium',
    reason: 'Task too complex for small model'
  }
}
```

## API Reference

### `ProgressReporter`

```typescript
class ProgressReporter {
  constructor(logger: ILogger, onProgress?: ProgressCallback);

  start(taskDescription: string): void;
  classified(tier: LLMTier, confidence: 'high' | 'low', method: 'heuristic' | 'llm'): void;
  planning(phase: 'started' | 'completed', data?: { subtaskCount?: number }): void;
  subtask(id: number, desc: string, tier: LLMTier, phase: 'started' | 'progress' | 'completed' | 'failed', extra?: { progress?: number; error?: string }): void;
  escalated(id: number, from: LLMTier, to: LLMTier, reason: string): void;
  complete(status: 'success' | 'failed', costBreakdown: CostBreakdown): void;

  getEvents(): readonly ProgressEvent[];
  clear(): void;
}
```

### Types

```typescript
type ProgressEventType =
  | 'task_started'
  | 'task_classified'
  | 'planning_started'
  | 'planning_completed'
  | 'subtask_started'
  | 'subtask_progress'
  | 'subtask_completed'
  | 'subtask_failed'
  | 'tier_escalated'
  | 'task_completed';

type ProgressCallback = (event: ProgressEvent) => void;
```

## Tier Color Coding

Visual indicators for quick status understanding:

- 🟢 **Small** (green) - Fast, cheap model
- 🟡 **Medium** (yellow) - Balanced model
- 🔴 **Large** (red) - High-quality, expensive model

## Best Practices

### 1. Always Use Logger

```typescript
// ✅ Good - combines logging with events
const reporter = new ProgressReporter(logger);

// ❌ Bad - events without logs
const reporter = new ProgressReporter(null as any);
```

### 2. Stream to Frontend

```typescript
// ✅ Good - real-time updates
const reporter = new ProgressReporter(logger, (event) => {
  ws.send(JSON.stringify(event));
});

// ⚠️  OK - CLI only (no streaming)
const reporter = new ProgressReporter(logger);
```

### 3. Clear Between Tasks

```typescript
// Execute task 1
reporter.start('Task 1');
// ... work ...
reporter.complete('success', costs);

// Clear before task 2
reporter.clear();
reporter.start('Task 2');
```

## Integration with Orchestrator

```typescript
import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
import { ProgressReporter } from '@kb-labs/progress-reporter';
import { useLogger } from '@kb-labs/sdk';

const logger = useLogger();
const reporter = new ProgressReporter(logger, (event) => {
  // Stream to Web UI
  eventBus.emit('progress', event);
});

const orchestrator = new AdaptiveOrchestrator({
  logger,
  onProgress: reporter // Pass reporter to orchestrator
});

await orchestrator.execute('Implement feature X');
```

## Testing

```typescript
import { ProgressReporter } from '@kb-labs/progress-reporter';
import { describe, it, expect } from 'vitest';

describe('ProgressReporter', () => {
  it('should emit task_started event', () => {
    const events: ProgressEvent[] = [];
    const reporter = new ProgressReporter(logger, (e) => events.push(e));

    reporter.start('Test task');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task_started');
    expect(events[0].data.taskDescription).toBe('Test task');
  });
});
```

## License

MIT
