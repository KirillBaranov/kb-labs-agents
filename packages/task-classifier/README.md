# @kb-labs/task-classifier

Task complexity classifier for adaptive agent orchestration.

## Overview

Classifies user tasks into complexity tiers (`small`, `medium`, `large`) to enable intelligent model selection and cost optimization.

**Three classification strategies:**

- **Heuristic** - Fast, rule-based, free
- **LLM** - Accurate, LLM-based, ~$0.002/task
- **Hybrid** - Best-of-both (recommended) ⭐

## Installation

```bash
pnpm add @kb-labs/task-classifier
```

## Quick Start

```typescript
import { HybridComplexityClassifier } from '@kb-labs/task-classifier';
import { useLLM } from '@kb-labs/sdk';

// Create classifier (uses cheap model for classification)
const llm = useLLM({ tier: 'small' }); // gpt-4o-mini
const classifier = new HybridComplexityClassifier(llm);

// Classify task
const result = await classifier.classify({
  taskDescription: 'Implement user authentication with JWT tokens'
});

console.log(result.tier);        // 'medium'
console.log(result.confidence);  // 'high'
console.log(result.method);      // 'heuristic' or 'llm'
console.log(result.reasoning);   // 'Matched keywords...'
```

## Classification Strategies

### 1. Heuristic Classifier

Fast, rule-based classification using keywords and patterns.

```typescript
import { HeuristicComplexityClassifier } from '@kb-labs/task-classifier';

const classifier = new HeuristicComplexityClassifier();

const result = await classifier.classify({
  taskDescription: 'Find all TODO comments in the codebase'
});
// → { tier: 'small', confidence: 'high', method: 'heuristic' }
```

**Pros:**
- ⚡ Instant (no API calls)
- 💰 Free (no LLM cost)
- 🌍 Supports English + Russian keywords

**Cons:**
- ❌ Lower accuracy (~70%)
- ❌ Can't handle ambiguous tasks

### 2. LLM Classifier

Accurate classification using small LLM (gpt-4o-mini).

```typescript
import { LLMComplexityClassifier } from '@kb-labs/task-classifier';
import { useLLM } from '@kb-labs/sdk';

const llm = useLLM({ tier: 'small' });
const classifier = new LLMComplexityClassifier(llm);

const result = await classifier.classify({
  taskDescription: 'Design a scalable multi-tenant architecture'
});
// → { tier: 'large', confidence: 'high', method: 'llm' }
```

**Pros:**
- ✅ High accuracy (~95%)
- ✅ Handles ambiguous tasks
- ✅ Understands context

**Cons:**
- 💸 ~$0.002 per task
- ⏱️ ~500ms latency

### 3. Hybrid Classifier (Recommended ⭐)

Best-of-both-worlds: heuristic first, LLM fallback.

```typescript
import { HybridComplexityClassifier } from '@kb-labs/task-classifier';
import { useLLM } from '@kb-labs/sdk';

const llm = useLLM({ tier: 'small' });
const classifier = new HybridComplexityClassifier(llm);

// Simple task → heuristic (free, instant)
const result1 = await classifier.classify({
  taskDescription: 'List all files in src/ directory'
});
// → { tier: 'small', confidence: 'high', method: 'heuristic' }

// Ambiguous task → LLM (accurate, ~$0.002)
const result2 = await classifier.classify({
  taskDescription: 'Improve our authentication flow'
});
// → { tier: 'medium', confidence: 'high', method: 'llm' }
```

**Performance:**
- ~60% tasks use free heuristic
- ~40% tasks escalate to LLM
- Overall: ~90% accuracy at ~40% cost

## Tier Definitions

### SMALL (simple, fast)
- Information retrieval (find, search, list, show)
- Reading/checking existing code
- Simple queries
- **Examples:**
  - "Find all TODO comments"
  - "Show me the config file"
  - "List workflow commands"

### MEDIUM (standard development)
- Implementing features
- Adding/modifying code
- Fixing bugs
- Writing tests
- Standard refactoring
- **Examples:**
  - "Implement user login"
  - "Fix the authentication bug"
  - "Add tests for the API"

### LARGE (complex, architectural)
- System design and architecture
- Complex analysis and optimization
- Multi-step planning
- Migration/integration projects
- **Examples:**
  - "Design a multi-tenant architecture"
  - "Optimize database queries across the system"
  - "Migrate from REST to GraphQL"

## Keyword Support

### English Keywords
- **SMALL**: find, search, list, show, get, read, check, verify
- **MEDIUM**: implement, add, create, update, modify, fix, refactor, test
- **LARGE**: design, architect, plan, analyze, optimize, migrate, scale, integrate

### Russian Keywords
- **SMALL**: найди, покажи, список, прочитай, проверь
- **MEDIUM**: реализуй, добавь, создай, исправь, обнови
- **LARGE**: спроектируй, проанализируй, оптимизируй, интегрируй

## Usage in Orchestrator

```typescript
import { HybridComplexityClassifier } from '@kb-labs/task-classifier';
import { useLLM } from '@kb-labs/sdk';

export class AdaptiveOrchestrator {
  private classifier: HybridComplexityClassifier;

  constructor() {
    const llm = useLLM({ tier: 'small' }); // Cheap model for classification
    this.classifier = new HybridComplexityClassifier(llm);
  }

  async execute(task: string) {
    // 1. Classify task
    const { tier, method } = await this.classifier.classify({
      taskDescription: task
    });

    // 2. Use classified tier for planning
    const plannerLLM = useLLM({ tier }); // Use appropriate model
    const plan = await this.createPlan(plannerLLM, task);

    // 3. Execute with cost optimization...
  }
}
```

## API Reference

### `ITaskClassifier`

```typescript
interface ITaskClassifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>;
}
```

### `ClassifyInput`

```typescript
interface ClassifyInput {
  taskDescription: string;
}
```

### `ClassificationResult`

```typescript
interface ClassificationResult {
  tier: 'small' | 'medium' | 'large';
  confidence: 'high' | 'low';
  method: 'heuristic' | 'llm';
  reasoning?: string;
}
```

## Testing

```bash
# Run tests
pnpm test

# Run with coverage
pnpm test --coverage
```

## License

MIT
