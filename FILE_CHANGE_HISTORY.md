# File Change History & Rollback

Track and rollback file changes made by agents with Cursor-like UX.

---

## 🚀 Quick Start

```bash
# View all agent sessions
pnpm kb agent history

# Show changes in specific session
pnpm kb agent history --session-id=session-123

# View diff for a change
pnpm kb agent diff --change-id=change-abc

# Rollback a file (with preview)
pnpm kb agent rollback --file=src/index.ts --dry-run
pnpm kb agent rollback --file=src/index.ts
```

---

## 📚 Commands

### `agent:history` - View Change History

List all file changes made by agents.

```bash
# List all sessions
pnpm kb agent history

# Filter by session
pnpm kb agent history --session-id=session-123

# Filter by file
pnpm kb agent history --file=src/index.ts

# Filter by agent
pnpm kb agent history --agent-id=agent-abc

# JSON output for agents
pnpm kb agent history --json
```

**Output:**
- Session list with change counts
- File-specific change timeline
- Agent-specific change history

---

### `agent:diff` - Show Line Diff

Display line-by-line diff for specific change.

```bash
# Show diff
pnpm kb agent diff --change-id=change-abc123

# JSON output
pnpm kb agent diff --change-id=change-abc123 --json
```

**Output:**
- Line-by-line additions (+), deletions (-), modifications
- Change metadata (agent, timestamp, operation)
- Summary statistics

---

### `agent:rollback` - Rollback Changes

Rollback file changes with multiple targeting options.

```bash
# Rollback specific change
pnpm kb agent rollback --change-id=change-abc

# Rollback all changes to a file
pnpm kb agent rollback --file=src/index.ts

# Rollback all changes by an agent
pnpm kb agent rollback --agent-id=agent-abc

# Rollback entire session
pnpm kb agent rollback --session-id=session-123

# Rollback all changes after timestamp
pnpm kb agent rollback --after="2026-02-16T10:00:00Z"

# Dry run (preview without applying)
pnpm kb agent rollback --file=src/index.ts --dry-run
```

**Features:**
- ✅ 5 targeting modes (change/file/agent/session/time)
- ✅ Dry-run mode for safety
- ✅ Smart restore to earliest state
- ✅ Deletes files created during session

---

## 📁 Storage

Snapshots stored in:
```
.kb/agents/sessions/{sessionId}/snapshots/{changeId}.json
```

**Snapshot structure:**
```json
{
  "id": "change-abc123",
  "sessionId": "session-123",
  "agentId": "agent-main",
  "filePath": "src/index.ts",
  "operation": "write",
  "timestamp": "2026-02-17T10:30:00Z",
  "before": {
    "content": "...",
    "hash": "sha256...",
    "size": 1234
  },
  "after": {
    "content": "...",
    "hash": "sha256...",
    "size": 2345
  },
  "metadata": {
    "isOverwrite": true
  }
}
```

---

## 🎯 Common Workflows

### Undo Specific Change
```bash
# 1. View session history
pnpm kb agent history --session-id=session-123

# 2. Check diff
pnpm kb agent diff --change-id=change-abc

# 3. Rollback
pnpm kb agent rollback --change-id=change-abc
```

### Undo All Changes to File
```bash
# 1. Check file history
pnpm kb agent history --file=src/auth.ts

# 2. Preview rollback
pnpm kb agent rollback --file=src/auth.ts --dry-run

# 3. Apply
pnpm kb agent rollback --file=src/auth.ts
```

### Undo Agent's Work
```bash
# 1. See what agent changed
pnpm kb agent history --agent-id=agent-refactor

# 2. Rollback all (preview first)
pnpm kb agent rollback --agent-id=agent-refactor --dry-run
pnpm kb agent rollback --agent-id=agent-refactor
```

### Time-Based Rollback
```bash
# Undo everything after 10 AM
pnpm kb agent rollback --after="2026-02-17T10:00:00Z" --dry-run
pnpm kb agent rollback --after="2026-02-17T10:00:00Z"
```

---

## 🔧 Configuration

File history is configured in `.kb/kb.config.json`:

```json
{
  "profiles": [
    {
      "products": {
        "agents": {
          "fileHistory": {
            "enabled": true,
            "storage": {
              "basePath": ".kb/agents/sessions",
              "maxSessions": 30,
              "maxAgeDays": 30,
              "maxTotalSizeMb": 500,
              "compressOldSnapshots": true
            }
          }
        }
      }
    }
  ]
}
```

**Options:**
- `enabled` - Enable/disable file tracking
- `maxSessions` - Keep last N sessions
- `maxAgeDays` - Delete sessions older than N days
- `maxTotalSizeMb` - Limit total storage size
- `compressOldSnapshots` - Compress old snapshots (future)

---

## 🤖 Agent Integration

File tracking is automatic when using agents:

```typescript
import { Agent } from '@kb-labs/agent-core';

const agent = new Agent({
  sessionId: 'my-session', // Optional: correlate changes
  trackFileChanges: true,  // Enabled by default
});

// All fs_write and fs_patch operations are tracked
await agent.run('Refactor authentication');

// Access change history
const changes = agent.getFileHistory();
const changedFiles = agent.getChangedFiles();

// Rollback programmatically
await agent.rollbackFile('src/auth.ts');
await agent.rollbackAllChanges();
```

---

## 📊 JSON Output

All commands support `--json` flag for programmatic access:

```bash
pnpm kb agent history --json
```

**Response format:**
```json
{
  "success": true,
  "sessions": 5,
  "data": [
    {
      "sessionId": "session-123",
      "changes": 10,
      "agents": ["agent-main"],
      "filesChanged": ["src/index.ts", "src/utils.ts"],
      "startedAt": "2026-02-17T10:00:00Z",
      "lastChangeAt": "2026-02-17T10:30:00Z"
    }
  ]
}
```

---

## ⚠️ Important Notes

### Rollback Strategy
- **Restores to earliest state** (before first change)
- **Deletes files** created during session
- **No partial rollback** (all or nothing per file)

### Limitations
- Tracks only `fs_write` and `fs_patch` operations
- No tracking for external file modifications
- No merge conflict resolution (yet)

### Storage
- Snapshots stored as full content (not diffs)
- Old sessions cleaned up automatically
- Manual cleanup: `rm -rf .kb/agents/sessions/`

---

## 🔗 Related Documentation

- [Implementation Plan](../docs/plans/2026-02-16-file-change-history-ux.md)
- [Phase 3 Summary](../docs/plans/file-change-history-phase-3-summary.md)
- [Orchestrator Conflict Resolution](../docs/plans/orchestrator-conflict-integration.md)
- [Agent System Docs](../docs/AGENT_SYSTEM.md)

---

## 🎉 Features

- ✅ Track all file changes automatically
- ✅ View change history with filtering
- ✅ Line-by-line diff viewer
- ✅ Rollback with 5 targeting modes
- ✅ Dry-run mode for safety
- ✅ JSON output for automation
- ✅ Session-based grouping
- ✅ Configurable retention policy

**Ready to use!** 🚀
