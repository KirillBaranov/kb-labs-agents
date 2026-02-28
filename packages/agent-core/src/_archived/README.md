# Legacy — Agent v1/v2 Implementation

This directory contains the original `Agent` class and associated subsystems
from the pre-SDK architecture. Code is preserved for reference but **not
imported by the active codebase**.

## Contents

| Entry point | Description |
|---|---|
| `agent.ts` | Original monolithic Agent (~3900 lines) |
| `agent-runner.ts` | Agent v2 intermediate orchestrator |
| `budget/` | Iteration/token budget computation |
| `context/` | ContextFilter + SmartSummarizer |
| `progress/` | ProgressTracker |
| `reflection/` | ReflectionEngine |
| `search-signal/` | SearchSignalTracker |
| `task-classifier/` | TaskClassifier (intent + scope) |
| `task-completion/` | TaskCompletionEvaluator |
| `todo-sync/` | TodoSyncCoordinator |
| `tool-input/` | ToolInputNormalizer |
| `verification/` | CrossTierVerifier, ToolResultsSummarizer |

## Status

Active implementation: `packages/agent-core/src/core/runner.ts` (SDKAgentRunner)
