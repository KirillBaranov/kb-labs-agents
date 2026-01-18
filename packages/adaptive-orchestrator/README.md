# @kb-labs/adaptive-orchestrator

Adaptive agent orchestrator with tier-based model selection and cost optimization.

## Overview

Intelligently orchestrates complex tasks by:
- **Automatic complexity classification** - Determines optimal model tier
- **Multi-step planning** - Breaks tasks into subtasks
- **Adaptive execution** - Uses appropriate tier for each subtask
- **Automatic escalation** - Retries with stronger models on failure
- **Cost optimization** - 70-80% cost savings vs naive approach
- **Real-time progress** - UX feedback for CLI and Web UI

## Installation

```bash
pnpm add @kb-labs/adaptive-orchestrator
```

## Quick Start

```typescript
import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
import type { PluginContextV3 } from '@kb-labs/sdk';

// Inside your plugin handler
export async function handler(ctx: PluginContextV3) {
  const logger = ctx.platform.logger;
  const orchestrator = new AdaptiveOrchestrator(ctx, logger);

  // Execute task with full agent support
  const result = await orchestrator.execute('Implement user authentication with JWT');

  console.log(result.result);
  // → "Authentication system implemented with JWT tokens, including..."

  console.log(result.costBreakdown);
  // → { total: '$0.0331', small: '$0.0050', medium: '$0.0281', large: '$0.0000' }

  console.log(result.status);
  // → 'success'

  return result;
}
```

## How It Works

### 1. Task Classification

Automatically determines task complexity:

```typescript
const result = await orchestrator.execute('Find all TODO comments');
// → Classified as 'small' (simple task)

const result = await orchestrator.execute('Implement user login');
// → Classified as 'medium' (standard development)

const result = await orchestrator.execute('Design scalable architecture');
// → Classified as 'large' (complex, architectural)
```

### 2. Planning Phase

Breaks task into subtasks with appropriate tiers:

```typescript
// Task: "Implement user authentication"
// Plan:
// 1. Research auth methods → small
// 2. Implement JWT service → medium
// 3. Write integration tests → small
```

### 3. Adaptive Execution

Each subtask uses its assigned tier:

```typescript
// Subtask 1: small model (gpt-4o-mini) → $0.0010
// Subtask 2: medium model (gpt-4o) → $0.0250
// Subtask 3: small model (gpt-4o-mini) → $0.0010
// Total: $0.0270
```

### 4. Automatic Escalation

Retries with stronger models on failure:

```typescript
// Subtask 2 fails with 'medium' → escalate to 'large'
// ⚠️  [2] Escalating medium → large: Task too complex
// ✅ [2] Completed with 'large' model
```

### 5. Cost Optimization

Saves 70-80% vs using large model for everything:

```typescript
// Naive approach (all large): $1.00
// Adaptive approach: $0.27
// Savings: 73%
```

## Progress Feedback

### CLI Output

```
🎯 Task started: Implement user authentication
🟡 Classified as 'medium' tier (high confidence, heuristic)
📋 Planning subtasks...
📋 Plan ready: 3 subtasks
🟢 [1] Starting: Research auth methods
✅ [1] Completed: Research auth methods
🟡 [2] Starting: Implement JWT service
✅ [2] Completed: Implement JWT service
🟢 [3] Starting: Write integration tests
✅ [3] Completed: Write integration tests
✅ Task success in 45.2s
💰 Cost: $0.0331
   🟢 Small:  $0.0050 | 🟡 Medium: $0.0281 | 🔴 Large:  $0.0000
```

### Web UI Integration

```typescript
import { AdaptiveOrchestrator } from '@kb-labs/adaptive-orchestrator';
import { useLogger } from '@kb-labs/sdk';

const logger = useLogger();

// Stream progress to frontend
const orchestrator = new AdaptiveOrchestrator(
  logger,
  (event) => {
    // Send to frontend via WebSocket
    ws.send(JSON.stringify(event));
  }
);

await orchestrator.execute(task);
```

**Frontend (React):**
```tsx
function TaskProgress() {
  const [events, setEvents] = useState([]);

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
        <ProgressEvent key={i} event={event} />
      ))}
    </div>
  );
}
```

## Configuration

```typescript
const orchestrator = new AdaptiveOrchestrator(
  logger,
  onProgress,
  {
    // Max escalation attempts per subtask (default: 2)
    maxEscalations: 2,

    // Enable cost tracking (default: true)
    trackCost: true,

    // Model pricing (tokens per dollar)
    pricing: {
      small: 1_000_000,   // $1 per 1M tokens
      medium: 500_000,    // $1 per 500K tokens
      large: 100_000,     // $1 per 100K tokens
    }
  }
);
```

## API Reference

### `AdaptiveOrchestrator`

```typescript
class AdaptiveOrchestrator {
  constructor(
    logger: ILogger,
    onProgress?: ProgressCallback,
    config?: OrchestratorConfig
  );

  execute(task: string): Promise<OrchestratorResult>;
}
```

### `OrchestratorResult`

```typescript
interface OrchestratorResult {
  status: 'success' | 'failed';
  result: string;
  costBreakdown: {
    total: string;
    small: string;
    medium: string;
    large: string;
  };
  subtaskResults?: SubtaskResult[];
}
```

### `OrchestratorConfig`

```typescript
interface OrchestratorConfig {
  maxEscalations?: number;    // Default: 2
  trackCost?: boolean;        // Default: true
  pricing?: {
    small: number;
    medium: number;
    large: number;
  };
}
```

## Cost Analysis

### Example: "Реализуй мне фичу 1"

