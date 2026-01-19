# Verification System - Anti-Hallucination for Specialist Outputs

**ADR-0002: Specialist Output Verification System**

## Overview

3-level validation system that prevents hallucinated outputs from specialists:

### Level 1: Structure Validation (Zod)

Validates that specialist output matches the `SpecialistOutput` schema:

```typescript
{
  summary: string;           // Required: What was done
  traceRef: string;          // Required: "trace:<id>" for audit trail
  claims?: Claim[];          // Optional: Filesystem operation claims
  artifacts?: Artifact[];    // Optional: Large outputs (< 1KB metadata)
}
```

**Catches:**
- Missing required fields (`summary`, `traceRef`)
- Invalid types (e.g., `summary` is not a string)
- Malformed `traceRef` (must start with "trace:")

### Level 2: Plugin Tool Output Validation

Validates outputs from plugin tools (e.g., `mind:rag-query`) against their declared schemas.

**How it works:**
1. Plugin manifest declares output schema: `"@kb-labs/mind-contracts/schema#QueryResult"`
2. `PluginSchemaLoader` dynamically loads Zod schema from package
3. `ZodSchemaValidator` validates tool output before returning to specialist

**Status:** Opt-in validation (requires schema registration)

### Level 3: Filesystem State Validation

Verifies claims about filesystem operations by checking actual state:

**Claim types:**
- `file-write`: SHA-256 hash of written file content
- `file-edit`: Anchor-based verification (before/after code snippets)
- `file-delete`: File no longer exists
- `code-inserted`: Similar to file-edit (anchor matching)
- `command-executed`: Trusted (no retroactive verification)

**Why anchor-based for edits?**
- Stable across multiple edits (doesn't change if file edited again)
- Allows verification even if file modified after claim
- More flexible than full content hash

## Usage

### Basic Verification

```typescript
import { TaskVerifier } from '@kb-labs/agent-core';

const verifier = new TaskVerifier(ctx);

const result = await verifier.verify(
  specialistOutput,
  toolTrace,         // Optional: for Level 2
  basePath,          // For filesystem verification
  'implementer',     // Specialist ID (for metrics)
  'subtask-1'        // Subtask ID (for metrics)
);

if (!result.valid) {
  console.error(`Verification failed at Level ${result.level}:`, result.errors);
}
```

### Metrics Collection

Metrics are collected automatically during verification:

```typescript
// Get aggregated metrics
const metrics = verifier.getMetrics();

console.log('Pass rate:', metrics.passRate);
console.log('Level 1 stats:', metrics.byLevel[1]);
console.log('Errors by category:', metrics.errorsByCategory);

// Clear metrics buffer
verifier.clearMetrics();
```

### Metrics Structure

```typescript
{
  totalChecks: 100,
  passRate: 0.85,

  byLevel: {
    1: { total: 100, passed: 95, failed: 5, avgDurationMs: 12 },
    2: { total: 0, passed: 0, failed: 0, avgDurationMs: 0 },
    3: { total: 80, passed: 75, failed: 5, avgDurationMs: 45 }
  },

  bySpecialist: {
    'implementer': { total: 50, passed: 45, failed: 5 },
    'tester': { total: 30, passed: 30, failed: 0 },
    'researcher': { total: 20, passed: 20, failed: 0 }
  },

  errorsByCategory: {
    'missing_field': 3,
    'hash_mismatch': 2,
    'filesystem_mismatch': 0,
    // ...
  }
}
```

## Error Categories

Metrics categorize validation errors for analysis:

| Category | Description | Example |
|----------|-------------|---------|
| `missing_field` | Required field missing | No `traceRef` in output |
| `invalid_type` | Field has wrong type | `summary` is number instead of string |
| `schema_mismatch` | Plugin output doesn't match schema | QueryResult missing `documents` field |
| `hash_mismatch` | File content hash doesn't match claim | File was modified after write |
| `anchor_mismatch` | Code anchor not found in file | Edit claim references wrong line |
| `file_not_found` | File doesn't exist when it should | Write claim but file missing |
| `filesystem_mismatch` | General filesystem validation error | Generic file system issue |
| `unknown` | Uncategorized error | Other validation failures |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TaskVerifier                         │
│  (Orchestrates all 3 levels)                           │
└─────────────────────────────────────────────────────────┘
            │
            ├─ Level 1 ──> SpecialistOutputSchema (Zod)
            │
            ├─ Level 2 ──> ZodSchemaValidator
            │                  │
            │                  └─> PluginSchemaLoader
            │                       (dynamic schema resolution)
            │
            └─ Level 3 ──> BuiltInToolVerifier
                              (filesystem state checks)
```

## Integration with Orchestrator

Automatic verification happens after each specialist execution:

```typescript
// In OrchestratorExecutor.executeWithEscalation()

const outcome = await specialist.execute(/* ... */);

if (outcome.ok) {
  // Verify output before accepting
  const verification = await this.taskVerifier.verify(
    outcome.result.output,
    outcome.result.toolTrace,
    workingDir,
    specialist.id,
    subtask.id
  );

  if (!verification.valid) {
    // Trigger retry with exponential backoff
    // ...
  }
}
```

## Benefits

1. **Prevents hallucinations** - Catches when specialist claims to do something it didn't
2. **Early error detection** - Fails fast instead of propagating bad outputs
3. **A/B testing** - Metrics enable comparing verification strategies
4. **Audit trail** - `traceRef` links output to tool execution trace
5. **Minimal overhead** - Level 1 validation ~10-20ms, Level 3 ~30-50ms

## Future Work

- **Level 2 activation**: Register schemas for plugin tools (mind:rag-query, etc.)
- **Claim auto-generation**: Teach specialists to generate claims automatically
- **Remote verification**: Support distributed verification for multi-node setups
- **Claim compression**: Reduce claim payload size for large file operations

## See Also

- [ADR-0002: Specialist Output Verification System](../../../docs/adr/0002-specialist-output-verification.md)
- [ToolTrace System](../trace/README.md)
- [Verification Metrics](./verification-metrics.ts)
