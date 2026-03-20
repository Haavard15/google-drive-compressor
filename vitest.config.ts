import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/api/tests/**/*.test.ts',
      'packages/web/tests/**/*.test.ts',
      'packages/web/tests/**/*.test.tsx',
    ],
    pool: 'threads',
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/web/tests/**/*.test.ts', 'jsdom'],
      ['packages/web/tests/**/*.test.tsx', 'jsdom'],
    ],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
