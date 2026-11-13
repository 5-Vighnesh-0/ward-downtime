// FI-01 to FI-05 (design.md §12.4): network faults between tablets and the ward server, via Toxiproxy.
import { expect, test } from '@playwright/test';
import { readEntries } from '@wdb/server/src/entries.ts';
import { verifyChain } from '@wdb/server/src/verify-chain.ts';
import { addDevice, addStaff, sessionCookie, signed, type TestDevice } from '@wdb/server/test/support.ts';
import { admit, boardOf, configureBeds, owner, resetDb, setUpTablet, startApi, stopApi } from './support.ts';
import { addToxic, removeToxic, resetToxics } from './toxiproxy.ts';

const PROXY = 'http://127.0.0.1:3101'; // what tablets reach; 3100 is the server itself

test.beforeEach(async () => {
  await resetToxics();
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(async () => {
  await resetToxics();
  await stopApi();
});

const count = async (where = 'true') => (await owner.pool.query(`SELECT count(*)::int AS n FROM events WHERE ${where}`)).rows[0].n as number;

/** A scripted tablet: a device row, an active session, and signed pushes straight through the proxy. */
async function scriptedDevices(n: number): Promise<{ d: TestDevice; cookie: string; staffId: string }[]> {
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const staffId = `S-${String(5000 + i).padStart(4, '0')}`;
      await addStaff(owner.pool, staffId, 'nurse');
      const d = await addDevice(owner.pool);
      return { d, cookie: await sessionCookie(owner.pool, staffId, d.deviceId), staffId };
    }),
  );
}

