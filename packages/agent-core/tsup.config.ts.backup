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
  // Mark tree-sitter as external (optional dependency)
  external: [
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-javascript',
    'tree-sitter-python',
    'tree-sitter-go',
    'tree-sitter-rust',
  ],
});