**Naive Approach (all large):**
```
Planning:     5000 tokens × large = $0.500
Subtask 1:    2000 tokens × large = $0.200
Subtask 2:    1000 tokens × large = $0.100
Subtask 3:    2000 tokens × large = $0.200
Total: $1.000
```

**Adaptive Approach:**
```
Planning:     5000 tokens × medium = $0.100 (classified)
Subtask 1:    2000 tokens × small  = $0.020 (simple)
Subtask 2:    1000 tokens × medium = $0.020 (standard)
Subtask 3:    2000 tokens × small  = $0.020 (simple)
Subtask 4:   10000 tokens × large  = $1.000 (escalated from medium)
Synthesis:    5000 tokens × medium = $0.100
Total: $0.331
```

**Savings: 67% ($0.669 saved)**

## Real-World Examples

### Example 1: Simple Task

```typescript
const result = await orchestrator.execute('Find all console.log statements');

// Classification: small (simple search)
// Subtasks: 1
// Cost: $0.002
// Time: 3s
```

### Example 2: Standard Development

```typescript
const result = await orchestrator.execute('Add user profile page');

// Classification: medium
// Subtasks: 5
//   - Design component structure (small)
//   - Implement profile component (medium)
//   - Add API integration (medium)
//   - Style with CSS (small)
//   - Write tests (small)
// Cost: $0.045
// Time: 60s
```

### Example 3: Complex Architecture

```typescript
const result = await orchestrator.execute(
  'Design a scalable multi-tenant system with RBAC'
);

// Classification: large
// Subtasks: 8
//   - Research multi-tenancy patterns (medium)
//   - Design tenant isolation (large)
//   - Design RBAC system (large)
//   - Plan database schema (medium)
//   - Design API structure (medium)
//   - Plan caching strategy (medium)
//   - Security considerations (large)
//   - Scalability plan (large)
// Cost: $0.850
// Time: 180s
```

## Best Practices

### 1. Use Descriptive Tasks

```typescript
// ✅ Good - clear intent
await orchestrator.execute('Implement JWT authentication with refresh tokens');

// ❌ Bad - ambiguous
await orchestrator.execute('Add auth');
```

### 2. Let Classifier Decide

```typescript
// ✅ Good - trust the classifier
const result = await orchestrator.execute(task);

// ❌ Bad - manual tier selection
// (orchestrator handles this automatically)
```

### 3. Monitor Costs

```typescript
const result = await orchestrator.execute(task);

if (result.status === 'success') {
  console.log(`✅ Completed for ${result.costBreakdown.total}`);

  // Alert if cost is high
  const cost = parseFloat(result.costBreakdown.total.slice(1));
  if (cost > 0.50) {
    console.warn(`⚠️  High cost: ${result.costBreakdown.total}`);
  }
}
```

### 4. Handle Failures

```typescript
try {
  const result = await orchestrator.execute(task);
  console.log(result.result);
} catch (error) {
  console.error('Orchestration failed:', error);
  // Implement fallback or retry logic
}
```

## Execution History

Every orchestration session is automatically saved to `.kb/agents/history/` for replay and analysis.

### Storage Structure

```
.kb/agents/history/
├── session_1234567890_abc123/
│   ├── session.json       # Full execution history
│   ├── plan.json          # Execution plan
│   └── result.json        # Final result
├── session_1234567891_def456/
│   └── ...
└── index.json             # Metadata index
```

### What's Tracked

```typescript
interface OrchestrationHistory {
  sessionId: string;
  task: string;
  classifiedTier: LLMTier;
  classificationConfidence: 'high' | 'low';
  plan: ExecutionPlan;
  agentsLoadedCount: number;
  availableAgents: string[];
  subtaskTraces: SubtaskTrace[];  // Full execution trace
  result: OrchestratorResult;
  durationMs: number;
  success: boolean;
}
```

Each `SubtaskTrace` includes:
- **LLM interactions** - All prompts and responses
- **Tool calls** - Every tool executed with input/output
- **Agent execution** - Which specialist agent was used
- **Token usage** - Tokens per step
- **Timing** - Duration of each operation

### Loading History

```typescript
import { FileHistoryStorage } from '@kb-labs/adaptive-orchestrator';

const storage = new FileHistoryStorage();

// List all sessions
const sessions = await storage.list();
console.log(sessions); // ['session_123...', 'session_456...']

// Load specific session
const history = await storage.load(sessions[0]);

// Analyze execution
console.log(`Task: ${history.task}`);
console.log(`Success: ${history.success}`);
console.log(`Total duration: ${history.durationMs}ms`);
console.log(`Subtasks: ${history.subtaskTraces.length}`);

// Inspect tool calls
for (const trace of history.subtaskTraces) {
  if (trace.toolCalls) {
    console.log(`\nSubtask ${trace.id}: ${trace.description}`);
    for (const call of trace.toolCalls) {
      console.log(`  Tool: ${call.name}`);
      console.log(`  Duration: ${call.durationMs}ms`);
    }
  }
}
```

### Future: Diff Analysis

History storage enables future diff analysis:

```bash
# Future feature (not yet implemented)
kb agent:compare session_123 session_456

# Shows:
# - Different execution paths
# - Tool call differences
# - Performance comparison
# - Token usage comparison
```

## Comparison with Manual Approach

| Aspect | Manual | Adaptive Orchestrator |
|--------|--------|----------------------|
| **Model Selection** | Developer decides | Automatic classification |
| **Cost** | High (often over-provision) | 70-80% lower |
| **Escalation** | Manual retry | Automatic escalation |
| **Progress** | No feedback | Real-time events |
| **Planning** | Manual breakdown | Automatic subtasks |
| **Optimization** | None | Tier-based routing |
| **History** | None | Full execution replay |
| **Tool Execution** | Manual integration | Automatic via AgentExecutor |

## License

MIT