/** Push until accepted: on 429/503 wait Retry-After, on a dropped connection or 502 retry. Same events each time. */
async function pushUntilAccepted(dev: { d: TestDevice; cookie: string }, events: object[], seen: number[]): Promise<void> {
  for (;;) {
    const res = await fetch(`${PROXY}/api/v1/events`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- test traffic to 127.0.0.1; the server is plain HTTP behind Caddy by design
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wdb-request': '1', cookie: dev.cookie },
      body: JSON.stringify({ deviceId: dev.d.deviceId, events }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    seen.push(res?.status ?? 0);
    if (res?.ok) return;
    const wait = Number(res?.headers.get('retry-after') ?? 0);
    await new Promise((r) => setTimeout(r, wait ? wait * 1000 : 250));
  }
}

test('FI-01: 3 s latency (±1 s): the change shows Pending until acknowledged, and is stored once', async ({ page }) => {
  await setUpTablet(page);
  await configureBeds(page, 2);
  await addToxic('slow', 'latency', 'downstream', { latency: 3000, jitter: 1000 });
  await admit(page, 1, 'Rowan Ashby');
  await expect(page.getByRole('button', { name: /^Bed 1, Rowan Ashby, pending/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible({ timeout: 30_000 });
  expect(await count("body->>'type' = 'ADMIT'")).toBe(1);
});

test('FI-02: the reply is lost after the server committed; the change is in the log once and later changes still go', async ({ page }) => {
  await setUpTablet(page);
  await configureBeds(page, 2);
  // design.md FI-02: timeout 0 drops every reply and never closes the connection; only the tablet's own
  // request timeout (30 s) gets it out of the hung push.
  await addToxic('lost', 'timeout', 'downstream', { timeout: 0 });
  await page.getByRole('button', { name: 'Bed 1, empty' }).click();
  await page.getByLabel('Patient name label').fill('Rowan Ashby');
  await page.getByRole('button', { name: 'Admit to bed 1' }).click();
  await expect.poll(() => count("body->>'type' = 'ADMIT'"), { timeout: 30_000 }).toBe(1); // committed, unacknowledged
  await expect(page.getByRole('button', { name: /^Bed 1, Rowan Ashby, pending/ })).toBeVisible();
  await removeToxic('lost'); // new connections work; the hung push still waits for its timeout
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Bed 1, Rowan Ashby, confirmed' })).toBeVisible({ timeout: 60_000 }); // via pull
  // Pushes go one at a time, so a later change only gets through once the hung push gives up.
  await admit(page, 2, 'Mira Holt');
  await expect(page.getByRole('button', { name: 'Bed 2, Mira Holt, confirmed' })).toBeVisible({ timeout: 60_000 });
  expect(await count("body->>'type' = 'ADMIT'")).toBe(2); // the first change is in the log once
});

test('FI-03: connections reset mid-stream; the tablet resumes and misses nothing', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await setUpTablet(a, 'admin', 'Tablet A');
  await configureBeds(a, 4);
  await setUpTablet(b, 'nurse', 'Tablet B');
  await expect(b.getByRole('button', { name: 'Bed 4, empty' })).toBeVisible();
  await addToxic('reset', 'reset_peer', 'downstream', { timeout: 0 });
  await admit(b, 2, 'Mira Holt');
  await admit(b, 3, 'Ola Brandt');
  await new Promise((r) => setTimeout(r, 3000));
  await removeToxic('reset');
  for (const p of [a, b]) await p.evaluate(() => dispatchEvent(new Event('online')));
  await expect(a.getByRole('button', { name: 'Bed 3, Ola Brandt, confirmed' })).toBeVisible({ timeout: 40_000 });
  await expect(a.getByRole('button', { name: 'Bed 2, Mira Holt, confirmed' })).toBeVisible();
  expect(await boardOf(a)).toEqual(await boardOf(b));
  await a.context().close();
  await b.context().close();
});

test('FI-04: 20 tablets push hard over a 10 KB/s link; they get 429 with Retry-After, the server stays up, all converge', async () => {
  const devices = await scriptedDevices(20);
  await addToxic('thin', 'bandwidth', 'downstream', { rate: 10 }); // KB/s per connection
  const statuses: number[] = [];
  const PER_DEVICE = 65; // over the 60 pushes a minute each tablet may send
  const health = setInterval(() => void fetch('http://127.0.0.1:3100/api/v1/stream').then((r) => statuses.push(r.status === 401 ? -1 : -2)), 2000); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- test traffic to 127.0.0.1; the server is plain HTTP behind Caddy by design
  try {
    await Promise.all(
      devices.map(async (dev) => {
        for (let i = 1; i <= PER_DEVICE; i++) {
          const e = signed(dev.d, 'RENAME', { patientId: `T-FLT-${String(i).padStart(4, '0')}`, label: `Fault ${i}` }, { staffId: dev.staffId });
          await pushUntilAccepted(dev, [{ ...e }], statuses);
        }
      }),
    );
  } finally {
    clearInterval(health);
  }
  expect(statuses).toContain(429);
  expect(statuses).toContain(-1); // the server kept answering throughout (401: alive, just not signed in)
  expect(statuses).not.toContain(-2);
  expect(await count()).toBe(20 * PER_DEVICE);
  expect(await verifyChain(owner.db)).toMatchObject({ ok: true, headSeq: 20 * PER_DEVICE });
});

test('FI-05: the ward server restarts while tablets push; nothing is lost or doubled and the chain verifies', async () => {
  const devices = await scriptedDevices(5);
  const statuses: number[] = [];
  const pushing = Promise.all(
    devices.map(async (dev) => {
      for (let batch = 0; batch < 8; batch++) {
        const events = Array.from({ length: 5 }, (_, k) => signed(dev.d, 'RENAME', { patientId: `T-FLT-${String(batch * 5 + k + 1).padStart(4, '0')}`, label: 'Restart' }, { staffId: dev.staffId }));
        await pushUntilAccepted(dev, events, statuses);
        await new Promise((r) => setTimeout(r, 100));
      }
    }),
  );
  await new Promise((r) => setTimeout(r, 600));
  await stopApi(); // mid-push
  await new Promise((r) => setTimeout(r, 1500));
  await startApi();
  await pushing;
  expect(statuses.some((s) => s === 0 || s >= 500)).toBe(true); // the outage was seen
  expect(await count()).toBe(5 * 8 * 5);
  const entries = await readEntries(owner.db, 0, 1000);
  expect(new Set(entries.map((e) => e.event.eventId)).size).toBe(entries.length);
  expect(await verifyChain(owner.db)).toMatchObject({ ok: true, headSeq: 200 });
});
