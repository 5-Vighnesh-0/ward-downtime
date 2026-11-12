// E2E smoke: enroll → approve → sign in → set up beds → admit, confirmed by the ward server.
import { expect, test } from '@playwright/test';
import { admit, configureBeds, resetDb, setUpTablet, startApi, stopApi } from './support.ts';

test.beforeEach(async () => {
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

test('a tablet joins the ward and admits a patient', async ({ page }) => {
  await setUpTablet(page);
  await configureBeds(page, 4);
  await admit(page, 1, 'Rowan Ashby');
  await expect(page.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible();
  await expect(page.getByText('Unsynced: 0')).toBeVisible();
});
