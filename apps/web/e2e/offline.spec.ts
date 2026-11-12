// prd.md §7 acceptance scenarios 2–4 and design.md E2E-07/08, on Chromium, Firefox and WebKit (§12.3, §12.8).
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHROMIUM_ARGS } from '../playwright.config.ts';
import {
  admit, boardOf, configureBeds, owner, rename, resetDb, setUpTablet, startApi, stopApi, swReady, unlock,
} from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

const unsynced = (page: Page, n: number) => expect(page.getByText(`Unsynced: ${n}`, { exact: true })).toBeVisible();

test('E2E-02: 5 offline changes survive closing the browser, then confirm when back online (acceptance 2)', async ({ playwright, browserName }) => {
  const dir = mkdtempSync(join(tmpdir(), 'wdb-e2e-'));
  const launch = (offline = false) =>
    playwright[browserName].launchPersistentContext(dir, {
      baseURL: 'https://localhost:4173',
      ignoreHTTPSErrors: true,
      offline,
      ...(browserName === 'chromium' ? { args: CHROMIUM_ARGS } : {}),
    });
  let ctx: BrowserContext = await launch();
  try {
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    await setUpTablet(page);
    await configureBeds(page, 4);
    await swReady(page);
    await ctx.setOffline(true);
    for (const [bed, label] of [[1, 'Rowan Ashby'], [2, 'Mira Holt'], [3, 'Ola Brandt'], [4, 'Ines Varga']] as const) await admit(page, bed, label);
    await rename(page, 1, 'Rowan Ashby', 'Rowan A');
    await unsynced(page, 5);
    await ctx.close();

    ctx = await launch(true); // reopened while still offline: the shell comes from the service worker
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('/');
    await unlock(page); // starts locked; the PIN is checked on the device
    await page.getByRole('button', { name: 'My changes', exact: true }).click();
    await expect(page.getByText('Pending: not yet sent')).toHaveCount(5);
    await ctx.setOffline(false);
    await expect(page.getByText('Nothing waiting. All changes from this tablet are confirmed.')).toBeVisible({ timeout: 5_000 });
    const { rows } = await owner.pool.query("SELECT count(*)::int AS n FROM events WHERE body->>'type' IN ('ADMIT', 'RENAME')");
    expect(rows[0].n).toBe(5);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe('E2E-03', () => {
  test.use({ serviceWorkers: 'block' }); // so page.route sees every request
  test('the same push sent 3 times is appended once (acceptance 3)', async ({ page }) => {
    await setUpTablet(page);
    await configureBeds(page, 2);
    const statuses: string[] = [];
    await page.route('**/api/v1/events', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      let last = await route.fetch();
      statuses.push(...((await last.json()) as { results: { status: string }[] }).results.map((r) => r.status));
      for (let i = 1; i < 3; i++) {
        last = await route.fetch();
        statuses.push(...((await last.json()) as { results: { status: string }[] }).results.map((r) => r.status));
      }
      await route.fulfill({ response: last });
    });
    await admit(page, 1, 'Rowan Ashby');
    await unsynced(page, 0);
    await expect.poll(() => statuses).toEqual(['appended', 'duplicate', 'duplicate']); // SSE may confirm before the reply
    const { rows } = await owner.pool.query("SELECT count(*)::int AS n FROM events WHERE body->>'type' = 'ADMIT'");
    expect(rows[0].n).toBe(1);
  });
});

test('E2E-04: ward server down; two tablets keep working; after restart both converge (acceptance 4)', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await setUpTablet(a, 'admin', 'Tablet A');
  await configureBeds(a, 4);
  await setUpTablet(b, 'nurse', 'Tablet B');
  await expect(b.getByRole('button', { name: 'Bed 4, empty' })).toBeVisible();
  await stopApi();
  await admit(a, 1, 'Rowan Ashby');
  await admit(b, 2, 'Mira Holt');
  for (const p of [a, b]) {
    await expect(p.getByText(/^Working offline\./)).toBeVisible();
    await expect(p.getByRole('button', { name: /pending, not yet confirmed by ward server$/ })).toBeVisible();
  }
  await startApi();
  for (const p of [a, b]) {
    await p.evaluate(() => dispatchEvent(new Event('online'))); // what the browser fires when the network returns
    await unsynced(p, 0);
  }
  // A stream that went silent when the server died is dropped after 45 s and reopened (or a 15 s poll gets there first).
  await expect(a.getByRole('button', { name: 'Bed 2, Mira Holt, confirmed' })).toBeVisible({ timeout: 70_000 });
  await expect(b.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible({ timeout: 70_000 });
  expect(await boardOf(a)).toEqual(await boardOf(b));
  await a.context().close();
  await b.context().close();
});

test('E2E-07: unsent changes are saved to an encrypted file that opens with the passphrase (FR-12, SEC-15)', async ({ page, context }) => {
  await setUpTablet(page);
  await configureBeds(page, 2);
  await context.setOffline(true);
  await admit(page, 1, 'Rowan Ashby');
  await page.getByRole('button', { name: 'My changes', exact: true }).click();
  const passphrase = 'ward downtime test passphrase';
  await page.getByLabel('Passphrase (at least 12 characters)').fill(passphrase);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save to file' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^unsynced-Test-tablet-\d+-\d+\.wdbx$/);
  const box = JSON.parse(readFileSync((await download.path()) ?? '', 'utf8'));
  const key = pbkdf2Sync(passphrase, Buffer.from(box.salt, 'base64url'), box.iterations, 32, 'sha256');
  const data = Buffer.from(box.ciphertext, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'), { authTagLength: 16 });
  d.setAuthTag(data.subarray(-16));
  const files = JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString());
  const unsent = JSON.parse(files['unsynced.json']);
  expect(unsent.events).toEqual([expect.objectContaining({ type: 'ADMIT', payload: expect.objectContaining({ label: 'Rowan Ashby' }) })]);
  expect(JSON.stringify(box)).not.toContain('Rowan'); // nothing readable without the passphrase
});

test('E2E-08: idle lock after 5 minutes, unlocked offline with the PIN (SEC-7)', async ({ page, context }) => {
  await page.clock.install();
  const staffId = await setUpTablet(page);
  await context.setOffline(true);
  await page.clock.fastForward('04:31');
  await expect(page.getByText('Locking in 30 seconds')).toBeVisible();
  await page.clock.fastForward('00:30');
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await expect(page.getByText(`Signed in as ${staffId}`)).toBeVisible();
  await page.getByLabel('PIN (6 to 8 digits)').fill('000000');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('PIN not recognised. 4 tries left')).toBeVisible();
  await page.waitForTimeout(700); // past the 600 ms double-tap guard, as a person retyping would be
  await unlock(page);
});
