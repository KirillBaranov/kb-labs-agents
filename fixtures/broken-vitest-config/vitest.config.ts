import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
    },
  },
  resolve: {
    extensions: ['.ts', '.js', '.mts', '.mjs'],
    alias: {
      '@kb-labs/agent-contracts': '../../../packages/agent-contracts/src/index.ts',
    },
  },
});
