import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['lib/**/*.ts', 'app/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/testkit.ts', '**/testing.ts'],
      // Floors set a few points under current coverage; raise them as coverage grows.
      thresholds: { lines: 60, branches: 85, functions: 80, statements: 60 },
    },
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
