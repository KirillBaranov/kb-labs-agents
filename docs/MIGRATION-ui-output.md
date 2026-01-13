# Migration Guide: ctx.output → ctx.ui

**Date**: 2025-12-04
**Status**: Active

## Summary

The plugin system has migrated from `ctx.output` to `ctx.ui` for all output and UI functionality. The `ctx.output` interface has been deprecated and will be removed in v3.0.

## Quick Migration

### Before (OLD - Deprecated):
```typescript
// CLI commands
ctx.output?.write(`Hello, ${name}!\n`);
ctx.output?.success('Done', { data });
ctx.output?.info('Processing', { meta });
ctx.output?.debug('Details', { details });
ctx.output?.ui.sideBox({ title: 'Result', sections: [...] });

// REST handlers
ctx.output?.info('Request started', { meta });
ctx.output?.error('Failed', { error });

// Jobs
ctx.output?.info('Job running');
ctx.output?.error('Job failed', { error });
```

### After (NEW - Recommended):
```typescript
// CLI commands - Use ctx.ui for formatted output
ctx.ui?.write(`Hello, ${name}!\n`);
ctx.ui?.success('Done', {
  summary: { 'Status': 'Complete' },
  sections: [{ header: 'Details', items: [...] }],
  timing: ctx.tracker.total()
});
ctx.ui?.info('Processing', { summary: { 'Step': 1 } });
ctx.ui?.sideBox({ title: 'Result', sections: [...] }); // No .ui. prefix needed!

// Use ctx.logger for pure logging (no formatting)
ctx.logger?.debug('Details', { details });

// REST handlers - Use ctx.logger (no UI in REST context)
ctx.logger?.info('Request started', { meta });
ctx.logger?.error('Failed', { error });

// Jobs - Use ctx.logger (no UI in background jobs)
ctx.logger?.info('Job running');
ctx.logger?.error('Job failed', { error });
```

## Key Changes

### 1. ctx.ui Replaces ctx.output

| OLD (ctx.output) | NEW (ctx.ui or ctx.logger) |
|------------------|---------------------------|
| `ctx.output.write()` | `ctx.ui.write()` |
| `ctx.output.success()` | `ctx.ui.success()` |
| `ctx.output.error()` | `ctx.ui.showError()` ⚠️ Note: renamed! |
| `ctx.output.warn()` | `ctx.ui.warning()` |
| `ctx.output.info()` | `ctx.ui.info()` (CLI) or `ctx.logger.info()` (REST/Jobs) |
| `ctx.output.debug()` | `ctx.logger.debug()` |
| `ctx.output.trace()` | `ctx.logger.trace()` |
| `ctx.output.json()` | `ctx.ui.json()` |
| `ctx.output.ui.sideBox()` | `ctx.ui.sideBox()` ⚠️ No .ui. prefix! |
| `ctx.output.ui.colors` | `ctx.ui.colors` ⚠️ No .ui. prefix! |
| `ctx.output.ui.symbols` | `ctx.ui.symbols` ⚠️ No .ui. prefix! |

### 2. ctx.output.ui → ctx.ui (No Duplication!)

**Before**: Confusing duplication
```typescript
// These were THE SAME THING:
ctx.output.ui.sideBox({ ... });
ctx.ui.sideBox({ ... });

// These were also THE SAME:
ctx.output.ui.colors.success('text');
ctx.ui.colors.success('text');
```

**After**: Single source of truth
```typescript
// Just use ctx.ui directly:
ctx.ui.sideBox({ ... });
ctx.ui.colors.success('text');
ctx.ui.symbols.success; // '✓'
```

### 3. When to Use ctx.ui vs ctx.logger

**Use ctx.ui (CLI commands only):**
- ✅ User-facing formatted output
- ✅ Rich formatting (boxes, tables, colors)
- ✅ Progress indicators (spinners)
- ✅ Success/error/warning messages with formatting
- ✅ JSON output mode (`--json` flag)

**Use ctx.logger (CLI, REST, Jobs):**
- ✅ Pure logging without formatting
- ✅ Debug/trace messages
- ✅ REST handlers (no terminal output)
- ✅ Background jobs (no terminal output)
- ✅ Structured logging for analytics

**Example**:
```typescript
// CLI command handler
async handler(ctx, argv, flags) {
  // Logging (works in all contexts)
  ctx.logger?.debug('Starting command', { flags });

  // Formatted output (CLI only)
  ctx.ui?.success('Command Complete', {
    summary: { 'Files': 42 },
    timing: ctx.tracker.total()
  });

  return { ok: true };
}

// REST handler
async handle(input, ctx) {
  // Only logging (no UI in REST)
  ctx.logger?.info('Processing request', { input });

  // Don't use ctx.ui here - REST has no terminal!

  return { success: true };
}

// Job handler
async handler(input, ctx) {
  // Only logging (no UI in jobs)
  ctx.logger?.info('Job started', { runCount: input.runCount });

  // Don't use ctx.ui here - jobs run in background!

  return { ok: true };
}
```

