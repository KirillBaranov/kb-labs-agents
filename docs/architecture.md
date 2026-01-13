# Architecture Guide

The plugin template adopts a **functional folder organization** aligned with KB Labs ecosystem standards. The goal is to keep surfaces thin, provide clear boundaries, and make code discoverable for new contributors.

> **📌 Important:** Before diving into architecture, familiarize yourself with the [Naming Convention](./naming-convention.md) - the mandatory "Pyramid Rule" that all KB Labs packages must follow.

## Overview

**Philosophy:** Organize by product surface (CLI, REST, Studio) rather than architectural layers (domain, application, infrastructure).

**Benefits:**
- **Discoverability**: Developers find CLI code in `cli/`, REST handlers in `rest/`
- **Scalability**: Easy to add new surfaces (workflows, jobs) without restructuring
- **Consistency**: Matches devlink-core, mind-engine, workflow-runtime patterns
- **Simplicity**: No path aliases, no complex layer rules

## Folder Structure

```
packages/plugin-template-core/
├── cli/              # CLI surface - command implementations
│   ├── commands/     # Individual commands
│   │   ├── run.ts    # Command implementation (defineCommand)
│   │   ├── flags.ts  # Flag definitions (typed)
│   │   └── index.ts  # Barrel export
│   └── index.ts
│
├── rest/             # REST surface - HTTP handlers
│   ├── handlers/     # Route handlers
│   │   ├── hello-handler.ts  # definePluginHandler
│   │   └── context.ts        # Shared handler types
│   ├── schemas/      # Request/response schemas
│   │   └── hello-schema.ts   # Zod schemas
│   └── index.ts
│
├── studio/           # Studio surface - UI widgets
│   ├── widgets/      # React components
│   │   ├── hello-widget.tsx  # Widget implementation
│   │   └── index.ts
│   └── index.ts
│
├── workflows/        # Workflows surface (placeholder)
│   └── .gitkeep      # Future: custom plugin workflows
│
├── jobs/             # Jobs surface (placeholder)
│   └── .gitkeep      # Future: cron & background jobs
│
├── lifecycle/        # Lifecycle hooks (future)
│   ├── setup.ts      # Future: plugin installation
│   ├── destroy.ts    # Future: plugin uninstallation
│   └── upgrade.ts    # Future: plugin version upgrades
│
├── core/             # Business logic - domain & use cases
│   ├── greeting.ts   # Domain entity (pure logic)
│   ├── create-greeting.ts  # Use case (orchestration)
│   └── index.ts
│
├── utils/            # Shared utilities
│   ├── logger.ts     # Logger adapter
│   ├── constants.ts  # Shared constants
│   └── index.ts
│
├── index.ts          # Main barrel export (public API)
├── manifest.v2.ts    # Plugin manifest (contract)
└── setup-handler.ts  # Setup operation handler
```

## Layers & Principles

While we don't enforce strict DDD layers, we follow these principles:

