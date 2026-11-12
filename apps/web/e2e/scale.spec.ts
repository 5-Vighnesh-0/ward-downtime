// PERF-03 (design.md §13.4, NFR-Scale): a 100,000-event log. Slow (minutes), so it runs only with WDB_SCALE=1:
//   WDB_SCALE=1 pnpm e2e --project chromium e2e/scale.spec.ts
// Budgets: server cold replay < 5 s; new device full pull + chain check < 60 s; cold start from snapshot < 3 s.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { appendBatch } from '@wdb/server/src/append.ts';
import { readEntries } from '@wdb/server/src/entries.ts';
import { verifyChain } from '@wdb/server/src/verify-chain.ts';
import { replay, signingInput, type AnyEvent } from '@wdb/shared';
import { owner, resetDb, setUpTablet, startApi, stopApi } from './support.ts';

const TOTAL = 100_000;
const BEDS = 60;

test.skip(!process.env.WDB_SCALE, 'set WDB_SCALE=1 to run the 100k-event scale test');
test.afterAll(stopApi);

/** 100k valid, signed events from one synthetic device: ward setup, then admit/discharge pairs across 60 beds. */
async function seedLog(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  await owner.pool.query(
    `INSERT INTO devices (device_id, public_key, fingerprint, label, status, temp_prefix) VALUES ($1, $2, 'SCALEFINGERP', 'scale seeder', 'active', 'SCL')`,
    [deviceId, raw],
  );
  await owner.pool.query(`INSERT INTO staff (staff_id, display_name, role, pin_hash, pin_salt, status) VALUES ('S-9999', 'Scale Seeder', 'admin', $1, $2, 'active')`, [
    Buffer.alloc(32),
    Buffer.alloc(16),
  ]);
  let seq = 0;
  const make = (type: AnyEvent['type'], payload: object): AnyEvent => {
    seq += 1;
    const e = { v: 1, eventId: randomUUID(), type, deviceId, deviceSeq: seq, staffId: 'S-9999', basedOn: seq - 1, hlc: `${1762852443120 + seq}.0.SCL`, clientTime: new Date(1762852443120 + seq).toISOString(), payload, sig: '' } as AnyEvent;
    return { ...e, sig: sign(null, Buffer.from(signingInput(e)), privateKey).toString('base64url') };
  };
  const events: AnyEvent[] = [make('WARD_CONFIGURED', { beds: Array.from({ length: BEDS }, (_, i) => ({ bedId: `B${String(i + 1).padStart(2, '0')}`, label: `Bed ${i + 1}` })) })];
  for (let n = 1; events.length < TOTAL; n++) {
    const bedId = `B${String(((n - 1) % BEDS) + 1).padStart(2, '0')}`;
    const patientId = `T-SCL-${String(n).padStart(6, '0')}`;
    events.push(make('ADMIT', { patientId, label: `Scale ${n}`, bedId }));
    if (events.length < TOTAL) events.push(make('DISCHARGE', { patientId, bedId }));
  }
  for (let i = 0; i < events.length; i += 100) await appendBatch(owner.db, deviceId, events.slice(i, i + 100));
}

test('PERF-03: 100k-event log', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the scale run');
  test.setTimeout(30 * 60_000);
  await stopApi();
  await resetDb();
  await seedLog();
  await startApi();
  const report = (name: string, ms: number, budget: number) => {
    info.annotations.push({ type: name, description: `${ms.toFixed(0)} ms (budget ${budget} ms)` });
    console.log(`PERF-03 ${name}: ${(ms / 1000).toFixed(2)} s (budget ${budget / 1000} s)`);
  };

  // Server cold replay: read the whole log, check every hash, and rebuild the board.
  let t = performance.now();
  expect(await verifyChain(owner.db)).toMatchObject({ ok: true, headSeq: TOTAL });
  const entries = [];
  for (let after = 0; ; ) {
    const page = await readEntries(owner.db, after, 5000);
    entries.push(...page);
    if (page.length < 5000) break;
    after = page.at(-1)?.serverSeq ?? after;
  }
  expect(replay(entries).atSeq).toBe(TOTAL);
  const serverMs = performance.now() - t;
  report('server cold replay', serverMs, 5000);

  // New device: enroll, sign in, then pull and chain-check all 100k entries in the browser.
  await setUpTablet(page);
  t = performance.now();
  const lastSeq = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('wdb');
          req.onsuccess = () => {
            const get = req.result.transaction('meta').objectStore('meta').get('device');
            get.onsuccess = () => (resolve(get.result?.lastServerSeq ?? 0), req.result.close());
          };
        }),
    );
  await expect.poll(lastSeq, { timeout: 120_000, intervals: [500] }).toBe(TOTAL);
  const pullMs = performance.now() - t;
  report('new device full pull + chain check', pullMs, 60_000);

  // Cold start: reload; the engine opens from the local snapshot before the lock screen shows.
  t = performance.now();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible({ timeout: 30_000 });
  const coldMs = performance.now() - t;
  report('cold start from snapshot', coldMs, 3000);

  expect.soft(serverMs).toBeLessThan(5000);
  expect.soft(pullMs).toBeLessThan(60_000);
  expect.soft(coldMs).toBeLessThan(3000);
});
