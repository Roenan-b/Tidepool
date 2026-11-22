import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/testkit.ts', '**/testing.ts'],
      // Floors set a few points under current coverage; raise them as coverage grows.
      thresholds: { lines: 75, branches: 75, functions: 90, statements: 75 },
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
