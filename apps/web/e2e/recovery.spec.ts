// prd.md §7 acceptance 6 (E2E-06) and E2E-07's import half (design.md §8.4, §12.8; FR-11, FR-12, SEC-15).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openWdbx } from '@wdb/server/src/wdbx.ts';
import { admit, owner, reconnect, resetDb, startApi, stopApi, tab, twoTablets } from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

const PASS = 'ward downtime test passphrase';

async function exportFrom(page: Page): Promise<{ name: string; files: Record<string, string> }> {
  await tab(page, 'Recovery');
  await page.getByLabel('Passphrase (at least 12 characters)').fill(PASS);
  await page.waitForTimeout(700); // the same button may have been tapped < 600 ms ago (double-tap guard)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Create recovery export' }).click()]);
  return { name: download.suggestedFilename(), files: openWdbx(readFileSync((await download.path()) ?? '', 'utf8'), PASS) };
}

test('E2E-06: the recovery export holds applied changes only, with original tablet times and temp IDs (acceptance 6)', async ({ browser }) => {
  const { a, b } = await twoTablets(browser);
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await admit(a, 4, 'Imani Calloway');
  await admit(b, 4, 'Rowan Ashby');
  await reconnect(a);
  await reconnect(b);
  await admit(a, 1, 'Mira Holt');

  // An open conflict is warned about before exporting.
  await tab(a, 'Recovery');
  await a.getByLabel('Passphrase (at least 12 characters)').fill(PASS);
  await a.getByRole('button', { name: 'Create recovery export' }).click();
  await expect(a.getByText('1 conflict is still open. The export will list it as unresolved.')).toBeVisible();
  await a.getByRole('button', { name: 'Resolve first' }).click();

  await tab(a, 'Conflicts');
  await a.getByRole('button', { name: 'Keep Imani Calloway' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Keep Imani Calloway' }).click();
  await expect(a.getByText(/^No conflicts\./)).toBeVisible();

  const { name, files } = await exportFrom(a);
  expect(name).toMatch(/^recovery-\d+\.wdbx$/);
  const r = JSON.parse(files['recovery.json'] ?? '');
  expect(r.source).toBe('server');
  expect(r.openConflicts).toEqual([]);
  expect(r.events.map((e: { label: string }) => e.label).sort()).toEqual(['Imani Calloway', 'Mira Holt']); // Rowan was not kept
  const { rows } = await owner.pool.query("SELECT body->>'eventId' AS id, body->>'clientTime' AS t FROM events WHERE body->>'type' = 'ADMIT'");
  const deviceTime = new Map(rows.map((x: { id: string; t: string }) => [x.id, x.t]));
  for (const e of r.events) {
    expect(e.patientId).toMatch(/^T-[A-Z0-9]{3}-\d{4}$/);
    expect(e.clientTime).toBe(deviceTime.get(e.eventId)); // the tablet's own time, unchanged
  }
  const csv = (files['recovery.csv'] ?? '').split('\r\n');
  expect(csv[0]).toMatch(/^# SYNTHETIC DATA - CONFIDENTIAL - WARD DOWNTIME RECOVERY EXPORT - upToSeq=\d+$/);
  expect(csv.filter((l) => l.includes('Rowan Ashby'))).toEqual([]);
  await expect(a.getByText(/^Saved recovery-\d+\.wdbx\./)).toBeVisible();

  // Server down: the same export is built from the tablet's own copy of the log.
  await stopApi();
  const fromTablet = await exportFrom(a);
  expect(fromTablet.name).toMatch(/^recovery-\d+-tablet\.wdbx$/);
  const t = JSON.parse(fromTablet.files['recovery.json'] ?? '');
  expect(t.source).toBe('device');
  expect(t.events.map((e: { eventId: string }) => e.eventId)).toEqual(r.events.map((e: { eventId: string }) => e.eventId));
  await expect(a.getByText(/made from this tablet’s copy of the log/)).toBeVisible();
  await a.context().close();
  await b.context().close();
});

test('E2E-07 (import): an admin imports a tablet’s saved file and the changes reach every board (FR-12)', async ({ browser }) => {
  const { a, b } = await twoTablets(browser);
  await b.context().setOffline(true);
  await admit(b, 3, 'Ola Brandt');
  await tab(b, 'My changes');
  await b.getByLabel('Passphrase (at least 12 characters)').fill(PASS);
  const [download] = await Promise.all([b.waitForEvent('download'), b.getByRole('button', { name: 'Save to file' }).click()]);
  const saved = test.info().outputPath('unsynced.wdbx');
  await download.saveAs(saved);
  await b.context().close(); // the tablet is lost; only the file is left

  await tab(a, 'Recovery');
  await a.getByLabel('Saved tablet file (.wdbx)').setInputFiles(saved);
  await a.getByLabel('Passphrase used when the file was saved').fill(PASS);
  await a.getByRole('button', { name: 'Import changes' }).click();
  await expect(a.getByText('Imported. appended: 1')).toBeVisible();
  await tab(a, 'Board');
  await expect(a.getByRole('button', { name: 'Bed 3, Ola Brandt, confirmed' })).toBeVisible({ timeout: 20_000 });
  const { rows } = await owner.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'QUEUE_IMPORT'");
  expect(rows[0].n).toBe(1);
  await a.context().close();
});
