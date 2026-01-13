# V3 Plugin Migration Plan - Plugin Template

**Date:** 2025-12-18
**Status:** In Progress
**Target Plugin:** `@kb-labs/plugin-template`

## Overview

This document describes the migration plan for `kb-labs-plugin-template` from V2 to V3 plugin architecture. This serves as a **reference template** for migrating other plugins in the monorepo.

## Current Status

### ✅ Completed
- `hello.ts` command migrated to V3 format
- `manifest.v3.ts` created with one command
- V3 architecture documented in `docs/V3-ADAPTER-ARCHITECTURE.md`

### ⏳ To Migrate
- `run.ts` (hello command - V2 format)
- `test-loader.ts` (loader test command - V2 format)
- Remove `manifest.v2.ts`
- Remove V2-specific files (`flags.ts`, `hello-v3.ts` duplicate)

## Migration Steps

### Phase 1: Command Migration

#### 1.1 Migrate `run.ts` to V3

**Current structure (V2):**
```typescript
import { getCommandId } from '@kb-labs/plugin-template-contracts';
import { defineCommand, withAnalytics } from '@kb-labs/sdk';

export const run = defineCommand<TemplateHelloFlags, TemplateHelloResult>({
  name: getCommandId('plugin-template:hello'),
  flags: templateHelloFlags,
  async handler(ctx: any, argv: string[], flags: TemplateHelloFlags) {
    // V2 handler with (ctx, argv, flags)
    return { ok: true, result: payload };
  }
});
```

**Target structure (V3):**
```typescript
import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

// V3: Inline flags (no external contracts)
interface HelloFlags {
  name?: string;
  json?: boolean;
}

interface HelloInput {
  argv: string[];
  flags: HelloFlags;
}

interface HelloResult {
  message: string;
  target: string;
}

export default defineCommand<unknown, HelloInput, HelloResult>({
  id: 'plugin-template:hello',
  description: 'Print a hello message',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: HelloInput
    ): Promise<CommandResult<HelloResult>> {
      // V3 handler - object with execute method
      return {
        exitCode: 0,
        result: { message: '...', target: '...' }
      };
    }
  }
});
```

**Key changes:**
1. ❌ Remove dependency on `@kb-labs/plugin-template-contracts`
2. ❌ Remove `getCommandId()` helper - use string literal
3. ✅ Define flags inline in the command file
4. ✅ Handler becomes object with `execute` method
5. ✅ Input is single object `{ argv, flags }`
6. ✅ Context is `PluginContextV3<unknown>`
7. ✅ Return `{ exitCode, result }` instead of `{ ok, result }`
8. ✅ Use `ctx.platform.*` directly (no adapters)
9. ✅ Export as `default` (not named export)

#### 1.2 Migrate `test-loader.ts` to V3

Same changes as above, specific to loader testing flags.

**Current flags:**
```typescript
export interface TestLoaderFlags {
  duration?: number;
  fail?: boolean;
  stages?: number;
}
```

**V3 approach:**
```typescript
// Define inline - no external contracts
interface LoaderFlags {
  duration?: number;
  fail?: boolean;
  stages?: number;
}

interface LoaderInput {
  argv: string[];
  flags: LoaderFlags;
}

interface LoaderResult {
  completed: boolean;
  stagesRun: number;
}

export default defineCommand<unknown, LoaderInput, LoaderResult>({
  id: 'plugin-template:test-loader',
  description: 'Test UI loader/spinner functionality',

  handler: {
    async execute(ctx, input) {
      // Implementation
    }
  }
});
```

### Phase 2: Manifest Update

#### 2.1 Update `manifest.v3.ts`

