# V3 Migration Summary - Plugin Template

**Date:** 2025-12-18
**Status:** 🟡 In Progress (1/3 commands migrated)

## Current Status

### ✅ Completed
- [x] **hello.ts** - Fully migrated to V3 format
- [x] **manifest.v3.ts** - Created with V3 schema
- [x] **Documentation** - Migration plan and guides created

### ⏳ In Progress
- [ ] **run.ts** - V2 hello command (needs migration)
- [ ] **test-loader.ts** - V2 loader test command (needs migration)

### 📋 Pending
- [ ] Remove `manifest.v2.ts`
- [ ] Remove `flags.ts` (types now inline)
- [ ] Remove `hello-v3.ts` (duplicate)
- [ ] Update `package.json` dependencies
- [ ] Final testing

## Files Overview

### Documentation Created
| File | Purpose | Status |
|------|---------|--------|
| `V3-MIGRATION-PLAN.md` | Detailed migration plan for plugin-template | ✅ Done |
| `V3-QUICK-REFERENCE.md` | Quick cheat sheet for migration | ✅ Done |
| `../docs/V3-MIGRATION-GUIDE.EN.md` | English migration guide for all plugins | ✅ Done |
| `../docs/V3-MIGRATION-GUIDE.md` | Russian migration guide (existing) | ✅ Exists |

### Commands Status
| File | Status | Notes |
|------|--------|-------|
| `hello.ts` | ✅ Migrated | Reference V3 implementation |
| `run.ts` | ⏳ To migrate | V2 hello command |
| `test-loader.ts` | ⏳ To migrate | V2 loader test |
| `hello-v3.ts` | 🗑️ Remove | Duplicate, can delete |
| `flags.ts` | 🗑️ Remove | Types now inline |
| `index.ts` | 🔄 Update | Update exports after migration |

### Manifest Status
| File | Status | Notes |
|------|--------|-------|
| `manifest.v3.ts` | ✅ Created | Has 1 command (hello) |
| `manifest.v2.ts` | 🗑️ Remove | After all commands migrated |

## What Was Migrated

### hello.ts (V3) ✅

**Key changes:**
1. ✅ Single dependency: `@kb-labs/sdk` only
2. ✅ Inline types (no external contracts)
3. ✅ Handler object with `execute` method
4. ✅ Input as single `{ argv, flags }` object
5. ✅ Context typed as `PluginContextV3<unknown>`
6. ✅ Return `{ exitCode: 0, result }` not `{ ok: true }`
7. ✅ Export as `default` (no wrapper)
8. ✅ Platform services via `ctx.platform.*`

**Example:**
```typescript
export default defineCommand<unknown, HelloInput, HelloResult>({
  id: 'plugin-template:hello',
  description: 'Print a hello message',

  handler: {
    async execute(ctx: PluginContextV3<unknown>, input: HelloInput) {
      const greeting = createGreeting(input.flags.name);

      ctx.ui.sideBox({
        title: 'Hello Command',
        status: 'success',
        summary: { 'Message': greeting.message },
        timing: tracker.total(),
      });

      return { exitCode: 0, result: greeting };
    }
  }
});
```

## What Needs Migration

### run.ts (V2) → V3

**Current issues:**
- ❌ Uses `@kb-labs/plugin-template-contracts`
- ❌ Uses `getCommandId()` helper
- ❌ External flags from `./flags`
- ❌ Handler is function (not object)
- ❌ Three parameters `(ctx, argv, flags)`
- ❌ Returns `{ ok: true, result }`
- ❌ Named export + wrapper function

**Migration steps:**
1. Remove contract imports
2. Define types inline
3. Change to handler object
4. Update to V3 context and input
5. Export as default

### test-loader.ts (V2) → V3

**Same issues as run.ts**

**Migration steps:**
1. Remove contract imports
2. Define loader flags inline
3. Change to handler object
4. Update to V3 format
5. Export as default

## Migration Guide Summary

