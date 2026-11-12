import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['fake-indexeddb/auto'],
    globalSetup: './test/global-setup.ts',
    fileParallelism: false, // one shared test database
  },
});
