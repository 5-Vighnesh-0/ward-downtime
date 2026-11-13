// A11Y-01 axe on every screen, A11Y-02 keyboard-only E2E-01, and the board filters (design.md §10.2, §10.5, §12.8).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { admit, reconnect, resetDb, setUpTablet, startApi, stopApi, tab, twoTablets } from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

/** Serious and critical WCAG 2.2 A/AA violations on the page as it is now (A11Y-01 allows none). */
async function axe(page: Page, screen: string): Promise<string[]> {
  // The dialog fades in over 150 ms; mid-fade colours would fail contrast though the settled ones pass.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${screen}: ${v.id} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

test('A11Y-01: axe finds no serious or critical issue on any screen', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'the DOM is the same in every browser; one engine is enough for axe');
  const found: string[] = [];
  const enroll = await (await browser.newContext()).newPage();
  await enroll.goto('/');
  found.push(...(await axe(enroll, 'enroll')));
  await enroll.context().close();

  const { a, b } = await twoTablets(browser);
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await admit(a, 4, 'Imani Calloway');
  await admit(b, 4, 'Rowan Ashby');
  found.push(...(await axe(a, 'board, offline with a pending change')));
  await reconnect(a);
  await reconnect(b);
  const conflict = a.getByRole('button', { name: 'Bed 4, conflict: 2 patients, charge nurse must choose' });
  await expect(conflict).toBeVisible({ timeout: 20_000 });
  found.push(...(await axe(a, 'board with a conflict')));
  await a.getByRole('button', { name: 'Bed 1, empty' }).click();
  found.push(...(await axe(a, 'bed sheet')));
  await a.keyboard.press('Escape');
  await tab(a, 'Conflicts');
  found.push(...(await axe(a, 'conflicts')));
  await a.getByRole('button', { name: 'Keep Imani Calloway' }).click();
  found.push(...(await axe(a, 'resolve dialog')));
  await a.getByRole('dialog').getByRole('button', { name: 'Keep Imani Calloway' }).click();
  await expect(a.getByText(/^No conflicts\./)).toBeVisible();
  for (const screen of ['Unplaced', 'My changes', 'Recovery', 'Audit', 'Admin']) {
    await tab(a, screen);
    await expect(a.getByRole('heading', { level: 1 })).toBeVisible();
    found.push(...(await axe(a, screen)));
  }
  await tab(b, 'Unplaced');
  await expect(b.getByRole('button', { name: 'Admit Rowan Ashby to a bed' })).toBeVisible({ timeout: 20_000 });
  found.push(...(await axe(b, 'unplaced with a patient')));
  await a.getByRole('button', { name: 'Lock' }).click();
  found.push(...(await axe(a, 'lock')));
  await b.getByRole('button', { name: 'Sign out' }).click();
  await expect(b.getByLabel('Staff ID')).toBeVisible();
  found.push(...(await axe(b, 'sign-in')));
  expect(found).toEqual([]);
  await a.context().close();
  await b.context().close();
});

/** Tab (forwards) until the focused element is `name`, checking each stop has a visible focus indicator. */
async function tabTo(page: Page, name: string | RegExp): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const now = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const label = el instanceof HTMLInputElement ? (el.labels?.[0]?.textContent ?? '') : '';
      return { name: (el.getAttribute('aria-label') ?? label ?? '') || (el.textContent ?? '').trim(), ring: s.outlineStyle !== 'none' && s.outlineWidth !== '0px' };
    });
    if (!now) continue;
    expect(now.ring, `focus ring on "${now.name}"`).toBe(true); // WCAG 2.4.7
    if (typeof name === 'string' ? now.name === name : name.test(now.name)) return;
  }
  throw new Error(`Tab never reached ${String(name)}`);
}

async function keyboardAdmit(page: Page, bed: number, label: string): Promise<void> {
  await tabTo(page, `Bed ${bed}, empty`);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Patient name label')).toBeFocused(); // the sheet starts on its field
  await page.keyboard.type(label);
  await page.keyboard.press('Enter'); // submits the form
  await expect(page.getByRole('button', { name: new RegExp(`^Bed ${bed}, ${label}, `) })).toBeVisible();
}

test('A11Y-02: E2E-01 by keyboard only: two offline admits become a conflict and the charge nurse keeps one', async ({ browser, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons unless the macOS "keyboard navigation" setting is on');
  const { a, b } = await twoTablets(browser); // setup (enroll, sign-in) uses the usual helpers
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await keyboardAdmit(a, 4, 'Imani Calloway');
  await keyboardAdmit(b, 4, 'Rowan Ashby');
  await reconnect(a);
  await reconnect(b);
  const conflict = 'Bed 4, conflict: 2 patients, charge nurse must choose';
  await expect(a.getByRole('button', { name: conflict })).toBeVisible({ timeout: 20_000 });

  await a.locator('body').focus();
  await tabTo(a, conflict);
  await a.keyboard.press('Enter');
  await tabTo(a, 'Choose who stays');
  await a.keyboard.press('Enter');
  await expect(a.getByRole('heading', { name: 'Bed 4: 2 patients placed' })).toBeVisible();
  await tabTo(a, 'Keep Imani Calloway');
  await a.keyboard.press('Enter');
  const dialog = a.getByRole('dialog');
  await expect(dialog.getByText('Rowan Ashby will move to Unplaced. This is recorded under your name.')).toBeVisible();
  await tabTo(a, 'Keep Imani Calloway'); // focus is trapped in the dialog, so this is its confirm button
  await expect(dialog.getByRole('button', { name: 'Keep Imani Calloway' })).toBeFocused();
  await a.keyboard.press('Enter');
  await expect(a.getByText(/^No conflicts\./)).toBeVisible();
  await tabTo(a, 'Board');
  await a.keyboard.press('Enter');
  for (const p of [a, b]) await expect(p.getByRole('button', { name: 'Bed 4, Imani Calloway, confirmed' })).toBeVisible({ timeout: 20_000 });
  await a.context().close();
  await b.context().close();
});

test('board filters show only the matching beds, with counts', async ({ page }) => {
  await setUpTablet(page);
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByLabel('Number of beds (1 to 60)').fill('3');
  await page.getByRole('button', { name: 'Save ward settings' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await admit(page, 1, 'Rowan Ashby');
  const filters = page.getByRole('group', { name: 'Show beds' });
  await expect(page.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible();
  await filters.getByRole('button', { name: 'Empty (2)' }).click();
  await expect(filters.getByRole('button', { name: 'Empty (2)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Bed 1,/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bed 3, empty' })).toBeVisible();
  await page.waitForTimeout(700); // past the double-tap guard
  await filters.getByRole('button', { name: 'Conflict (0)' }).click();
  await expect(page.getByText('No beds match this filter.')).toBeVisible();
  await page.waitForTimeout(700);
  await filters.getByRole('button', { name: 'Occupied (1)' }).click();
  await expect(page.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: /empty$/ })).toHaveCount(0);
});
