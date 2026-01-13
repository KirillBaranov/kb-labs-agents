# KB Labs Plugin Template Overview

The KB Labs Plugin Template provides a production-ready workspace for authoring plugins that expose CLI commands, REST endpoints, and KB Studio widgets. It demonstrates a pragmatic Domain-Driven Design layering model while embracing the tooling standards enforced across the KB ecosystem.

## Why this template exists

- **Consistency** – give plugin authors a repeatable folder layout, manifest shape, and quality bar.
- **Speed** – scaffold a working HelloWorld plugin with minimal work and evolve from there.
- **Education** – document best practices learned from existing plugins such as `kb-labs-mind` and `kb-labs-devlink`.

## What you get out of the box

- `packages/plugin-cli`: reference plugin package with manifest v2, CLI/REST/Studio layers, tests, and build scripts.
- `packages/contracts`: lightweight public contracts package describing artifacts, commands, workflows, and API guarantees (sections are optional—use only what your plugin ships).
- `docs/`: guides for extending each surface plus architectural conventions. Start with [`template-setup-guide.md`](./template-setup-guide.md) when creating a new plugin instance.
- `scripts/`: devkit sync wrapper and sandboxes (CLI, REST, Studio) for manual testing.
- `README.md`: quick start instructions and repository layout.

Use this repository as a blueprint for new plugins or fork it to create product-specific variations.