## High-Level API (NEW)

The new `ctx.ui` provides high-level methods that auto-format AND auto-log:

```typescript
// Success with rich formatting
ctx.ui.success('Build Complete', {
  summary: {
    'Files': 42,
    'Duration': '1.2s'
  },
  sections: [
    {
      header: 'Output',
      items: ['dist/index.js', 'dist/types.d.ts']
    }
  ],
  timing: 1200
});

// Error with suggestions
ctx.ui.showError('Build Failed', new Error('TypeScript errors'), {
  suggestions: [
    'Run tsc --noEmit to see errors',
    'Check tsconfig.json'
  ]
});

// Warning
ctx.ui.warning('Deprecated APIs', [
  'Using old config format',
  'Migrate to new format soon'
]);

// Info (verbose mode only)
ctx.ui.info('Debug Info', {
  summary: { 'Cache hits': 95 }
});
```

## Low-Level API (Manual Control)

Use low-level methods when you need manual control:

```typescript
// Format a box (returns string, doesn't log)
const box = ctx.ui.sideBox({
  title: 'Custom Output',
  sections: [{ items: ['Line 1', 'Line 2'] }],
  status: 'info'
});

// Manual output control
console.log(box);
// or
ctx.ui.write(box);

// Styling
const greenText = ctx.ui.colors.success('All good!');
const icon = ctx.ui.symbols.success; // '✓'

// Progress (use direct import from SDK)
import { useLoader } from '@kb-labs/sdk';
const loader = useLoader('Processing...');
loader.start();
// ... work ...
loader.succeed('Done!');
```

## Migration Checklist

### For CLI Commands:
- [ ] Replace `ctx.output.write()` → `ctx.ui.write()`
- [ ] Replace `ctx.output.success()` → `ctx.ui.success()`
- [ ] Replace `ctx.output.error()` → `ctx.ui.showError()`
- [ ] Replace `ctx.output.warn()` → `ctx.ui.warning()`
- [ ] Replace `ctx.output.info()` → `ctx.ui.info()`
- [ ] Replace `ctx.output.debug()` → `ctx.logger.debug()`
- [ ] Replace `ctx.output.trace()` → `ctx.logger.trace()`
- [ ] Replace `ctx.output.ui.sideBox()` → `ctx.ui.sideBox()`
- [ ] Replace `ctx.output.ui.colors` → `ctx.ui.colors`
- [ ] Replace `ctx.output.ui.symbols` → `ctx.ui.symbols`
- [ ] Use high-level `ctx.ui.success()` instead of manual `sideBox() + write()`
- [ ] Add `timing` parameter using `ctx.tracker.total()`

### For REST Handlers:
- [ ] Replace `ctx.output.info()` → `ctx.logger.info()`
- [ ] Replace `ctx.output.error()` → `ctx.logger.error()`
- [ ] Replace `ctx.output.debug()` → `ctx.logger.debug()`
- [ ] Don't use `ctx.ui` in REST handlers (no terminal output)

### For Job Handlers:
- [ ] Replace `ctx.output.info()` → `ctx.logger.info()`
- [ ] Replace `ctx.output.error()` → `ctx.logger.error()`
- [ ] Don't use `ctx.ui` in job handlers (background execution)

## Examples

### Example 1: CLI Command Migration

**Before**:
```typescript
export const run = defineCommand({
  name: 'hello',
  flags: { name: { type: 'string' } },
  async handler(ctx, argv, flags) {
    ctx.output?.info('Starting command', { name: flags.name });
    ctx.output?.debug('Creating greeting', { target: flags.name });

    const result = createGreeting(flags.name);

    if (flags.json) {
      ctx.output?.json(result);
    } else {
      const box = ctx.output?.ui.sideBox({
        title: 'Hello Command Result',
        sections: [
          { items: [`Message: ${result.message}`] }
        ],
        status: 'success'
      });
      ctx.output?.write(box);
    }

    return { ok: true, result };
  }
});
```

**After**:
```typescript
export const run = defineCommand({
  name: 'hello',
  flags: { name: { type: 'string' } },
  async handler(ctx, argv, flags) {
    // Use ctx.ui.info() for formatted info messages
    ctx.ui?.info('Starting Hello Command', {
      summary: {
        'Name': flags.name || 'World',
        'JSON mode': flags.json ? 'yes' : 'no'
      }
    });

    // Use ctx.logger for pure logging
    ctx.logger?.debug('Creating greeting', { target: flags.name });

    const result = createGreeting(flags.name);

    if (flags.json) {
      ctx.ui?.json(result);
    } else {
      // Use high-level ctx.ui.success() instead of manual sideBox + write
      ctx.ui?.success('Hello Command Result', {
        summary: {
          'Message': result.message,
          'Target': result.target
        },
        sections: [{
          header: 'Styled Example',
          items: [
            `Target: ${ctx.ui.colors.accent(result.target)}`,
            `Status: ${ctx.ui.symbols.success} Complete`
          ]
        }],
        timing: ctx.tracker.total()
      });
    }

    return { ok: true, result };
  }
});
```

