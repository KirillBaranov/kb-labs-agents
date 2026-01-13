# V3 Plugin API Migration Guide

Complete guide for migrating plugins from V2 to V3 API.

## Table of Contents

- [Overview](#overview)
- [Breaking Changes](#breaking-changes)
- [Migration Checklist](#migration-checklist)
- [1. Manifest Structure Changes](#1-manifest-structure-changes)
- [2. Context Structure Changes](#2-context-structure-changes)
- [3. UI/Output API Migration](#3-uioutput-api-migration)
- [4. Enhanced UI with MessageOptions](#4-enhanced-ui-with-messageoptions)
- [5. Logger API Changes](#5-logger-api-changes)
- [6. State Management Migration](#6-state-management-migration)
- [7. Handler Signature Updates](#7-handler-signature-updates)
- [8. Error Handling](#8-error-handling)
- [9. Testing Changes](#9-testing-changes)
- [Common Patterns](#common-patterns)
- [Troubleshooting](#troubleshooting)

---

## Overview

V3 introduces a cleaner, more consistent API with better TypeScript support and enhanced UI capabilities.

**Key improvements:**
- ✅ Simplified manifest structure (`id` instead of `name`, inline permissions)
- ✅ Simplified context structure (`ctx.ui`, `ctx.logger`, `ctx.state` instead of `ctx.output.*`)
- ✅ Enhanced UI methods with side-bordered boxes
- ✅ Explicit permissions for sandboxing (fs, network, platform)
- ✅ Better separation of concerns (UI vs logging)
- ✅ Improved TypeScript types and IntelliSense
- ✅ Consistent API across all entry points (CLI, REST, Workflow)

---

## Breaking Changes

| V2 API | V3 API | Status |
|--------|--------|--------|
| `name: 'plugin:cmd'` | `id: 'plugin:cmd'` | ✅ Required |
| `async handler(ctx, argv, flags)` | `handler: { execute(ctx, input) }` | ✅ Required |
| Named export | `export default defineCommand()` | ✅ Required |
| No permissions | Explicit `permissions: {}` | ⚠️ Optional |
| `ctx.output.ui.success()` | `ctx.ui.success()` | ✅ Required |
| `ctx.output.logger.info()` | `ctx.logger.info()` | ✅ Required |
| `ctx.output.state` | `ctx.state` | ✅ Required |
| `ctx.output` | `ctx.ui` / `ctx.logger` | ⚠️ Deprecated |

---

## Migration Checklist

- [ ] **Manifest:**
  - [ ] Rename `name` → `id` in defineCommand
  - [ ] Use default export for commands
  - [ ] Update handler signature: `handler: { execute(ctx, input) {} }`
  - [ ] Define permissions if needed (fs, network, platform)
- [ ] **Context API:**
  - [ ] Update all `ctx.output.ui.*` → `ctx.ui.*`
  - [ ] Update all `ctx.output.logger.*` → `ctx.logger.*`
  - [ ] Update all `ctx.output.state` → `ctx.state`
  - [ ] Remove `ctx.output` references
- [ ] **Enhanced UI:**
  - [ ] Consider using `MessageOptions` for rich output
  - [ ] Replace custom boxes with `ctx.ui.success(msg, options)`
- [ ] **Testing:**
  - [ ] Update tests to use new context structure
  - [ ] Test in subprocess mode (`KB_PLUGIN_SANDBOX=true`)
- [ ] **Documentation:**
  - [ ] Update examples and README

---

## 1. Manifest Structure Changes

V3 simplifies the plugin manifest structure and changes how commands are declared.

### Command Declaration

**V2 (defineCommand):**
```typescript
import { defineCommand } from '@kb-labs/sdk';
import { getCommandId } from '@kb-labs/plugin-contracts';

export const run = defineCommand({
  name: getCommandId('plugin:command'),  // ❌ 'name' field
  description: 'My command',
  flags: { /* ... */ },

  async handler(ctx, argv, flags) {  // ❌ 3 parameters
    // ...
  }
});

// Named export
export async function runCommand(ctx, argv, flags) {
  return run(ctx, argv, flags);
}
```

**V3 (defineCommand):**
```typescript
import { defineCommand, type PluginContext } from '@kb-labs/plugin-contracts';

// Default export - REQUIRED
export default defineCommand({
  id: 'plugin:command',  // ✅ 'id' field (direct string)
  description: 'My command',

  handler: {  // ✅ Handler object
    async execute(ctx: PluginContext, input: unknown) {  // ✅ 2 parameters
      const flags = input.flags;  // Flags via input object
      // ...
      return { exitCode: 0 };
    }
  }
});
```

**Key changes:**
- ✅ `name` → `id` (direct string, no helper function)
- ✅ `async handler(ctx, argv, flags)` → `handler: { async execute(ctx, input) }`
- ✅ Named export → **Default export** (REQUIRED!)
- ✅ Input structure: `input = { argv: string[], flags: Record<string, unknown> }`

### Permissions Declaration

V3 introduces explicit permissions in the manifest for sandboxing.

**V2:** No explicit permissions (full access)

**V3:**
```typescript
export default defineCommand({
  id: 'plugin:command',
  description: 'My command',

  // Optional: declare permissions
  permissions: {
    fs: {
      read: ['./src', './config'],  // Read access
      write: ['./output'],          // Write access
    },
    network: {
      fetch: ['https://api.example.com/*'],  // Allowed URLs
    },
    platform: {
      llm: true,        // Access to LLM service
      cache: true,      // Access to cache
      vectorStore: true, // Access to vector store
    },
    state: {
      namespaces: ['myPlugin:*'],  // State namespaces
    },
  },

  handler: { /* ... */ }
});
```

**Permission enforcement:**
- If `permissions` not declared, plugin runs with **restricted default permissions**
- User can further restrict permissions via `.kb/kb.config.json`
- Effective permissions = `intersect(manifest.permissions, userConfig.permissions)`
- Runtime enforces permissions via shims (fs-shim, fetch-shim, etc.)

**Default permissions (if not specified):**
```typescript
{
  fs: {
    read: [process.cwd()],          // CWD readable
    write: ['.kb/output'],          // Only .kb/output writable
  },
  network: { fetch: [] },           // No network access
  platform: {
    llm: false,
    cache: false,
    vectorStore: false,
  },
  state: { namespaces: [] },        // No state access
}
```

### Manifest Location

**V2:**
```
packages/my-plugin/
├── src/
│   ├── cli/
│   │   └── commands/
│   │       └── my-command.ts       # defineCommand inside
│   └── plugin.manifest.json        # ❌ Separate JSON file
```

**V3:**
```
packages/my-plugin/
├── src/
│   ├── cli/
│   │   └── commands/
│   │       └── my-command.ts       # ✅ defineCommand = inline manifest
└── plugin.json                     # ❌ REMOVED (no longer needed)
```

**Key insight:** In V3, `defineCommand()` IS the manifest. No separate JSON file needed.

---

## 2. Context Structure Changes

### V2 (Old)
```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  // Nested structure - BAD
  ctx.output.ui.success('Done!');
  ctx.output.logger.info('Processing...');
  await ctx.output.state.set('key', 'value');
}
```

### V3 (New)
```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  // Flat structure - GOOD
  ctx.ui.success('Done!');
  ctx.logger.info('Processing...');
  await ctx.state.set('key', 'value');
}
```

**Why?**
- Eliminates redundant `output` wrapper
- Clearer separation: `ctx.ui` for user-facing output, `ctx.logger` for internal logging
- Better IntelliSense and autocomplete

---

## 3. UI/Output API Migration

### Success Messages

**V2:**
```typescript
ctx.output.ui.success('Operation completed');
```

**V3:**
```typescript
ctx.ui.success('Operation completed');
```

### Info Messages

**V2:**
```typescript
ctx.output.ui.info('Processing files...');
```

**V3:**
```typescript
ctx.ui.info('Processing files...');
```

### Warning Messages

**V2:**
```typescript
ctx.output.ui.warn('Configuration incomplete');
```

**V3:**
```typescript
ctx.ui.warn('Configuration incomplete');
```

### Error Messages

**V2:**
```typescript
ctx.output.ui.error(new Error('Build failed'));
```

**V3:**
```typescript
ctx.ui.error(new Error('Build failed'));
// or
ctx.ui.error('Build failed');
```

### Tables

**V2:**
```typescript
ctx.output.ui.table(
  [{ name: 'Alice', age: 30 }],
  [
    { key: 'name', label: 'Name' },
    { key: 'age', label: 'Age' },
  ]
);
```

**V3:**
```typescript
ctx.ui.table(
  [{ name: 'Alice', age: 30 }],
  [
    { key: 'name', label: 'Name' },
    { key: 'age', label: 'Age' },
  ]
);
```

### Spinners

**V2:**
```typescript
const spinner = ctx.output.ui.spinner('Loading...');
spinner.start();
// ... work ...
spinner.stop();
```

**V3:**
```typescript
const spinner = ctx.ui.spinner('Loading...');
spinner.start();
// ... work ...
spinner.stop();
```

### Prompts

**V2:**
```typescript
const result = await ctx.output.ui.prompt({
  type: 'confirm',
  message: 'Continue?',
});
```

**V3:**
```typescript
const result = await ctx.ui.prompt({
  type: 'confirm',
  message: 'Continue?',
});
```

---

## 4. Enhanced UI with MessageOptions

V3 introduces **optional enhanced formatting** with side-bordered boxes for all UI methods.

### MessageOptions Interface

```typescript
export interface MessageOptions {
  /** Optional title for the box (defaults to message type) */
  title?: string;
  /** Content sections to display in box */
  sections?: OutputSection[];
  /** Timing in milliseconds to display in footer */
  timing?: number;
}

export interface OutputSection {
  /** Section header (optional) */
  header?: string;
  /** List of items in this section */
  items: string[];
}
```

### Simple Usage (Backward Compatible)

```typescript
// Still works - simple string output
ctx.ui.success('Operation completed!');
// Output: ✓ Operation completed!
```

### Enhanced Usage with Side-Bordered Box

```typescript
ctx.ui.success('Operation completed!', {
  title: 'Build Success',
  sections: [
    {
      header: 'Summary',
      items: [
        'Files processed: 42',
        'Time taken: 2.3s',
      ],
    },
  ],
  timing: 2300, // ms
});
```

**Output:**
```
┌── Build Success
│
│ Summary
│  Files processed: 42
│  Time taken: 2.3s
│
└── OK Success / 2.3s
```

### Real-World Example: Deployment Command

```typescript
import type { PluginContext } from '@kb-labs/plugin-contracts';

export async function execute(ctx: PluginContext, input: unknown) {
  const startTime = Date.now();

  // ... deployment logic ...

  ctx.ui.success(`Deployed ${serviceName}`, {
    title: 'Deployment',
    sections: [
      {
        header: 'Details',
        items: [
          `Service: ${serviceName}`,
          `Environment: ${env}`,
          `Region: ${region}`,
        ],
      },
      {
        header: 'Resources',
        items: [
          `Functions: ${functions.length}`,
          `Endpoints: ${endpoints.length}`,
        ],
      },
    ],
    timing: Date.now() - startTime,
  });

  return { exitCode: 0 };
}
```

### Status Indicators

Box footer displays status with color coding:
- **Success**: Green "OK Success"
- **Info**: Blue "INFO"
- **Warning**: Yellow "WARN"
- **Error**: Red "ERROR"

Timing is automatically formatted:
- `1200ms` → "1.2s"
- `500ms` → "500ms"
- `3600000ms` → "1h 0m"

### When to Use Enhanced UI

**Use simple format for:**
- Quick status messages
- Simple confirmations
- Single-line output

**Use enhanced format (with MessageOptions) for:**
- Command completion summaries
- Multi-step operation results
- Detailed status reports
- Timing-sensitive operations

---

## 5. Logger API Changes

### Info Logging

**V2:**
```typescript
ctx.output.logger.info('Processing file', { filename: 'foo.txt' });
```

**V3:**
```typescript
ctx.logger.info('Processing file', { filename: 'foo.txt' });
```

### Debug Logging

**V2:**
```typescript
ctx.output.logger.debug('Cache hit', { key: 'foo' });
```

**V3:**
```typescript
ctx.logger.debug('Cache hit', { key: 'foo' });
```

### Error Logging

**V2:**
```typescript
ctx.output.logger.error('Failed to read file', { error });
```

**V3:**
```typescript
ctx.logger.error('Failed to read file', { error });
```

### Warn Logging

**V2:**
```typescript
ctx.output.logger.warn('Deprecated API', { api: 'oldMethod' });
```

**V3:**
```typescript
ctx.logger.warn('Deprecated API', { api: 'oldMethod' });
```

---

## 6. State Management Migration

### Get State

**V2:**
```typescript
const value = await ctx.output.state.get<string>('myKey');
```

**V3:**
```typescript
const value = await ctx.state.get<string>('myKey');
```

### Set State

**V2:**
```typescript
await ctx.output.state.set('myKey', 'myValue', 60000); // TTL 60s
```

**V3:**
```typescript
await ctx.state.set('myKey', 'myValue', 60000); // TTL 60s
```

### Delete State

**V2:**
```typescript
await ctx.output.state.delete('myKey');
```

**V3:**
```typescript
await ctx.state.delete('myKey');
```

### Check Existence

**V2:**
```typescript
const exists = await ctx.output.state.has('myKey');
```

**V3:**
```typescript
const exists = await ctx.state.has('myKey');
```

---

## 7. Handler Signature Updates

### Before (V2)

```typescript
import { PluginContext } from '@kb-labs/plugin-contracts';

export async function execute(ctx: PluginContext, input: unknown) {
  ctx.output.ui.info('Starting...');

  try {
    // ... logic ...
    ctx.output.ui.success('Done!');
    return { exitCode: 0 };
  } catch (error) {
    ctx.output.logger.error('Failed', { error });
    throw error;
  }
}
```

### After (V3)

```typescript
import { PluginContext } from '@kb-labs/plugin-contracts';

export async function execute(ctx: PluginContext, input: unknown) {
  ctx.ui.info('Starting...');

  try {
    // ... logic ...
    ctx.ui.success('Done!');
    return { exitCode: 0 };
  } catch (error) {
    ctx.logger.error('Failed', { error });
    throw error;
  }
}
```

---

## 8. Error Handling

### V2 Pattern

```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  try {
    // ... work ...
  } catch (error) {
    ctx.output.ui.error(error as Error);
    ctx.output.logger.error('Job failed', { error });
    throw error;
  }
}
```

### V3 Pattern (Simple)

```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  try {
    // ... work ...
  } catch (error) {
    ctx.ui.error(error as Error);
    ctx.logger.error('Job failed', { error });
    throw error;
  }
}
```

### V3 Pattern (Enhanced with MessageOptions)

```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  try {
    // ... work ...
  } catch (error) {
    ctx.ui.error(error as Error, {
      title: 'Execution Failed',
      sections: [
        {
          header: 'Error Details',
          items: [
            `Type: ${error.name}`,
            `Message: ${error.message}`,
          ],
        },
      ],
    });
    ctx.logger.error('Job failed', { error });
    throw error;
  }
}
```

---

## 9. Testing Changes

### Mock Context V2

```typescript
const mockContext = {
  output: {
    ui: {
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    state: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
} as unknown as PluginContext;
```

### Mock Context V3

```typescript
const mockContext = {
  ui: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
  state: {
    get: vi.fn(),
    set: vi.fn(),
  },
} as unknown as PluginContext;
```

### Test Assertions V2

```typescript
expect(mockContext.output.ui.success).toHaveBeenCalledWith('Done!');
```

### Test Assertions V3

```typescript
expect(mockContext.ui.success).toHaveBeenCalledWith('Done!');
// Or with MessageOptions
expect(mockContext.ui.success).toHaveBeenCalledWith('Done!', {
  title: 'Success',
  sections: expect.any(Array),
  timing: expect.any(Number),
});
```

---

## Common Patterns

### Pattern 0: Complete Command Migration

**V2 Command Structure:**
```typescript
// commands/deploy.ts
import { defineCommand } from '@kb-labs/sdk';
import { getCommandId } from '@kb-labs/plugin-contracts';

export const run = defineCommand({
  name: getCommandId('my-plugin:deploy'),
  description: 'Deploy application',
  flags: {
    env: { type: 'string', description: 'Environment' }
  },

  async handler(ctx, argv, flags) {
    ctx.output.ui.info('Deploying...');

    // ... deployment logic ...

    ctx.output.ui.success('Deployed!');
    return { exitCode: 0 };
  }
});

export async function runDeployCommand(ctx, argv, flags) {
  return run(ctx, argv, flags);
}
```

**V3 Command Structure:**
```typescript
// commands/deploy.ts
import { defineCommand, type PluginContext } from '@kb-labs/plugin-contracts';

interface DeployFlags {
  env?: string;
}

interface DeployInput {
  argv: string[];
  flags: DeployFlags;
}

export default defineCommand({
  id: 'my-plugin:deploy',
  description: 'Deploy application',

  // Optional: declare permissions
  permissions: {
    fs: {
      read: ['./config'],
      write: ['./output'],
    },
    network: {
      fetch: ['https://api.deployment.com/*'],
    },
    platform: {
      llm: false,
      cache: true,
    },
  },

  handler: {
    async execute(ctx: PluginContext, input: DeployInput) {
      const { flags } = input;

      ctx.ui.info('Deploying...');

      // ... deployment logic ...

      ctx.ui.success('Deployed!', {
        title: 'Deployment Complete',
        sections: [
          {
            header: 'Details',
            items: [
              `Environment: ${flags.env}`,
              `Status: Success`,
            ],
          },
        ],
      });

      return { exitCode: 0 };
    }
  }
});
```

**Key migration steps:**
1. ✅ `name` → `id` (no helper function)
2. ✅ Named export → default export
3. ✅ `async handler(ctx, argv, flags)` → `handler: { execute(ctx, input) }`
4. ✅ `ctx.output.*` → `ctx.ui` / `ctx.logger` / `ctx.state`
5. ✅ Add `permissions` object (optional)
6. ✅ Use `MessageOptions` for rich output (optional)

### Pattern 1: Command with Progress Tracking

**V2:**
```typescript
export async function execute(ctx: PluginContext, input: { files: string[] }) {
  ctx.output.ui.info(`Processing ${input.files.length} files...`);

  for (const file of input.files) {
    ctx.output.logger.debug('Processing file', { file });
    // ... process file ...
  }

  ctx.output.ui.success('All files processed');
  return { exitCode: 0 };
}
```

**V3 (Simple):**
```typescript
export async function execute(ctx: PluginContext, input: { files: string[] }) {
  ctx.ui.info(`Processing ${input.files.length} files...`);

  for (const file of input.files) {
    ctx.logger.debug('Processing file', { file });
    // ... process file ...
  }

  ctx.ui.success('All files processed');
  return { exitCode: 0 };
}
```

**V3 (Enhanced with MessageOptions):**
```typescript
export async function execute(ctx: PluginContext, input: { files: string[] }) {
  const startTime = Date.now();

  ctx.ui.info(`Processing ${input.files.length} files...`);

  let processed = 0;
  let failed = 0;

  for (const file of input.files) {
    ctx.logger.debug('Processing file', { file });
    try {
      // ... process file ...
      processed++;
    } catch (error) {
      failed++;
      ctx.logger.error('Failed to process file', { file, error });
    }
  }

  ctx.ui.success('File processing complete', {
    title: 'Processing Summary',
    sections: [
      {
        header: 'Results',
        items: [
          `Total: ${input.files.length}`,
          `Processed: ${processed}`,
          `Failed: ${failed}`,
        ],
      },
    ],
    timing: Date.now() - startTime,
  });

  return { exitCode: failed > 0 ? 1 : 0 };
}
```

### Pattern 2: Multi-Step Operation

**V2:**
```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  ctx.output.ui.info('Step 1: Validating...');
  // ... validate ...

  ctx.output.ui.info('Step 2: Processing...');
  // ... process ...

  ctx.output.ui.info('Step 3: Saving...');
  // ... save ...

  ctx.output.ui.success('Operation complete');
  return { exitCode: 0 };
}
```

**V3 (Enhanced):**
```typescript
export async function execute(ctx: PluginContext, input: unknown) {
  const startTime = Date.now();
  const steps: string[] = [];

  ctx.ui.info('Step 1: Validating...');
  // ... validate ...
  steps.push('✓ Validation complete');

  ctx.ui.info('Step 2: Processing...');
  // ... process ...
  steps.push('✓ Processing complete');

  ctx.ui.info('Step 3: Saving...');
  // ... save ...
  steps.push('✓ Save complete');

  ctx.ui.success('Operation complete', {
    title: 'Multi-Step Operation',
    sections: [
      {
        header: 'Steps Completed',
        items: steps,
      },
    ],
    timing: Date.now() - startTime,
  });

  return { exitCode: 0 };
}
```

### Pattern 3: Caching with State

**V2:**
```typescript
export async function execute(ctx: PluginContext, input: { key: string }) {
  const cached = await ctx.output.state.get<string>(input.key);

  if (cached) {
    ctx.output.logger.info('Cache hit', { key: input.key });
    ctx.output.ui.success(`Retrieved from cache: ${cached}`);
    return { exitCode: 0, result: cached };
  }

  ctx.output.logger.info('Cache miss', { key: input.key });
  const value = await fetchData(input.key);

  await ctx.output.state.set(input.key, value, 60000); // TTL 60s
  ctx.output.ui.success(`Fetched and cached: ${value}`);

  return { exitCode: 0, result: value };
}
```

**V3:**
```typescript
export async function execute(ctx: PluginContext, input: { key: string }) {
  const cached = await ctx.state.get<string>(input.key);

  if (cached) {
    ctx.logger.info('Cache hit', { key: input.key });
    ctx.ui.success(`Retrieved from cache: ${cached}`);
    return { exitCode: 0, result: cached };
  }

  ctx.logger.info('Cache miss', { key: input.key });
  const value = await fetchData(input.key);

  await ctx.state.set(input.key, value, 60000); // TTL 60s
  ctx.ui.success(`Fetched and cached: ${value}`);

  return { exitCode: 0, result: value };
}
```

---

## Troubleshooting

### Issue 1: "Property 'output' does not exist on type 'PluginContext'"

**Cause:** Using V2 API in V3 context.

**Fix:** Replace `ctx.output.ui` with `ctx.ui` and `ctx.output.logger` with `ctx.logger`.

### Issue 2: Enhanced UI boxes not showing

**Cause:**
1. Cache not cleared after update
2. CLI not rebuilt after plugin-runtime changes

**Fix:**
```bash
# Clear cache
rm -rf .kb/cache/*

# Rebuild plugin-runtime (generates new bootstrap.js)
pnpm --filter @kb-labs/plugin-runtime run build

# Rebuild CLI (copies new bootstrap.js)
pnpm --filter @kb-labs/cli-bin run build

# Test
pnpm kb your-plugin:command
```

### Issue 3: TypeScript errors after migration

**Cause:** Stale type definitions or missing imports.

**Fix:**
```bash
# Clean and rebuild
pnpm --filter your-plugin run clean
pnpm --filter your-plugin run build

# Type check
pnpm --filter your-plugin run type-check
```

### Issue 4: Tests failing after migration

**Cause:** Mock context structure outdated.

**Fix:** Update test mocks to use flat structure (`ctx.ui`, `ctx.logger`) instead of nested (`ctx.output.ui`, `ctx.output.logger`).

---

## Migration Script

Use this script to automatically migrate most common patterns:

```bash
#!/bin/bash
# migrate-to-v3.sh

find src -type f -name "*.ts" -exec sed -i '' \
  -e 's/ctx\.output\.ui\./ctx.ui./g' \
  -e 's/ctx\.output\.logger\./ctx.logger./g' \
  -e 's/ctx\.output\.state/ctx.state/g' \
  {} +

echo "✓ Migration complete. Review changes and test thoroughly!"
```

**Usage:**
```bash
chmod +x migrate-to-v3.sh
./migrate-to-v3.sh
```

**⚠️ Warning:** Always review changes manually after running automated migration scripts.

---

## Common Pitfalls (Real Migration Experience)

Based on actual migration of `@kb-labs/mind` plugin from V2 to V3.

### 🔴 Pitfall 1: Wrong Manifest Structure

**Problem:** Commands not registering in CLI even though manifest loads successfully.

**Wrong (doesn't work):**
```typescript
export const manifest: ManifestV3 = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/mind',

  // ❌ WRONG: Missing cli wrapper
  commands: [
    {
      id: 'mind:init',
      handler: './cli/commands/init.js',
      description: 'Initialize workspace',
    }
  ]
}
```

**Correct:**
```typescript
export const manifest: ManifestV3 = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/mind',

  // ✅ CORRECT: cli wrapper required
  cli: {
    commands: [
      {
        id: 'mind:init',                               // ✅ With prefix
        group: 'mind',                                 // ✅ Group required
        describe: 'Initialize workspace',              // ✅ 'describe' not 'description'
        handler: './cli/commands/init.js#default',     // ✅ #default suffix
        handlerPath: './cli/commands/init.js',         // ✅ handlerPath field
      }
    ]
  }
}
```

**Key differences:**
- Must wrap commands in `cli: { commands: [...] }`
- Use `describe` field (not `description`)
- Add `group` field
- Add `#default` suffix to handler
- Add `handlerPath` field
- Include plugin prefix in command ID

---

### 🔴 Pitfall 2: Handler Path Resolution

**Problem:** `Cannot find module` error even though file exists.

**Cause:** Handler paths are resolved relative to where `package.json` with `kb.manifest` field is located.

**Wrong setup:**
```
kb-labs-mind/                          ← Root monorepo
├── package.json                       ← kb.manifest points here
│   "kb": {
│     "manifest": "./packages/mind-cli/dist/manifest.v3.js"
│   }
└── packages/
    └── mind-cli/
        └── dist/
            ├── manifest.v3.js
            └── cli/commands/init.js

// In manifest.v3.ts:
handler: './cli/commands/init.js'      ← CLI tries to load from kb-labs-mind/cli/commands/init.js (doesn't exist!)
```

**Correct setup:**
```
kb-labs-mind/
├── package.json                       ← ❌ Remove kb.manifest from root!
└── packages/
    └── mind-cli/
        ├── package.json               ← ✅ Put kb.manifest HERE
        │   "kb": {
        │     "manifest": "./dist/manifest.v3.js"
        │   }
        └── dist/
            ├── manifest.v3.js
            └── cli/commands/init.js

// In manifest.v3.ts:
handler: './cli/commands/init.js'      ← Now resolves correctly!
```

**Rule:** Put `kb.manifest` in the **package** `package.json`, not in root monorepo `package.json`.

---

### 🔴 Pitfall 3: Missing SDK Exports

**Problem:** `Cannot find module '@kb-labs/sdk'` or `does not provide an export named 'useLogger'`.

**Cause:** SDK was refactored and some exports were removed.

**Missing exports:**
- `usePlatform`
- `useConfig`
- `useLLM`
- `useLogger`
- `useAnalytics`
- `trackAnalyticsEvent`
- `findRepoRoot`
- Monitoring helpers

**Fix:** Add these re-exports to `@kb-labs/sdk/src/index.ts`:
```typescript
// Re-export helpers from shared-command-kit
export {
  usePlatform,
  isPlatformConfigured,
  useConfig,
  useLLM,
  isLLMAvailable,
  useAnalytics,
  trackAnalyticsEvent,
  useLogger,
  useLoggerWithContext,
  useStorage,
} from '@kb-labs/shared-command-kit';

// Re-export sys utilities
export { findRepoRoot } from '@kb-labs/core-sys';

// Re-export monitoring from runtime
export {
  getMonitoringSnapshot,
  getDegradedStatus,
  type MonitoringSnapshot,
  type MonitoringOptions,
  type DegradedStatus,
  type DegradedOptions,
  type DegradedLevel,
} from '@kb-labs/core-runtime';
```

**Update SDK dependencies:**
```json
{
  "dependencies": {
    "@kb-labs/plugin-contracts": "link:...",
    "@kb-labs/shared-command-kit": "link:...",
    "@kb-labs/core-runtime": "link:...",
    "@kb-labs/core-sys": "link:..."
  }
}
```

---

### 🔴 Pitfall 4: ctx.logger Not Available in V3 Runtime

**Problem:** `Cannot read properties of undefined (reading 'info')` when calling `ctx.logger.info()`.

**Cause:** V3 runtime doesn't yet pass `logger` in context (as of 2025-12-18).

**Workaround:** Use `ctx.trace` instead:

```typescript
// ❌ Doesn't work yet:
ctx.logger.info('Command started', { cwd, force });

// ✅ Use trace instead:
ctx.trace?.addEvent?.('mind.init.start', { cwd, force });
```

**Note:** This is temporary. Once runtime adds logger support, switch back to `ctx.logger`.

---

### 🔴 Pitfall 5: Forgetting to Clear Plugin Cache

**Problem:** Changes to manifest don't take effect.

**Cause:** CLI caches manifest discovery results.

**Solution:** Always clear cache after rebuilding plugin:
```bash
pnpm --filter your-plugin run build
pnpm kb plugins clear-cache           # ← Don't forget this!
pnpm kb your-plugin:command
```

---

### 🔴 Pitfall 6: Manifest-First vs Per-Command Permissions

**Problem:** Trying to define permissions in command handler.

**V3 Philosophy:** Permissions are **manifest-first** (set once for entire plugin).

**Wrong:**
```typescript
export default defineCommand({
  id: 'mind:init',

  // ❌ WRONG: Don't define permissions here in V3
  permissions: {
    fs: { read: ['.kb/mind/**'] }
  },

  handler: { ... }
});
```

**Correct:**
```typescript
// In manifest.v3.ts:
export const manifest: ManifestV3 = {
  id: '@kb-labs/mind',

  // ✅ CORRECT: Define permissions once at manifest level
  permissions: {
    fs: {
      read: ['.kb/mind/**'],
      write: ['.kb/mind/**'],
    }
  },

  cli: {
    commands: [/* ... */]  // ← Commands inherit permissions
  }
}

// In command handler:
export default defineCommand({
  id: 'mind:init',
  // ✅ NO permissions field - inherited from manifest
  handler: { ... }
});
```

---

### 🔴 Pitfall 7: Wrong Import Source

**Problem:** Importing from `@kb-labs/plugin-contracts` directly instead of SDK.

**Rule:** In plugin commands, **all external imports must be from `@kb-labs/sdk`** only.

**Wrong:**
```typescript
import { defineCommand, type PluginContextV3 } from '@kb-labs/plugin-contracts';
```

**Correct:**
```typescript
import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
```

**Why?** SDK is the stable API surface. Direct imports from contracts may break.

---

### 🔴 Pitfall 8: Incorrect Return Type

**Problem:** Handler crashes with unclear error.

**V3 Command Result Structure:**
```typescript
interface CommandResult<T = unknown> {
  exitCode: number;        // ✅ Required (0 = success)
  result?: T;              // ✅ Optional structured data
  meta?: Record<string, unknown>;  // ✅ Optional metadata
}
```

**Examples:**

**Correct returns:**
```typescript
// Simple success
return { exitCode: 0 };

// With result data
return {
  exitCode: 0,
  result: { message: 'Hello' }
};

// With metadata
return {
  exitCode: 0,
  result: greeting,
  meta: {
    version: 'v3',
    timing: tracker.breakdown()
  }
};
```

**Wrong returns:**
```typescript
// ❌ Missing exitCode
return { ok: true, result: data };

// ❌ Just returning result
return greeting;

// ❌ Throwing without catching
throw new Error('...');  // Should return { exitCode: 1 } instead
```

---

### 🟡 Pitfall 9: Enhanced UI MessageOptions

**Problem:** `ctx.ui.success()` fails silently or shows basic output.

**Enhanced UI Options:**
```typescript
interface MessageOptions {
  title?: string;                         // Box title
  sections?: Array<{                      // Content sections
    header?: string;
    items: string[];
  }>;
  timing?: number;                        // Timing in ms (shows in footer)
  badge?: string;                         // Custom badge text
}
```

**Correct usage:**
```typescript
ctx.ui.success('Mind workspace initialized', {
  title: 'Mind Init',
  sections: [
    {
      header: 'Summary',
      items: [
        `Workspace: ${mindDir}`,
        `Status: Initialized`,
      ]
    },
    {
      header: 'Created Artifacts',
      items: artifactList
    }
  ],
  timing: Date.now() - startTime
});
```

**Output:**
```
┌── Mind Init
│
│ Summary
│  Workspace: /path/to/.kb/mind
│  Status: Initialized
│
│ Created Artifacts
│  ✓ Index: Main Mind index
│  ✓ API Index: API index
│
└── OK Success / 2ms
```

---

### 🟡 Pitfall 10: tsup.config.ts Output Directory

**Problem:** Built files not in expected location.

**Correct tsup config:**
```typescript
export default defineConfig({
  format: ['esm'],
  target: 'es2022',
  sourcemap: true,
  clean: true,
  outDir: 'dist',        // ← Output to dist/

  entry: [
    'src/index.ts',
    'src/manifest.v3.ts',
    'src/cli/commands/init.ts',  // ← Preserves structure: dist/cli/commands/init.js
    // ...
  ],
});
```

**Key:** Entry paths preserve directory structure in `dist/`.

---

### Migration Checklist (Reality-Tested)

Based on real migration experience, do these steps **in order**:

- [ ] **Step 1:** Read this pitfalls section (you're here!)
- [ ] **Step 2:** Create `manifest.v3.ts` with correct structure:
  - [ ] Use `cli: { commands: [...] }` wrapper
  - [ ] Add `group`, `describe`, `handler#default`, `handlerPath`
  - [ ] Define manifest-wide `permissions`
  - [ ] Command IDs include plugin prefix
- [ ] **Step 3:** Update `package.json` (in **package**, not root monorepo):
  - [ ] Add `"kb": { "manifest": "./dist/manifest.v3.js" }`
  - [ ] Add `@kb-labs/sdk` dependency
  - [ ] Remove old `@kb-labs/plugin-manifest` if exists
- [ ] **Step 4:** Migrate one command to V3 (proof of concept):
  - [ ] Change to default export
  - [ ] Update handler: `handler: { execute(ctx, input) }`
  - [ ] Change `ctx.output.ui` → `ctx.ui`
  - [ ] Change `ctx.output.logger` → `ctx.trace` (temporary!)
  - [ ] Remove per-command permissions
  - [ ] Use SDK imports only
- [ ] **Step 5:** Build and test:
  - [ ] `pnpm --filter your-plugin run build`
  - [ ] `pnpm kb plugins clear-cache` ← **Critical!**
  - [ ] `pnpm kb your-plugin:command --help` (check discovery)
  - [ ] `pnpm kb your-plugin:command` (check execution)
- [ ] **Step 6:** Check for common errors:
  - [ ] `Unknown command` → Wrong manifest structure (Pitfall #1)
  - [ ] `Cannot find module` → Wrong handler path (Pitfall #2)
  - [ ] `useLogger not found` → Missing SDK exports (Pitfall #3)
  - [ ] `Cannot read .info` → Using ctx.logger (Pitfall #4)
- [ ] **Step 7:** Migrate remaining commands
- [ ] **Step 8:** Update tests (mock flat context)
- [ ] **Step 9:** Update documentation

---

## Additional Resources

- **V3 Implementation Spec**: See [V3-IMPLEMENTATION-SPEC.md](../../../docs/V3-IMPLEMENTATION-SPEC.md) - Complete V3 architecture and technical specification
- **V3 Migration Guide (SDK)**: See [V3-MIGRATION-GUIDE.md](../../../docs/V3-MIGRATION-GUIDE.md) - SDK-level migration guide
- **UIFacade API Reference**: See [UI-API.md](../packages/plugin-contracts/UI-API.md)
- **Plugin Context Types**: See [context.ts](../../packages/plugin-contracts/src/context.ts)
- **Example Commands**: See [hello.ts](../../packages/plugin-template-core/src/cli/commands/hello.ts)
- **ADR**: [ADR-0014: Unified UI/Output API](../kb-labs-plugin/docs/adr/0014-unified-ui-output-api.md)

---

**Last Updated**: 2025-12-18
**API Version**: V3.0.0
**Migration Status**: Complete
