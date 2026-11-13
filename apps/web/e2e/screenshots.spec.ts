// README screenshots (docs/screenshots/). Synthetic names only (DATA_POLICY.md). It rewrites tracked images, so it
// runs only on request:
//   WDB_SCREENSHOTS=1 pnpm e2e --project=chromium e2e/screenshots.spec.ts
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { admit, configureBeds, reconnect, resetDb, setUpTablet, startApi, stopApi } from './support.ts';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const viewport = { width: 1180, height: 820 }; // iPad Air, landscape

test.skip(!process.env.WDB_SCREENSHOTS, 'set WDB_SCREENSHOTS=1 to regenerate the README screenshots');
test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

/** Dialogs fade in; capture the settled frame. */
const settled = (p: Page) => p.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)));
const hhmmAgo = (min: number) => new Date(Date.now() - min * 60_000).toTimeString().slice(0, 5);

test('README screenshots', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for images');
  test.setTimeout(240_000);
  const a = await (await browser.newContext({ viewport })).newPage();
  const b = await (await browser.newContext({ viewport })).newPage();
  await setUpTablet(a, 'admin', 'Nurses station');
  await configureBeds(a, 12);
  await setUpTablet(b, 'nurse', 'Bay 2 tablet');
  await expect(b.getByRole('button', { name: 'Bed 12, empty' })).toBeVisible({ timeout: 20_000 });

  for (const [bed, name] of [[1, 'Rowan Ashby'], [2, 'Imani Calloway'], [3, 'Ola Brandt'], [5, 'Tobias Wren'], [7, 'Petra Lind'], [9, 'Kofi Mensah']] as const) await admit(a, bed, name);

  await a.getByRole('button', { name: /^Bed 2, Imani Calloway, / }).click();
  await a.getByLabel('New task').fill('Bed needs fresh linen');
  await a.getByLabel('Due at (optional)').fill(hhmmAgo(20)); // shortcut: just after midnight this is tomorrow, so not overdue
  await a.getByRole('button', { name: 'Add task' }).click();
  await a.waitForTimeout(700); // past the double-tap guard
  await a.getByLabel('New task').fill('Book porter for X-ray');
  await a.getByRole('button', { name: 'Add task' }).click();
  await a.getByLabel('New handoff note').fill('Family visiting after lunch; prefers the window side');
  await a.getByRole('button', { name: 'Add note' }).click();
  await expect(a.getByText('Family visiting after lunch; prefers the window side')).toBeVisible();
  await a.keyboard.press('Escape');

  // Two tablets offline both admit into bed 4: a conflict once they reconnect.
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await admit(a, 4, 'Mira Holt');
  await admit(b, 4, 'Jonah Pike');
  await reconnect(a);
  await reconnect(b);
  await expect(b.getByRole('button', { name: /^Bed 4, conflict: 2 patients/ })).toBeVisible({ timeout: 20_000 });

  // Tablet B goes offline again and admits into bed 6: pending until the server confirms it.
  await b.context().setOffline(true);
  await admit(b, 6, 'Sana Iqbal');
  await expect(b.getByRole('button', { name: /^Bed 2, Imani Calloway, 2 tasks, 1 overdue, 1 note, confirmed/ })).toBeVisible();
  await b.screenshot({ path: `${OUT}board-offline.png` });

  await b.setViewportSize({ width: 1180, height: 1500 }); // tall enough for the whole bed sheet
  await b.getByRole('button', { name: /^Bed 2, Imani Calloway, / }).click();
  await expect(b.getByText('Bed needs fresh linen')).toBeVisible();
  await settled(b);
  await b.getByRole('dialog').screenshot({ path: `${OUT}bed-sheet.png` });
  await b.keyboard.press('Escape');
  await b.setViewportSize(viewport);

  await a.getByRole('button', { name: /^Conflicts/ }).click();
  await a.getByRole('button', { name: 'Keep Mira Holt' }).click();
  await expect(a.getByRole('dialog')).toBeVisible();
  await settled(a);
  await a.screenshot({ path: `${OUT}resolve-conflict.png` });
  await a.keyboard.press('Escape');

  await b.getByRole('button', { name: 'My changes', exact: true }).click();
  await b.screenshot({ path: `${OUT}my-changes.png` });
  await a.context().close();
  await b.context().close();
});
