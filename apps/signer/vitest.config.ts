import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/testkit.ts', '**/testing.ts'],
      // Floors sit a few points under coverage as measured by Vitest 5 (AST-aware v8 remapping,
      // which counts statements and branches differently from Vitest 3). Raise them as coverage grows.
      thresholds: { lines: 73, branches: 65, functions: 74, statements: 70 },
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
