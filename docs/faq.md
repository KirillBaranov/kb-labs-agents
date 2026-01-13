# FAQ & Troubleshooting

## Build fails with “Cannot resolve @kb-labs/...”

The template expects sibling repositories (`kb-labs-plugin`, `kb-labs-shared`, `kb-labs-devkit`) to be available for local linking. Verify the relative paths in `packages/plugin-cli/package.json`, or replace them with published package versions if you prefer registry installs.

## `pnpm lint` complains about missing files in the project service

Make sure test files are included in `tsconfig.json`. The template already includes `tests` in the `include` array. If you move or rename directories, adjust the configuration accordingly.

## `tsc --noEmit` finds files outside `rootDir`

The template config removes explicit `rootDir` to avoid conflicts. If you reintroduce it, ensure it covers both `src` and `tests`, or move tests under `src/__tests__`.

## Sandbox scripts report “Build artifacts missing”

Run `pnpm --filter @kb-labs/plugin-template-cli run build` first. Sandboxes operate on compiled outputs in `packages/plugin-cli/dist/`.

## CLI command exits without output

The HelloWorld command prints to `stdout`. If you run it via Node directly, ensure `process.stdout` is not swapped out by your shell. Using the provided sandbox (`pnpm sandbox:cli`) mimics the plugin runtime behaviour.

## REST handler logs unexpected context

The sandbox passes `console.log` as the runtime logger. In the actual plugin runtime, `ctx.runtime.log` is provided by the host. To simulate production logs, adjust `scripts/sandbox/rest-sandbox.mjs`.

## Studio sandbox prints raw markup

`sandbox:studio` renders the widget using `react-dom/server` so you can inspect the structure quickly. For visual verification, import the component into a React playground and feed it the same props.

## Manifest change checklist

1. Update `src/manifest.v2.ts`.
2. Ensure new entries are listed in `tsup.config.ts`.
3. Adjust permissions and quotas as needed.
4. Add tests and sandbox examples if runtime behaviour changed.
5. Document the update in `docs/` (guides or ADRs).


