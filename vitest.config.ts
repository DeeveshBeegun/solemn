import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'apps/*/tests/**/*.test.ts',
            'packages/*/tests/**/*.test.ts',
          ],
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/database/tests/**/*.integration.test.ts',
            'apps/worker/tests/**/*.integration.test.ts',
          ],
          fileParallelism: false,
          testTimeout: 15000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
