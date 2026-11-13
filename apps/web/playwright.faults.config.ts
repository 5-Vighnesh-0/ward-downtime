// FI-01 to FI-05 (design.md §12.4): the same E2E setup with Toxiproxy between the app and the ward server.
// Run with `pnpm e2e:faults` (needs Docker). Chromium only: the faults are in the network, not the browser.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

const web = base.webServer as { env?: Record<string, string> } & Exclude<typeof base.webServer, unknown[] | undefined>; // one web server in the base config

export const TOXIPROXY_PORT = 3101;

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: 'faults.spec.ts',
  timeout: 240_000,
  projects: base.projects?.filter((p) => p.name === 'chromium') ?? [],
  globalSetup: ['./e2e/global-setup.ts', './e2e/toxiproxy.ts'],
  webServer: { ...web, env: { ...web.env, WDB_API: `http://127.0.0.1:${TOXIPROXY_PORT}` } },
});
