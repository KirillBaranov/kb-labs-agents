import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    '@kb-labs/agent-core',
    '@kb-labs/agent-contracts',
    '@kb-labs/agent-tools',
    '@kb-labs/sdk',
  ],
});
