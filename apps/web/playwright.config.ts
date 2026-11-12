// E2E (design.md §12.3): the production build with its service worker, served by `vite preview`,
// in front of a real ward server that each test can stop and restart. One worker: one shared database.
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export const API_PORT = 3100;
export const CHROMIUM_ARGS = ['--ignore-certificate-errors']; // test browser only, for the throwaway E2E certificate

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0, // a pass on retry is reported as flaky, with its trace kept for upload
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'https://localhost:4173', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  projects: [
    // Chromium refuses to register a service worker over a self-signed certificate even with ignoreHTTPSErrors.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_ARGS } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'sh e2e/tls.sh && pnpm build && pnpm preview',
    url: 'https://localhost:4173',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    env: { WDB_API: `http://127.0.0.1:${API_PORT}`, WDB_TLS_DIR: fileURLToPath(new URL('e2e/.tls', import.meta.url)) },
  },
});
