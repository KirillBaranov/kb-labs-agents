# Template Setup Guide

This walkthrough assumes you clicked **“Use this template”** (or cloned the repo) and want to turn it into your own KB Labs plugin.

## 0. Prerequisites

- Node.js ≥ 20 and pnpm ≥ 9
- Access to the KB Labs DevKit repository (pulled automatically on `pnpm install`)

## 1. Rename the plugin

Pick a final package ID, e.g. `@kb-labs/my-awesome-plugin`. Update the following locations:

| File | What to change | Example |
| ---- | -------------- | ------- |
| `packages/plugin-cli/package.json` | `"name"` and references inside `"exports"`/`"kb"` | `@kb-labs/my-awesome-plugin` |
| `packages/plugin-cli/src/manifest.v2.ts` | `id`, display name/description if needed | `id: '@kb-labs/my-awesome-plugin'` |
| `packages/contracts/package.json` | `"name"` | `@kb-labs/my-awesome-plugin-contracts` |
| `packages/contracts/src/contract.ts` | `pluginId` | `pluginId: '@kb-labs/my-awesome-plugin'` |
| `packages/contracts/src/version.ts` | Bump `contractsVersion` if desired | `export const contractsVersion = '1.0.0'` |
| `tsconfig.paths.json` | Alias paths | `@kb-labs/my-awesome-plugin` + `@kb-labs/my-awesome-plugin-contracts` |
| Any docs/tests | Replace textual references to `plugin-template` |

> Tip: search for `plugin-template` and `template.hello` to catch leftovers.

## 2. Decide which surfaces you ship

The template enables CLI, REST, and Studio out of the box. Keep only what you need:

- **CLI only**: keep `src/cli` and related tests; remove `src/rest`, `src/studio`, and their exports/tests. Delete REST/Studio entries in `manifest.v2.ts`.
- **REST only**: keep `src/rest`; remove CLI/Studio directories + manifest sections; update sandbox scripts if desired.
- **Studio**: keep `src/studio`; remove other surfaces as needed.

Update `pluginContractsManifest` accordingly. Each missing surface can omit its section (`commands`, `workflows`, `api`) entirely.

### Optional: run the sample setup command

The manifest ships with a sandboxed `setup` handler so you can see how plugins provision `.kb/` assets. Try it once the repo is installed:

```bash
pnpm kb template:setup      # creates .kb/template assets + default config
pnpm kb template:setup --dry-run
pnpm kb template:setup --force
```

After you rename the plugin, update the setup handler (`src/setup/handler.ts`) to write the files and defaults your product needs. Adjust `manifest.v2.ts#setup.permissions` to match the new filesystem scope.

## 3. Define your contracts

1. Edit `packages/contracts/src/contract.ts` to describe real artifacts (files, logs, JSON payloads).
2. Add/adjust schemas in `packages/contracts/src/schema.ts` (or create new files) for inputs/outputs.
3. Reference those schema IDs from CLI/REST/Studio implementations to avoid hard-coded strings.
4. Update the README snippet in `packages/contracts/README.md` to reflect your use case.

## 4. Sync runtime code with contracts

- Replace the sample greeting logic with your own use-cases in `packages/plugin-cli/src/application` and `src/domain`.
- Ensure commands/handlers/studio widgets use IDs from `pluginContractsManifest`.
- Update tests in `packages/plugin-cli/tests` (CLI and REST) to match new behaviour. Keep assertions on artifacts if applicable.

## 5. Run checks

```bash
pnpm install               # triggers devkit sync – expect config updates on first run
pnpm build
pnpm test
pnpm --filter @kb-labs/my-awesome-plugin-contracts test
pnpm --filter @kb-labs/my-awesome-plugin-contracts type-check
pnpm --filter @kb-labs/my-awesome-plugin lint
```

> Seeing diffs after `pnpm install` is normal — DevKit sync realigns lint/ts configs. Commit those changes with your first scaffold commit.

## 6. Update documentation

- Replace template descriptions in `README.md`, `docs/overview.md`, and other guides to reflect your plugin’s purpose.
- Document how consumers should use your plugin (CLI flags, REST request fields, produced artifacts).

## 7. Optional extras

- Remove unused sandbox scripts in `scripts/sandbox`.
- Add CI workflows or package publishing scripts.
- Introduce additional packages under `packages/` if your plugin is split into multiple deployable pieces.

## 8. Keep DevKit up to date

- Bump `@kb-labs/devkit` versions in the root and package `package.json` files when a new release is published.
- Run `pnpm install` followed by `pnpm devkit:sync` (or `pnpm devkit:force` for a clean overwrite).
- Review and commit the updated lint/tsconfig/tooling files alongside the version bump.

## Reference: Where identifiers live

| Identifier | Purpose | Location |
| ---------- | ------- | -------- |
| `@kb-labs/<plugin>` | Main plugin package name | `packages/plugin-cli/package.json`, `manifest.v2.ts`, `tsconfig.paths.json`, tests/docs |
| `@kb-labs/<plugin>-contracts` | Contracts package name | `packages/contracts/package.json`, `tsconfig.paths.json`, imports across the repo |
| `template:hello` | Command ID example | `manifest.v2.ts`, `contract.ts`, CLI code/tests |
| `template.rest.hello` | REST route ID example | `contract.ts`, REST handler/tests |
| `template.hello.greeting` | Artifact ID example | `contract.ts`, CLI/REST logging/tests |

Review this table whenever you rename IDs to ensure consistency across contracts, manifest, implementation, and tests.

- Update `tsconfig.paths.json` by running `pnpm devkit:paths` after renaming packages so the workspace aliases point to the new paths (TypeScript uses it to resolve `@kb-labs/...` imports across repos).
- Keep documentation and README snippets consistent with the new naming, so future contributors immediately understand your plugin surface.

