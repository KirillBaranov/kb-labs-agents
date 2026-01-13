# Migration Guide: createManifestV2 → defineManifest

> **Date**: 2025-12-05
> **Reason**: Moved manifest helpers from `@kb-labs/plugin-manifest` to `@kb-labs/shared-command-kit` for better separation of concerns

## TL;DR - Quick Migration

**Before:**
```typescript
import { createManifestV2 } from '@kb-labs/plugin-manifest';
export const manifest = createManifestV2({ ... });
```

**After:**
```typescript
import { defineManifest } from '@kb-labs/shared-command-kit';
export const manifest = defineManifest({ ... });
```

**That's it!** Just change the import and function name. Everything else stays the same.

---

## Why This Change?

### Problem
- `createManifestV2` was in `@kb-labs/plugin-manifest` (contracts package)
- Created **runtime dependency** on plugin-manifest when building plugins
- ESM dynamic imports couldn't resolve workspace symlinks
- Violated **separation of concerns** (contracts vs. development utilities)

### Solution
- Moved `createManifestV2` → `defineManifest` in `@kb-labs/shared-command-kit`
- Now part of **development utilities** alongside `defineCommand`, `defineSystemCommand`
- Zero runtime dependencies (compiles to plain object)
- Consistent naming pattern across all `define*` helpers

---

## Architecture Benefits

### Before (Incorrect Separation)
```
@kb-labs/plugin-manifest (Mixed Contracts + Utilities):
  - Types: ManifestV2, CliCommandDecl
  - Schemas: manifestV2Schema
  - Utilities: createManifestV2 ❌ (should not be here)
  - Utilities: defineCommandFlags ❌ (should not be here)
```

### After (Clean Separation)
```
@kb-labs/shared-command-kit (Development Utilities):
  - defineCommand()
  - defineSystemCommand()
  - defineManifest() ✅
  - defineCommandFlags() ✅
  - defineFlags()

@kb-labs/plugin-manifest (Contracts Only):
  - Types: ManifestV2, CliCommandDecl
  - Schemas: manifestV2Schema
  - Validation: validateManifestV2()
  - Migration: migrateV1ToV2()
```

**Result**: Contracts are separate from development helpers. Clean architecture!

---

## Step-by-Step Migration

### Step 1: Update Imports

**File**: `src/manifest.v2.ts`

```diff
- import { createManifestV2 } from '@kb-labs/plugin-manifest';
+ import { defineManifest } from '@kb-labs/shared-command-kit';
  import { pluginContractsManifest } from '@kb-labs/my-plugin-contracts';
```

### Step 2: Update Function Call

```diff
- export const manifest = createManifestV2<typeof pluginContractsManifest>({
+ export const manifest = defineManifest({
    schema: 'kb.plugin/2',
    id: '@kb-labs/my-plugin',
    // ... rest of manifest
  });
```

**Note**: Generic type parameter is removed because it's not needed. TypeScript infers types from the object.

### Step 3: Rebuild

```bash
pnpm run build
```

### Step 4: Test

```bash
# Clear plugin cache
pnpm kb plugins clear-cache

# Test your commands
pnpm kb my-plugin --help
pnpm kb my-plugin:command --help
```

---

## Complete Example

### Before

```typescript
/**
 * @module @kb-labs/my-plugin/manifest
 * Manifest v2 for My Plugin
 */

import { createManifestV2 } from '@kb-labs/plugin-manifest';
import { pluginContractsManifest } from '@kb-labs/my-plugin-contracts';

/**
 * My Plugin Manifest v2
 * Level 2: Типизация через contracts для автодополнения и проверки ID
 */
export const manifest = createManifestV2<typeof pluginContractsManifest>({
  schema: 'kb.plugin/2',
  id: '@kb-labs/my-plugin',
  version: '1.0.0',
  display: {
    name: 'My Plugin',
    description: 'My awesome plugin',
    tags: ['example', 'plugin'],
  },
  cli: {
    commands: [
      {
        manifestVersion: '1.0',
        id: 'hello',
        group: 'my-plugin',
        describe: 'Say hello',
        flags: [
          { name: 'name', type: 'string', description: 'Name to greet' },
          { name: 'json', type: 'boolean', description: 'JSON output' },
        ],
        handler: './cli/commands/hello#run',
      },
    ],
  },
  permissions: {
    fs: {
      mode: 'read',
      allow: ['.kb/my-plugin/**'],
    },
  },
});

export default manifest;
```

### After

