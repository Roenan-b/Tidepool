import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['lib/**/*.ts', 'app/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/testkit.ts', '**/testing.ts'],
      // Floors sit a few points under coverage as measured by Vitest 5 (AST-aware v8 remapping,
      // which counts statements and branches differently from Vitest 3). Raise them as coverage grows.
      thresholds: { lines: 60, branches: 57, functions: 61, statements: 58 },
    },
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