| Folder | Purpose | Dependencies | Rules |
|--------|---------|--------------|-------|
| **cli/** | CLI commands, flags, handlers | `core/`, `utils/` | Thin adapters—delegate to core |
| **rest/** | REST handlers, schemas | `core/`, `utils/` | Thin adapters—delegate to core |
| **studio/** | React widgets, UI components | `core/`, `utils/` | Stateless presentational components |
| **core/** | Business logic, domain entities, use cases | `utils/` only | Pure functions, no side effects |
| **utils/** | Logger, constants, helpers | None (leaf) | Framework-agnostic utilities |
| **workflows/** | Custom plugin workflows | `core/`, `utils/` | Future: workflow definitions |
| **jobs/** | Cron & background jobs | `core/`, `utils/` | Future: job definitions |
| **lifecycle/** | Plugin lifecycle hooks | `core/`, `utils/` | Future: setup, destroy, upgrade handlers |

### Dependency Flow

```
┌──────────────────────────────────────────┐
│ CLI / REST / Studio / Workflows / Jobs   │ ← Surface adapters (thin)
└─────────────┬────────────────────────────┘
              ↓
         ┌─────────┐
         │  Core   │ ← Business logic (pure)
         └────┬────┘
              ↓
         ┌─────────┐
         │  Utils  │ ← Shared utilities (leaf)
         └─────────┘
```

**Rule**: Surfaces never import from each other. All shared logic goes in `core/` or `utils/`.

## Manifest as the Contract

`src/manifest.v2.ts` is the **single source of truth** for the plugin:

- **CLI Commands**: Declares command IDs, flags, handlers, examples
- **REST Routes**: Declares endpoints, schemas, permissions, error handling
- **Studio Widgets**: Registers widgets, menus, layouts, data sources
- **Capabilities**: Documents what the plugin can do
- **Artifacts**: Declares what the plugin produces

**Any change to CLI/REST/Studio must update the manifest first.**

### Example: Adding a New Command

1. **Define the command** in `cli/commands/new-command.ts`
2. **Update manifest** in `manifest.v2.ts`:
   ```typescript
   cli: {
     commands: [
       {
         id: 'template:new-command',
         group: 'template',
         describe: 'Does something new',
         handler: './cli/commands/new-command.js#run',
         flags: defineCommandFlags(newCommandFlags)
       }
     ]
   }
   ```
3. **Export from barrel** in `cli/index.ts`
4. **Add tests** for the new command
5. **Update docs** (cli-guide.md)

## Testing Strategy

### Unit Tests
- **core/** - Pure business logic, easy to test
  - Example: `greeting.test.ts` tests `createGreeting()` function
- **utils/** - Utility functions
  - Example: `logger.test.ts` tests log formatting

### Integration Tests
- **CLI commands** - Invoke command handlers with mock context
  - Example: `run.test.ts` tests `runHelloCommand()` with args
- **REST handlers** - Invoke handlers with mock runtime
  - Example: `hello-handler.test.ts` tests `handleHello()` with input
- **Studio widgets** - React Testing Library smoke tests
  - Example: `hello-widget.test.tsx` tests rendering

### Manual Testing
- **Sandbox scripts**: `pnpm sandbox:cli`, `pnpm sandbox:rest`
- **Local plugin installation**: Test in real KB Labs environment

## Scalability & Growth

### When to Split `core/`

If `core/` grows beyond 10 files, consider organizing by domain:

```
core/
├── greeting/       # Greeting domain
│   ├── greeting.ts
│   └── create-greeting.ts
├── config/         # Config domain
│   ├── config.ts
│   └── load-config.ts
└── index.ts
```

### When to Add Layers

If complexity demands strict boundaries, you can introduce layers **within** core:

```
core/
├── domain/         # Pure entities (no dependencies)
├── application/    # Use cases (orchestration)
└── ports/          # Interface definitions for infra
```

But **start simple**—only add layers when needed.

### Adding New Surfaces

**Workflows:**
```typescript
// workflows/hello-workflow.ts
export const helloWorkflow = defineWorkflow({
  id: 'template.hello',
  steps: [
    { action: 'greet', handler: './core/create-greeting.js' }
  ]
});
```

**Jobs:**
```typescript
// jobs/daily-greeting.ts
export const dailyGreeting = defineJob({
  id: 'template.daily-greeting',
  schedule: '0 9 * * *', // 9 AM daily
  handler: './core/create-greeting.js'
});
```

**Lifecycle Hooks:**
```typescript
// lifecycle/setup.ts (plugin installation)
export async function setup(ctx: LifecycleContext) {
  await ctx.fs.mkdir('.kb/template');
  await ctx.fs.writeFile('.kb/template/config.json', '{}');
  ctx.logger.info('Plugin installed successfully');
}

// lifecycle/destroy.ts (plugin uninstallation)
export async function destroy(ctx: LifecycleContext) {
  await ctx.fs.rm('.kb/template', { recursive: true });
  ctx.logger.info('Plugin uninstalled, cleanup complete');
}

// lifecycle/upgrade.ts (version upgrade)
export async function upgrade(ctx: LifecycleContext, fromVersion: string) {
  if (fromVersion < '1.0.0') {
    // Migrate old config format
    await migrateConfig(ctx);
  }
  ctx.logger.info(`Upgraded from ${fromVersion} to ${ctx.newVersion}`);
}
```

**Note:** Currently `setup-handler.ts` exists at root. Future plan: move to `lifecycle/setup.ts` and add `destroy.ts`, `upgrade.ts`, `enable.ts`, `disable.ts`.

## Extensibility Tips

1. **Start simple**: Add logic to `core/` first, refactor when complexity grows
2. **Keep surfaces thin**: CLI/REST/Studio should just adapt inputs/outputs
3. **Use manifest**: Declare everything in manifest, not runtime discovery
4. **Test core logic**: Unit test `core/`, integration test surfaces
5. **Document decisions**: Record significant changes in `docs/adr/`

## Migration from DDD Structure

If you have the old DDD structure (`domain/`, `application/`, `infra/`, `shared/`), see:
- [ADR-0009: Flatten Plugin Structure](./adr/0009-flatten-plugin-structure.md)
- [REFACTORING.md](./REFACTORING.md) - Step-by-step migration guide

---

**Last Updated:** 2025-11-30
**Related ADRs:**
- [ADR-0001: Architecture and Repository Layout](./adr/0001-architecture-and-repository-layout.md)
- [ADR-0009: Flatten Plugin Structure](./adr/0009-flatten-plugin-structure.md)