```typescript
/**
 * @module @kb-labs/my-plugin/manifest
 * Manifest v2 for My Plugin
 */

import { defineManifest } from '@kb-labs/shared-command-kit';
import { pluginContractsManifest } from '@kb-labs/my-plugin-contracts';

/**
 * My Plugin Manifest v2
 * Level 2: Типизация через contracts для автодополнения и проверки ID
 */
export const manifest = defineManifest({
  schema: 'kb.plugin/2',
  id: '@kb-labs/my-plugin',
  version: '1.0.0',
  display: {
    name: 'My Plugin',
    description: 'My awesome plugin',
    tags: ['example', 'plugin'],
  },
  cli: {
    commands: [
      {
        manifestVersion: '1.0',
        id: 'hello',
        group: 'my-plugin',
        describe: 'Say hello',
        flags: [
          { name: 'name', type: 'string', description: 'Name to greet' },
          { name: 'json', type: 'boolean', description: 'JSON output' },
        ],
        handler: './cli/commands/hello#run',
      },
    ],
  },
  permissions: {
    fs: {
      mode: 'read',
      allow: ['.kb/my-plugin/**'],
    },
  },
});

export default manifest;
```

**Changes:**
1. Import from `@kb-labs/shared-command-kit`
2. Use `defineManifest` instead of `createManifestV2`
3. No generic type parameter needed

---

## Advanced: Using defineCommandFlags

If you want to **DRY** (Don't Repeat Yourself) and share flag definitions between manifest and command handler:

```typescript
import { defineManifest, defineCommandFlags, defineCommand } from '@kb-labs/shared-command-kit';

// 1. Define flags once
const helloFlags = {
  name: { type: 'string', description: 'Name to greet', alias: 'n' },
  json: { type: 'boolean', description: 'JSON output', default: false },
} as const;

// 2. Use in manifest
export const manifest = defineManifest({
  cli: {
    commands: [{
      id: 'hello',
      flags: defineCommandFlags(helloFlags), // Converts to manifest format
      handler: './cli/commands/hello#run',
    }],
  },
});

// 3. Use in command handler (in ./cli/commands/hello.ts)
export const run = defineCommand({
  name: 'hello',
  flags: helloFlags, // Reuse same definition
  async handler(ctx, argv, flags) {
    // flags.name is typed as string | undefined
    // flags.json is typed as boolean
    const name = flags.name ?? 'World';
    const message = `Hello, ${name}!`;

    if (flags.json) {
      return { ok: true, message };
    }

    ctx.ui.success(message);
    return { ok: true };
  },
});
```

**Benefits:**
- ✅ Single source of truth for flags
- ✅ Type safety between manifest and handler
- ✅ No duplication

---

## Affected Packages (Already Migrated)

These packages have been updated to use `defineManifest`:

- ✅ `@kb-labs/mind-cli`
- ✅ `@kb-labs/core-cli`
- ✅ `@kb-labs/devlink-cli`
- ✅ `@kb-labs/devlink-core`
- ✅ `@kb-labs/playbooks-core`
- ✅ `@kb-labs/plugin-template-core`
- ✅ `@kb-labs/analytics-cli`

If you're creating a new plugin, use `defineManifest` from the start.

---

## FAQ

### Q: Do I need to update my plugin-manifest dependency?

**A**: No changes needed. `@kb-labs/plugin-manifest` still exports all types (`ManifestV2`, etc.). Only the helper functions moved.

### Q: Will old manifests break?

**A**: No. Existing built plugins (`dist/`) will continue to work. The migration is only needed when rebuilding.

### Q: What about type contracts?

**A**: Contracts (`pluginContractsManifest`) are still in your plugin's contracts package. `defineManifest` still provides type safety.

### Q: Can I use plain objects instead?

**A**: Yes! `defineManifest` is just a type-safe wrapper. You can use plain objects:

```typescript
import type { ManifestV2 } from '@kb-labs/plugin-manifest';

export const manifest: ManifestV2 = {
  schema: 'kb.plugin/2',
  // ... your manifest
} satisfies ManifestV2;
```

This is what Mind plugin uses (to avoid any runtime dependencies). Both approaches are valid.

### Q: Why `defineManifest` instead of `createManifest`?

**A**: Consistency with ecosystem naming:
- ✅ `defineCommand` (not `createCommand`)
- ✅ `defineSystemCommand` (not `createSystemCommand`)
- ✅ `defineManifest` (not `createManifest`)
- ✅ `defineFlags` (not `createFlags`)

All `define*` functions follow the same pattern.

---

## Related Documentation

- [shared-command-kit README](../../kb-labs-shared/packages/shared-command-kit/README.md#manifest-definition)
- [plugin-manifest README](../../kb-labs-plugin/packages/plugin-manifest/README.md)
- [Plugin Template](../README.md)

---

## Timeline

- **2025-12-05**: Migration completed across all official plugins
- **2025-12-05**: Documentation updated
- **Future**: `createManifestV2` will be deprecated and removed from `plugin-manifest`

---

**Need help?** Check the [shared-command-kit examples](../../kb-labs-shared/packages/shared-command-kit/README.md#manifest-definition) or reference the official plugins listed above.