### For Plugin Template (This Repo)

**Use:**
- [V3-MIGRATION-PLAN.md](./V3-MIGRATION-PLAN.md) - Detailed plan
- [V3-QUICK-REFERENCE.md](./V3-QUICK-REFERENCE.md) - Quick cheat sheet
- [hello.ts](./packages/plugin-template-core/src/cli/commands/hello.ts) - Reference implementation

### For Other Plugins

**Use:**
- [V3-MIGRATION-GUIDE.EN.md](../docs/V3-MIGRATION-GUIDE.EN.md) - English guide
- [V3-MIGRATION-GUIDE.md](../docs/V3-MIGRATION-GUIDE.md) - Russian guide
- plugin-template as reference

## Next Steps

### Immediate (Today)
1. ✅ Create migration documentation ← **Done**
2. ⏳ Migrate `run.ts` to V3 ← **Next**
3. ⏳ Update manifest with new command
4. ⏳ Test migrated command

### Short-term (This Week)
1. Migrate `test-loader.ts` to V3
2. Update manifest.v3.ts with all commands
3. Remove V2 files and cleanup
4. Final testing
5. Update CHANGELOG

### Long-term (Next Sprint)
1. Use plugin-template as template for:
   - kb-labs-mind migration
   - kb-labs-workflow migration
   - kb-labs-knowledge migration
2. Create automated migration tooling if needed
3. Update DevKit to validate V3 format

## Key Differences V2 → V3

| Aspect | V2 | V3 |
|--------|----|----|
| **Schema** | `kb.plugin/2` | `kb.plugin/3` |
| **Dependencies** | SDK + contracts | SDK only |
| **Types** | External package | Inline |
| **Handler** | Function | Object with `execute` |
| **Input** | `(ctx, argv, flags)` | `(ctx, input)` |
| **Return** | `{ ok, result }` | `{ exitCode, result }` |
| **Export** | Named + wrapper | Default only |
| **Platform** | `ctx.logger` | `ctx.platform.logger` |
| **Manifest ref** | `#functionName` | `#default` |

## Benefits of V3

### ✅ Simpler
- No external contracts package to maintain
- No wrapper functions needed
- Less boilerplate code

### ✅ More Consistent
- Same patterns across all plugins
- Single source of truth in SDK
- Unified platform API

### ✅ Better Type Safety
- `PluginContextV3<ConfigType>` fully typed
- Platform services always defined (NoOp fallback)
- Compile-time errors for wrong types

### ✅ Easier Testing
- Mock `ctx.platform.*` easily
- No need to mock wrapper functions
- `createTestContext` from SDK

## Success Criteria

Migration complete when:

1. ✅ All commands use V3 format
2. ✅ All commands in manifest.v3.ts
3. ✅ manifest.v2.ts removed
4. ✅ External contracts removed
5. ✅ All commands tested
6. ✅ Documentation updated
7. ✅ No breaking changes for users

## Resources

### Internal Docs
- [V3 Architecture](../docs/V3-ADAPTER-ARCHITECTURE.md)
- [V3 Implementation Spec](../docs/V3-IMPLEMENTATION-SPEC.md)
- [Migration Plan](./V3-MIGRATION-PLAN.md)
- [Quick Reference](./V3-QUICK-REFERENCE.md)
- [English Guide](../docs/V3-MIGRATION-GUIDE.EN.md)

### Code References
- [SDK Package](../kb-labs-sdk/packages/sdk/)
- [Plugin Contracts V3](../kb-labs-plugin/packages/plugin-contracts/)
- [hello.ts example](./packages/plugin-template-core/src/cli/commands/hello.ts)
- [manifest.v3.ts](./packages/plugin-template-core/src/manifest.v3.ts)

### External
- Plugin System Design Docs (if available)
- V3 Migration Issues/Discussions

---

**Last Updated:** 2025-12-18
**Migration Progress:** 1/3 commands (33%)
**Estimated Completion:** 2-3 days