### Example 2: REST Handler Migration

**Before**:
```typescript
export const handleHello = definePluginHandler({
  schema: { input: HelloRequestSchema, output: HelloResponseSchema },
  async handle(input, ctx) {
    ctx.output?.info('REST handler started', { name: input.name });

    try {
      const result = await processRequest(input);
      return { success: true, data: result };
    } catch (error) {
      ctx.output?.error('Request failed', { error });
      throw error;
    }
  }
});
```

**After**:
```typescript
export const handleHello = definePluginHandler({
  schema: { input: HelloRequestSchema, output: HelloResponseSchema },
  async handle(input, ctx) {
    // Use ctx.logger (no UI in REST context)
    ctx.logger?.info('REST handler started', { name: input.name });

    try {
      const result = await processRequest(input);
      return { success: true, data: result };
    } catch (error) {
      ctx.logger?.error('Request failed', { error });
      throw error;
    }
  }
});
```

### Example 3: Job Handler Migration

**Before**:
```typescript
export const helloJob = defineJob({
  id: 'hello-cron',
  schedule: '*/1 * * * *',
  async handler(input, ctx) {
    const message = `Hello from job! Run #${input.runCount}`;

    try {
      await doWork();
      ctx.output?.info(message);
      return { ok: true, message };
    } catch (error) {
      ctx.output?.error('Job failed', { error });
      throw error;
    }
  }
});
```

**After**:
```typescript
export const helloJob = defineJob({
  id: 'hello-cron',
  schedule: '*/1 * * * *',
  async handler(input, ctx) {
    const message = `Hello from job! Run #${input.runCount}`;

    try {
      await doWork();
      // Use ctx.logger for jobs (no UI in background)
      ctx.logger?.info(message);
      return { ok: true, message };
    } catch (error) {
      ctx.logger?.error('Job failed', { error });
      throw error;
    }
  }
});
```

## Enhanced UI Methods with MessageOptions (v3.x)

Starting in v3.x, all UI methods (`success`, `info`, `warn`, `error`) support an optional second parameter for enhanced formatting with side-bordered boxes.

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
// Simple string output (still works)
ctx.ui.success('Operation completed!');
// Output: ✓ Operation completed!
```

### Enhanced Usage with Side-Bordered Box

```typescript
// Enhanced output with box
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

### Real-World Example

```typescript
import type { PluginContext } from '@kb-labs/plugin-contracts';

export async function execute(ctx: PluginContext, input: unknown) {
  const startTime = Date.now();

  // ... your logic here ...

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

The box footer displays status with color coding:
- **Success**: Green "OK Success"
- **Info**: Blue "INFO"
- **Warning**: Yellow "WARN"
- **Error**: Red "ERROR"

Timing is automatically formatted:
- `1200ms` → "1.2s"
- `500ms` → "500ms"
- `3600000ms` → "1h 0m"

### Complete Documentation

See [UI-API.md](../packages/plugin-contracts/UI-API.md) for complete API reference with more examples.

## Backward Compatibility

`ctx.output` is still available but marked as `@deprecated`. It will continue to work in v2.x for backward compatibility but will be removed in v3.0.

**Recommendation**: Migrate to `ctx.ui` / `ctx.logger` as soon as possible.

## Benefits of Migration

✅ **No duplication** - `ctx.output.ui` and `ctx.ui` were the same thing
✅ **Clearer API** - Obvious when to use `ctx.ui` (CLI formatting) vs `ctx.logger` (pure logging)
✅ **Better ergonomics** - High-level methods like `ctx.ui.success()` auto-format and log
✅ **Correct layering** - UI moved from `core-sys` (wrong) to `plugin-runtime` (correct)
✅ **Simpler mental model** - One API for UI, one for logging

## Reference

- **ADR**: [ADR-0014: Unified UI/Output API](../kb-labs-plugin/docs/adr/0014-unified-ui-output-api.md)
- **UIFacade Interface**: [presenter-facade.ts](../kb-labs-plugin/packages/plugin-runtime/src/presenter/presenter-facade.ts)
- **Examples**: [run.ts command](./packages/plugin-template-core/src/cli/commands/run.ts)

---

**Last Updated**: 2025-12-18
**Migration Status**: Complete (v3.x)
**Target Completion**: v3.0.0