**Add migrated commands:**
```typescript
cli: {
  commands: [
    {
      id: 'plugin-template:hello',
      group: 'plugin-template',
      describe: 'Print a hello message (V3)',
      longDescription: 'V3 version with improved UI and timing.',
      flags: defineCommandFlags({
        name: {
          type: 'string',
          description: 'Name to greet',
          default: 'World',
          alias: 'n',
        },
        json: {
          type: 'boolean',
          description: 'Output as JSON',
          default: false,
        },
      }),
      examples: generateExamples('hello', 'plugin-template', [
        { description: 'Basic greeting', flags: {} },
        { description: 'Greet specific name', flags: { name: 'Developer' } },
        { description: 'Output as JSON', flags: { json: true } }
      ]),
      handler: './cli/commands/hello.js#default',
      handlerPath: './cli/commands/hello.js',
      permissions: permissions.combine(
        permissions.presets.pluginWorkspaceRead('template'),
        {
          quotas: {
            timeoutMs: 5000,
            memoryMb: 64,
            cpuMs: 2500,
          },
        }
      ),
    },
    {
      id: 'plugin-template:test-loader',
      group: 'plugin-template',
      describe: 'Test UI loader functionality (V3)',
      flags: defineCommandFlags({
        duration: {
          type: 'number',
          description: 'Duration per stage (ms)',
          default: 2000,
          alias: 'd',
        },
        fail: {
          type: 'boolean',
          description: 'Simulate failure',
          default: false,
          alias: 'f',
        },
        stages: {
          type: 'number',
          description: 'Number of stages',
          default: 3,
          alias: 's',
        },
      }),
      handler: './cli/commands/test-loader.js#default',
      handlerPath: './cli/commands/test-loader.js',
      permissions: permissions.presets.pluginWorkspaceRead('template'),
    }
  ]
}
```

#### 2.2 Remove `manifest.v2.ts`

After all commands are migrated and tested, delete V2 manifest:
```bash
rm packages/plugin-template-core/src/manifest.v2.ts
```

### Phase 3: Cleanup

#### 3.1 Remove V2-specific files

**Files to remove:**
- `src/cli/commands/flags.ts` - flags now inline in commands
- `src/cli/commands/hello-v3.ts` - duplicate of migrated hello.ts
- `src/cli/commands/run.ts` - replaced by hello.ts V3

**Files to keep:**
- `src/cli/commands/hello.ts` - V3 migrated
- `src/cli/commands/test-loader.ts` - V3 migrated
- `src/cli/commands/index.ts` - update exports

#### 3.2 Update `index.ts` exports

```typescript
// src/cli/commands/index.ts

// V3: Export default exports from commands
export { default as helloCommand } from './hello.js';
export { default as testLoaderCommand } from './test-loader.js';
```

#### 3.3 Update package.json

**Remove V2 dependencies:**
```json
{
  "dependencies": {
    // ❌ Remove:
    // "@kb-labs/plugin-template-contracts": "workspace:*",
    // "@kb-labs/plugin-contracts": "workspace:*",

    // ✅ Keep only:
    "@kb-labs/sdk": "workspace:*"
  }
}
```

### Phase 4: Testing

#### 4.1 Test each command manually

```bash
# Build first
pnpm --filter @kb-labs/plugin-template-core run build

# Test hello command
pnpm kb plugin-template:hello
pnpm kb plugin-template:hello --name "Developer"
pnpm kb plugin-template:hello --json

# Test loader command
pnpm kb plugin-template:test-loader
pnpm kb plugin-template:test-loader --duration 1000 --stages 5
pnpm kb plugin-template:test-loader --fail
```

#### 4.2 Verify manifest loads correctly

```bash
# Check plugin is registered
pnpm kb plugins list | grep "plugin-template"

# Check commands are available
pnpm kb plugin-template --help
```

## V3 Command Checklist

Use this checklist when migrating any command:

### Dependencies
- [ ] Remove `@kb-labs/plugin-template-contracts` (or equivalent)
- [ ] Remove `@kb-labs/plugin-contracts` if present
- [ ] Ensure only `@kb-labs/sdk` is imported

### Type Definitions
- [ ] Define flags interface inline (not external)
- [ ] Define input interface: `{ argv: string[], flags: FlagsType }`
- [ ] Define result interface for structured output
- [ ] Import `PluginContextV3` from SDK
- [ ] Import `CommandResult` from SDK

### Command Definition
- [ ] Use `defineCommand<unknown, InputType, ResultType>(...)`
- [ ] Set `id` as string literal (no helper function)
- [ ] Set `description` string
- [ ] Handler is object with `execute` method
- [ ] Handler signature: `async execute(ctx: PluginContextV3<unknown>, input: InputType): Promise<CommandResult<ResultType>>`

