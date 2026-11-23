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
      thresholds: { lines: 85, branches: 72, functions: 79, statements: 81 },
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Database tests create their own schema per file, so files may run in parallel.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
