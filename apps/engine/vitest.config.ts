import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Database tests create their own schema per file, so files may run in parallel.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
