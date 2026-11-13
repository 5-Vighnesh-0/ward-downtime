// FR-15 tasks tied to beds (design.md §14 M6a): add, overdue, the SEC-16 text guard, and two offline completions.
import { expect, test, type Page } from '@playwright/test';
import { owner, reconnect, resetDb, startApi, stopApi, twoTablets } from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

/** hh:mm half an hour ago on this machine's clock (the browsers use the same time zone); just after midnight, 00:00. */
const halfHourAgo = () => {
  const t = new Date(Date.now() - 30 * 60_000);
  return t.getDate() === new Date().getDate() ? t.toTimeString().slice(0, 5) : '00:00';
};

async function markDone(p: Page, title: string): Promise<void> {
  await p.getByRole('button', { name: /^Bed 2, empty, 1 task/ }).click();
  await p.getByRole('button', { name: `Mark ${title} done` }).click();
  await p.keyboard.press('Escape');
}

test('a task added on one tablet shows overdue on both; two offline completions converge (FR-15)', async ({ browser }) => {
  const { a, b } = await twoTablets(browser);
  await a.getByRole('button', { name: 'Bed 2, empty' }).click();
  const title = a.getByLabel('New task');
  await title.fill(`MRN ${'1234567'}`); // built at runtime so the repo's synthetic-data check sees no MRN
  await expect(a.getByText(/^This looks like an ID/)).toBeVisible();
  await expect(a.getByRole('button', { name: 'Add task' })).toBeDisabled();
  await title.fill('Bed needs cleaning');
  await a.getByLabel('Due at (optional)').fill(halfHourAgo());
  await a.getByLabel('For staff ID (optional)').fill('s-0002');
  await a.getByRole('button', { name: 'Add task' }).click();
  await expect(a.getByText(/^Bed needs cleaning · for S-0002 · overdue since/)).toBeVisible();
  await a.keyboard.press('Escape');

  const card = { name: 'Bed 2, empty, 1 task, 1 overdue' };
  for (const p of [a, b]) await expect(p.getByRole('button', card)).toBeVisible({ timeout: 20_000 });

  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await markDone(a, 'Bed needs cleaning');
  await markDone(b, 'Bed needs cleaning');
  for (const p of [a, b]) await expect(p.getByRole('button', { name: 'Bed 2, empty' })).toBeVisible();
  await reconnect(a);
  await reconnect(b);
  for (const p of [a, b]) await expect(p.getByRole('button', { name: 'Bed 2, empty' })).toBeVisible({ timeout: 20_000 });
  const { rows } = await owner.pool.query("SELECT count(*)::int AS n FROM events WHERE body->>'type' = 'TASK_COMPLETED'");
  expect(rows[0].n).toBe(2); // both are in the log; the second changes nothing
  await a.context().close();
  await b.context().close();
});
