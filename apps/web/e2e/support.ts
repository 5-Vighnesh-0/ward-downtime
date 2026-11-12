// E2E helpers: database reset, the ward server as a child process, and tablets set up through the real screens.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type Browser, type Page } from '@playwright/test';
import { readEntries } from '@wdb/server/src/entries.ts';
import { replay } from '@wdb/shared';
import { addStaffMember, approveDevice } from '@wdb/server/src/admin.ts';
import { createDb } from '@wdb/server/src/db.ts';
import type { Role } from '@wdb/shared';

export const ADMIN_URL = 'postgres://wdb_owner@127.0.0.1:55432/wdb_test';
export const OWNER_URL = 'postgres://wdb_owner@127.0.0.1:55432/wdb_e2e';
const APP_URL = 'postgres://wdb_app@127.0.0.1:55432/wdb_e2e';
export const PIN = '482913'; // same synthetic test PIN as the unit tests
const API_PORT = 3100;

export const owner = createDb(OWNER_URL);

export async function resetDb(): Promise<void> {
  await owner.pool.query('TRUNCATE events, audit_log, sessions, devices, staff RESTART IDENTITY CASCADE');
  await owner.pool.query(`UPDATE log_head SET last_seq = 0, last_hash = decode(repeat('00', 32), 'hex')`);
}

let api: ChildProcess | null = null;

/** Starts `node apps/server/src/main.ts`, the same entry point as production, and waits until it listens. */
export async function startApi(): Promise<void> {
  if (api) return;
  const main = fileURLToPath(new URL('../../server/src/main.ts', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, DATABASE_URL: APP_URL, WDB_ORIGIN: 'https://localhost:4173', PORT: String(API_PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  api = child;
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => String(d).includes('listening') && resolve());
    child.on('exit', (code) => reject(new Error(`api exited ${code}`)));
  });
}

export async function stopApi(): Promise<void> {
  const child = api;
  api = null;
  if (!child || child.exitCode !== null) return;
  await new Promise((r) => (child.once('exit', r), child.kill('SIGTERM')));
}

let staffSeq = 0;

/** Enroll in the UI, approve (bootstrap path), sign in with a new staff member. Leaves the page on the board. */
export async function setUpTablet(page: Page, role: Role = 'admin', label = 'Test tablet'): Promise<string> {
  const staffId = `S-${String(++staffSeq).padStart(4, '0')}`;
  await addStaffMember(owner.db, { staffId, role, displayName: `Test ${staffId}`, pin: PIN });
  await page.goto('/');
  await page.getByLabel('Tablet name').fill(label);
  await page.getByRole('button', { name: 'Ask to join the ward board' }).click();
  const code = (await page.getByText(/^[0-9A-Z]{4} [0-9A-Z]{4} [0-9A-Z]{4}$/).textContent())?.replace(/ /g, '');
  const { rows } = await owner.pool.query('SELECT device_id FROM devices WHERE fingerprint = $1', [code]);
  await approveDevice(owner.db, rows[0].device_id);
  await signIn(page, staffId);
  return staffId;
}

export async function signIn(page: Page, staffId: string): Promise<void> {
  await page.getByLabel('Staff ID').fill(staffId, { timeout: 15_000 });
  await page.getByLabel('PIN (6 to 8 digits)').fill(PIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Beds' })).toBeVisible({ timeout: 15_000 });
}

export async function unlock(page: Page): Promise<void> {
  await page.getByLabel('PIN (6 to 8 digits)').fill(PIN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Beds' })).toBeVisible();
}

export async function configureBeds(page: Page, n: number): Promise<void> {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByLabel('Number of beds (1 to 60)').fill(String(n));
  await page.getByRole('button', { name: 'Save beds' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: `Bed ${n}, empty` })).toBeVisible();
}

export async function admit(page: Page, bed: number, label: string): Promise<void> {
  await page.getByRole('button', { name: `Bed ${bed}, empty` }).click();
  await page.getByLabel('Patient name label').fill(label);
  await page.getByRole('button', { name: `Admit to bed ${bed}` }).click();
  await expect(page.getByRole('button', { name: new RegExp(`^Bed ${bed}, ${label}, `) })).toBeVisible();
}

export async function rename(page: Page, bed: number, from: string, to: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^Bed ${bed}, ${from}, `) }).click();
  await page.getByRole('button', { name: 'Change name label' }).click();
  await page.getByLabel('Patient name label').fill(to);
  await page.getByRole('button', { name: 'Save name label' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`^Bed ${bed}, ${to}, `) })).toBeVisible();
}

/** Each bed card's accessible name, in order: the board as the user sees it. */
export const boardOf = (page: Page) => page.getByRole('list').first().getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

/** Waits until the service worker controls the page, so the app shell loads offline. */
export const swReady = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.ready));

/** Back online, and the browser's `online` event makes the tablet send at once. */
export async function reconnect(page: Page): Promise<void> {
  await page.context().setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.getByText('Unsynced: 0', { exact: true })).toBeVisible({ timeout: 20_000 });
}

export const serverBoard = async () => replay(await readEntries(owner.db, 0, 1000));

/** A charge-capable tablet (admin) and a nurse tablet, both seeing 4 empty beds. */
export async function twoTablets(browser: Browser) {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await setUpTablet(a, 'admin', 'Tablet A');
  await configureBeds(a, 4);
  await setUpTablet(b, 'nurse', 'Tablet B');
  await expect(b.getByRole('button', { name: 'Bed 4, empty' })).toBeVisible();
  return { a, b };
}


/** Opens a screen from the tab bar. Retries, because the 600 ms double-tap guard ignores a second tap on the
 *  same tab sooner, which only a test is fast enough to do. */
export async function tab(page: Page, name: string): Promise<void> {
  const button = page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(async () => {
    await button.click();
    await expect(button.locator('[aria-current="page"]')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}
