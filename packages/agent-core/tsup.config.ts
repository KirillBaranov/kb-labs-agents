import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'executor/index': 'src/executor/index.ts',
    'tools/index': 'src/tools/index.ts',
    'registry/index': 'src/registry/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
