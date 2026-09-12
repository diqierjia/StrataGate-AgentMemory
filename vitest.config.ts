import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@diqier/stratagate/sqlite', replacement: fileURLToPath(new URL('./packages/core/src/sqlite.ts', import.meta.url)) },
      { find: '@diqier/stratagate', replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
