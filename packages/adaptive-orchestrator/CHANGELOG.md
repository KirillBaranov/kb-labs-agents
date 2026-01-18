# Changelog

## [Unreleased]

### Added

- **Full AgentExecutor integration** - Replaced simplified `llm.complete()` with real `AgentExecutor`
  - Agents can now execute tools (fs:read, fs:write, mind:rag-query, etc.)
  - Tool calls are tracked in execution history
  - Proper agent context loading via `AgentRegistry`
  - Tool discovery via `ToolDiscoverer`

- **Execution history tracking** - Complete session replay capability
  - Full execution traces with LLM interactions and tool calls
  - File-based storage in `.kb/agents/history/{session_id}/`
  - Session metadata index for quick lookup
  - Future-ready for diff analysis between runs

- **History types and storage**
  - `OrchestrationHistory` - Complete session data
  - `SubtaskTrace` - Per-subtask execution details
  - `ToolCallRecord` - Tool invocation tracking
  - `LLMInteraction` - LLM call tracking
  - `FileHistoryStorage` - Persistent storage implementation
  - `IHistoryStorage` - Interface for custom storage backends

### Changed

- **Constructor signature** - Now requires `PluginContextV3` to enable agent execution
  ```typescript
  // Before
  new AdaptiveOrchestrator(logger)

  // After
  new AdaptiveOrchestrator(ctx, logger)
  ```

- **Agent execution** - Uses real `AgentExecutor` instead of simplified LLM completion
  - Agents can perform actions (write files, run commands, search code)
  - No more hallucinated results - tools are actually executed
  - Full ReAct loop with loop detection and error recovery

### Documentation

- Updated README with `PluginContextV3` usage examples
- Added execution history documentation
- Added tool execution details
- Updated comparison table

## [0.1.0] - Initial Release

- Task classification with HybridComplexityClassifier
- Execution planning with tier assignment
- Adaptive execution with cost optimization
- Automatic escalation on failure
- Real-time progress reporting
- Analytics tracking