### Handler Implementation
- [ ] Access flags via `input.flags`
- [ ] Access argv via `input.argv`
- [ ] Use `ctx.platform.logger` for logging (not `ctx.logger`)
- [ ] Use `ctx.platform.llm` if needed (not `ctx.llm`)
- [ ] Use `ctx.ui.*` for user output
- [ ] Use `ctx.trace.addEvent()` for tracing
- [ ] Return `{ exitCode: 0, result: {...} }` (not `{ ok: true, result: {...} }`)

### Export
- [ ] Export command as `default` (not named)
- [ ] No wrapper function needed (e.g., `runHelloCommand`)

### Manifest Entry
- [ ] Set `handler: './path/to/command.js#default'`
- [ ] Set `handlerPath: './path/to/command.js'`
- [ ] Define flags using `defineCommandFlags({ ... })`
- [ ] Add examples using `generateExamples(...)`
- [ ] Define permissions using `permissions.combine(...)`

## Common Patterns

### Pattern 1: Simple Command (No External Services)

```typescript
import { defineCommand, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

interface MyFlags {
  name?: string;
}

interface MyInput {
  argv: string[];
  flags: MyFlags;
}

interface MyResult {
  data: string;
}

export default defineCommand<unknown, MyInput, MyResult>({
  id: 'my-plugin:my-command',
  description: 'Does something',

  handler: {
    async execute(ctx: PluginContextV3<unknown>, input: MyInput): Promise<CommandResult<MyResult>> {
      const result = { data: `Hello ${input.flags.name || 'World'}` };

      ctx.ui.success('Done', {
        summary: { 'Result': result.data }
      });

      return { exitCode: 0, result };
    }
  }
});
```

### Pattern 2: Command with LLM

```typescript
export default defineCommand<unknown, MyInput, MyResult>({
  id: 'my-plugin:ai-command',
  description: 'Uses AI',

  handler: {
    async execute(ctx, input) {
      // Check if LLM is available
      if (!ctx.platform.llm) {
        ctx.ui.error('LLM not configured');
        return { exitCode: 1 };
      }

      const response = await ctx.platform.llm.complete(input.flags.prompt, {
        maxTokens: 100
      });

      return { exitCode: 0, result: { response } };
    }
  }
});
```

### Pattern 3: Command with File System

```typescript
export default defineCommand<unknown, MyInput, MyResult>({
  id: 'my-plugin:fs-command',
  description: 'Works with files',

  handler: {
    async execute(ctx, input) {
      // Use ctx.runtime.fs for sandboxed file access
      const content = await ctx.runtime.fs.readFile(input.flags.path, 'utf-8');

      // Process content...

      return { exitCode: 0, result: { content } };
    }
  }
});
```

## Migration Timeline

### Day 1 (Today)
- ✅ Review existing V3 migration (hello.ts)
- ✅ Create migration plan document
- ⏳ Migrate `run.ts` command

### Day 2
- Migrate `test-loader.ts` command
- Update manifest.v3.ts with both commands
- Test all commands

### Day 3
- Remove V2 files
- Update package.json dependencies
- Final testing
- Create migration guide for other plugins

## Success Criteria

Migration is complete when:

1. ✅ All commands use V3 format (handler object with execute)
2. ✅ All commands use inline types (no external contracts)
3. ✅ manifest.v3.ts contains all commands
4. ✅ manifest.v2.ts is removed
5. ✅ V2-specific files are removed
6. ✅ All commands tested and working
7. ✅ No dependencies on `plugin-template-contracts` or `plugin-contracts`
8. ✅ Migration guide created for other plugins

## Next Steps

After plugin-template migration is complete:

1. Use this plan as template for other plugins:
   - `kb-labs-mind` (mind-cli package)
   - `kb-labs-workflow` (workflow-cli package)
   - `kb-labs-knowledge` (knowledge-cli package)
   - etc.

2. Create automated migration tooling if needed:
   - CLI command to scaffold V3 command from V2
   - Codemod for common patterns

3. Update DevKit tools to support V3 validation:
   - Check for V3 manifest schema
   - Validate command handler format
   - Check for missing dependencies

## References

- [V3 Adapter Architecture](../docs/V3-ADAPTER-ARCHITECTURE.md)
- [V3 Implementation Spec](../docs/V3-IMPLEMENTATION-SPEC.md)
- [SDK Package](../kb-labs-sdk/packages/sdk/)
- [Plugin Contracts](../kb-labs-plugin/packages/plugin-contracts/)
