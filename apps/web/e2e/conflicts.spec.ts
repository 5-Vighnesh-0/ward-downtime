// prd.md §7 acceptance 1 (E2E-01, both reconnect orders) and 5 (E2E-05), design.md §12.8; FR-5 to FR-8.
import { expect, test } from '@playwright/test';
import { admit, boardOf, owner, reconnect, resetDb, serverBoard, startApi, stopApi, tab, twoTablets } from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

for (const order of ['A first', 'B first'] as const) {
  test(`E2E-01 (${order}): two offline admits to bed 4 become one conflict; the charge nurse keeps one (acceptance 1)`, async ({ browser }) => {
    const { a, b } = await twoTablets(browser);
    await a.context().setOffline(true);
    await b.context().setOffline(true);
    await admit(a, 4, 'Imani Calloway');
    await admit(b, 4, 'Rowan Ashby');

    for (const p of order === 'A first' ? [a, b] : [b, a]) await reconnect(p);
    const conflict = { name: 'Bed 4, conflict: 2 patients, charge nurse must choose' };
    for (const p of [a, b]) await expect(p.getByRole('button', conflict)).toBeVisible({ timeout: 20_000 });

    await a.getByRole('button', conflict).click();
    await a.getByRole('button', { name: 'Choose who stays' }).click();
    await expect(a.getByRole('heading', { name: 'Bed 4: 2 patients placed' })).toBeVisible();
    await a.getByRole('button', { name: 'Keep Imani Calloway' }).click();
    const dialog = a.getByRole('dialog');
    await expect(dialog.getByText('Rowan Ashby will move to Unplaced. This is recorded under your name.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep Imani Calloway' }).click();
    await expect(a.getByText(/^No conflicts\./)).toBeVisible();

    await a.getByRole('button', { name: 'Board', exact: true }).click();
    for (const p of [a, b]) await expect(p.getByRole('button', { name: 'Bed 4, Imani Calloway, confirmed' })).toBeVisible({ timeout: 20_000 });
    expect(await boardOf(a)).toEqual(await boardOf(b));

    // The losing admit stays in the log, marked rejected (FR-8), and the patient waits in Unplaced.
    const board = await serverBoard();
    const { rows } = await owner.pool.query("SELECT body->>'eventId' AS id FROM events WHERE body->'payload'->>'label' = 'Rowan Ashby'");
    expect(rows).toHaveLength(1);
    expect(board.outcomes[rows[0].id]).toMatchObject({ kind: 'rejected' });
    await b.getByRole('button', { name: 'Unplaced', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Admit Rowan Ashby to a bed' })).toBeVisible();
    await b.getByRole('button', { name: 'My changes', exact: true }).click();
    await expect(b.getByText(/^Not kept/)).toBeVisible();

    // E13: the unplaced patient goes to another bed under the same temp ID.
    await tab(b, 'Unplaced');
    await b.getByRole('button', { name: 'Admit Rowan Ashby to a bed' }).click();
    await b.getByRole('button', { name: 'Admit Rowan Ashby to Bed 2' }).click();
    await expect(b.getByText(/^Everyone has a bed\./)).toBeVisible();
    await b.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Bed 2, Rowan Ashby, confirmed' })).toBeVisible({ timeout: 20_000 });
    await a.context().close();
    await b.context().close();
  });
}

test('E2E-05: two tablets discharge the same patient offline; the second is harmless (acceptance 5)', async ({ browser }) => {
  const { a, b } = await twoTablets(browser);
  await admit(a, 1, 'Rowan Ashby');
  await expect(b.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible({ timeout: 20_000 });
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  for (const p of [a, b]) {
    await p.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' }).click();
    await p.getByRole('button', { name: 'Discharge' }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Discharge' }).click();
    await expect(p.getByRole('button', { name: /^Bed 1, Rowan Ashby, pending move or discharge$/ })).toBeVisible();
  }
  await reconnect(a);
  await reconnect(b);
  for (const p of [a, b]) await expect(p.getByRole('button', { name: 'Bed 1, empty' })).toBeVisible({ timeout: 20_000 });
  expect(Object.keys((await serverBoard()).conflicts)).toEqual([]);
  expect(await boardOf(a)).toEqual(await boardOf(b));
  await b.getByRole('button', { name: 'My changes', exact: true }).click();
  await expect(b.getByText('✓ Confirmed, no change. The patient was not in a bed, so nothing changed.')).toBeVisible();
  await a.context().close();
  await b.context().close();
});
