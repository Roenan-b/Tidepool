import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/testkit.ts', '**/testing.ts'],
      // Floors set a few points under current coverage; raise them as coverage grows.
      thresholds: { lines: 85, branches: 75, functions: 85, statements: 85 },
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Database tests create their own schema per file, so files may run in parallel.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
