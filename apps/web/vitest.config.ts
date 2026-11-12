import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'], // e2e/*.spec.ts belong to Playwright
    setupFiles: ['fake-indexeddb/auto'],
    globalSetup: './test/global-setup.ts',
    fileParallelism: false, // one shared test database
  },
});
