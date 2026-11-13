// INT-APPEND, INT-IDEM, SEC-T-SIG/REPLAY/SIZE/ROLE (design.md §5.3, §12.5, §12.6).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { entryHash, GENESIS_HASH, type LedgerEntry } from '../src/chain.ts';
import { createDb } from '../src/db.ts';
import { verifyChain } from '../src/verify-chain.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie, signed, signEvent, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let A: TestDevice;
let B: TestDevice;
let cookies = new Map<string, string>();

beforeAll(async () => {
  app = buildApp(db, { origin: ORIGIN });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  for (const [id, role] of [['S-0001', 'clerk'], ['S-0002', 'nurse'], ['S-0003', 'charge'], ['S-0004', 'admin']] as const) {
    await addStaff(pool, id, role);
  }
  A = await addDevice(pool);
  B = await addDevice(pool);
  cookies = new Map();
});

async function cookieFor(deviceId: string): Promise<string> {
  const c = cookies.get(deviceId) ?? (await sessionCookie(pool, 'S-0001', deviceId));
  cookies.set(deviceId, c);
  return c;
}
const push = async (d: { deviceId: string }, events: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: await cookieFor(d.deviceId) }, payload: { deviceId: d.deviceId, events } });
const raw = async (method: 'GET' | 'POST', url: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, cookie: await cookieFor(A.deviceId) }, ...extra });
const pull = (after = 0, limit?: number) => raw('GET', `/api/v1/events?after=${after}${limit ? `&limit=${limit}` : ''}`);
const statuses = (r: { json: () => { results: { status: string; code?: string }[] } }) =>
  r.json().results.map((x) => x.code ?? x.status);

describe('POST /api/v1/events', () => {
  it('appends a signed event with a server-assigned seq and a chained hash (FR-3, FR-5, SEC-10)', async () => {
    const e = admitOn(A, 1);
    const r = await push(A, [e]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ headSeq: 1, results: [{ eventId: e.eventId, status: 'appended', serverSeq: 1 }] });

    const entries: LedgerEntry[] = (await pull()).json().entries;
    expect(entries).toHaveLength(1);
    const [entry] = entries as [LedgerEntry];
    expect(entry.event).toEqual(e);
    expect(entry.prevHash).toBe(GENESIS_HASH.toString('hex'));
    expect(entry.hash).toBe(entryHash(GENESIS_HASH, 1, entry.serverTime, e).toString('hex'));
    expect(r.json().headHash).toBe(entry.hash);
  });

  it('acceptance 3: the same push retried 3 times is in the log once (FR-4)', async () => {
    const batch = [admitOn(A, 1), admitOn(A, 2)];
    const r1 = await push(A, batch);
    const r2 = await push(A, batch);
    const r3 = await push(A, batch);
    expect(statuses(r1)).toEqual(['appended', 'appended']);
    expect(statuses(r2)).toEqual(['duplicate', 'duplicate']);
    expect(r3.json().results.map((x: { serverSeq: number }) => x.serverSeq)).toEqual([1, 2]);
    expect((await pull()).json().entries).toHaveLength(2);
  });

  it('treats a repeat inside one batch as a duplicate', async () => {
    const e = admitOn(A, 1);
    expect(statuses(await push(A, [e, e]))).toEqual(['appended', 'duplicate']);
  });

  it('refuses the same eventId with a different payload (IDEMPOTENCY_MISMATCH)', async () => {
    const e = admitOn(A, 1);
    await push(A, [e]);
    const changed = signEvent({ ...e, payload: { ...e.payload, label: 'Other' } }, A.privateKey);
    expect(statuses(await push(A, [changed]))).toEqual(['IDEMPOTENCY_MISMATCH']);
  });

  it('refuses forged or altered signatures without blocking later events (SEC-9)', async () => {
    const good = admitOn(A, 1);
    const altered = { ...admitOn(A, 2), payload: { patientId: 'T-TST-0002', label: 'Edited after signing', bedId: 'B01' } };
    const byOtherKey = { ...signed(B, 'RENAME', { patientId: 'T-TST-0001', label: 'x' }), deviceId: A.deviceId, deviceSeq: 50 };
    const after = admitOn(A, 3, { deviceSeq: 60 });
    expect(statuses(await push(A, [good, altered, byOtherKey, after]))).toEqual([
      'appended',
      'SIGNATURE_INVALID',
      'SIGNATURE_INVALID',
      'appended',
    ]);
    expect((await pull()).json().entries).toHaveLength(2);
  });

  it('refuses an event from another device inside this device\'s batch', async () => {
    expect(statuses(await push(A, [admitOn(B, 1)]))).toEqual(['DEVICE_MISMATCH']);
  });

  it('enforces roles from the staff table (SEC-6)', async () => {
    const resolve = (staffId: string) =>
      signed(A, 'RESOLVE_CONFLICT', { conflictId: 'C-1', keep: 'NONE', candidatesSeen: [crypto.randomUUID()] }, { staffId });
    const configure = (staffId: string) => signed(A, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }] }, { staffId });
    await addStaff(pool, 'S-0005', 'charge', 'disabled');
    expect(
      statuses(
        await push(A, [
          resolve('S-0001'), // clerk
          resolve('S-0002'), // nurse
          resolve('S-0003'), // charge
          configure('S-0003'), // charge
          configure('S-0004'), // admin
          admitOn(A, 1, { staffId: 'S-0002' }), // nurse may move patients (OQ-9)
          admitOn(A, 2, { staffId: 'S-0005' }), // disabled
          admitOn(A, 3, { staffId: 'S-0099' }), // unknown
        ]),
      ),
    ).toEqual(['ROLE_FORBIDDEN', 'ROLE_FORBIDDEN', 'appended', 'ROLE_FORBIDDEN', 'appended', 'appended', 'ROLE_FORBIDDEN', 'ROLE_FORBIDDEN']);
  });

  it('refuses a deviceSeq that does not increase (local data loss signal)', async () => {
    await push(A, [admitOn(A, 1, { deviceSeq: 5 })]);
    expect(statuses(await push(A, [admitOn(A, 2, { deviceSeq: 5 }), admitOn(A, 3, { deviceSeq: 4 })]))).toEqual([
      'DEVICE_SEQ_REGRESSION',
      'DEVICE_SEQ_REGRESSION',
    ]);
  });

  it('refuses schema-invalid events by id, and unknown fields (SEC-11)', async () => {
    const e = admitOn(A, 1);
    const r = await push(A, [{ ...e, extra: 1 }, { nope: true }]);
    expect(r.json().results).toEqual([
      { eventId: e.eventId, status: 'refused', code: 'SCHEMA_INVALID' },
      { eventId: null, status: 'refused', code: 'SCHEMA_INVALID' },
    ]);
  });

  it('takes handoff notes from clinical staff only (FR-15, SEC-6)', async () => {
    const note = (staffId: string) => signed(A, 'HANDOFF_NOTE_ADDED', { bedId: 'B01', text: 'Family visiting at 2' }, { staffId });
    expect(statuses(await push(A, [note('S-0001'), note('S-0002'), note('S-0003')]))).toEqual(['ROLE_FORBIDDEN', 'appended', 'appended']); // clerk, nurse, charge
  });

  it('takes tasks from any role, but refuses a title that looks like an identifier (FR-15, SEC-16)', async () => {
    const ok = signed(A, 'TASK_CREATED', { bedId: 'B01', title: 'Bed needs cleaning' }, { staffId: 'S-0001' }); // clerk
    const bad = signed(A, 'TASK_CREATED', { bedId: 'B01', title: `MRN ${'1234567'}` } /* built at runtime: no MRN-shaped text in the repo */, { staffId: 'S-0002' });
    const doneIt = signed(A, 'TASK_COMPLETED', { taskId: ok.eventId }, { staffId: 'S-0002' }); // nurse
    expect(statuses(await push(A, [ok, bad, doneIt]))).toEqual(['appended', 'SCHEMA_INVALID', 'appended']);
  });

  it('needs a session on the same, active device before reading events', async () => {
    const pending = await addDevice(pool, 'pending');
    const revoked = await addDevice(pool, 'revoked');
    const code = (r: { statusCode: number; json: () => { error: { code: string } } }) => [r.statusCode, r.json().error.code];
    const anon = await app.inject({ method: 'POST', url: '/api/v1/events', headers: CSRF, payload: { deviceId: A.deviceId, events: [admitOn(A, 1)] } });
    expect(code(anon)).toEqual([401, 'NO_SESSION']);
    const otherDevice = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { ...CSRF, cookie: await cookieFor(B.deviceId) },
      payload: { deviceId: A.deviceId, events: [admitOn(A, 2)] },
    });
    expect(code(otherDevice)).toEqual([403, 'DEVICE_MISMATCH']);
    expect(code(await push(pending, [admitOn(pending, 1)]))).toEqual([403, 'DEVICE_NOT_ACTIVE']);
    expect(code(await push(revoked, [admitOn(revoked, 1)]))).toEqual([403, 'DEVICE_REVOKED']);
    expect((await pull()).json().entries).toHaveLength(0);
  });

  it('validates the batch envelope and size limits (SEC-23)', async () => {
    const many = Array.from({ length: 101 }, (_, i) => admitOn(A, i + 1));
    expect((await push(A, many)).json().error.code).toBe('VALIDATION_FAILED');
    expect((await push(A, [])).statusCode).toBe(422);
    expect((await raw('POST', '/api/v1/events', { payload: { events: [admitOn(A, 1)] } })).statusCode).toBe(422);

    const json = { 'content-type': 'application/json' };
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { ...json, ...CSRF, cookie: await cookieFor(A.deviceId) },
      payload: JSON.stringify({ deviceId: A.deviceId, events: [], pad: 'x'.repeat(262_144) }),
    });
    expect([big.statusCode, big.json().error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    const bad = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...json, ...CSRF, cookie: await cookieFor(A.deviceId) }, payload: '{' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'BAD_REQUEST']);
  });

  it('orders by arrival, never by client clocks (SEC-12)', async () => {
    await push(A, [admitOn(A, 1, { clientTime: '2030-01-01T00:00:00.000Z' })]);
    await push(B, [admitOn(B, 2, { clientTime: '2001-01-01T00:00:00.000Z' })]);
    const entries: LedgerEntry[] = (await pull()).json().entries;
    expect(entries.map((e) => [e.serverSeq, e.event.deviceId])).toEqual([
      [1, A.deviceId],
      [2, B.deviceId],
    ]);
  });

  it('keeps seqs gap-free and the chain valid under concurrent pushes from several devices', async () => {
    const ds = [A, B, await addDevice(pool), await addDevice(pool)];
    let n = 0;
    const batches = ds.flatMap((d) => Array.from({ length: 5 }, () => [admitOn(d, ++n), admitOn(d, ++n)]));
    const byDevice = new Map(ds.map((d, i) => [d.deviceId, i]));
    // Each device sends its batches in order; devices run in parallel.
    await Promise.all(
      ds.map(async (d) => {
        for (const b of batches.filter((x) => x[0]?.deviceId === d.deviceId)) expect((await push(d, b)).statusCode).toBe(200);
      }),
    );
    const entries: LedgerEntry[] = (await pull(0, 1000)).json().entries;
    expect(entries.map((e) => e.serverSeq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    for (const [deviceId] of byDevice) {
      const seqs = entries.filter((e) => e.event.deviceId === deviceId).map((e) => e.event.deviceSeq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // per-device order preserved
    }
    expect(await verifyChain(db)).toMatchObject({ ok: true, headSeq: n });
  });
});

describe('GET /api/v1/events', () => {
  it('pages with after and limit', async () => {
    await push(A, [1, 2, 3, 4, 5].map((i) => admitOn(A, i)));
    const page = (await pull(2, 2)).json();
    expect(page.headSeq).toBe(5);
    expect(page.entries.map((e: LedgerEntry) => e.serverSeq)).toEqual([3, 4]);
  });

  it('validates query parameters', async () => {
    for (const q of ['after=-1', 'after=x', 'limit=0', 'limit=1001']) {
      expect((await raw('GET', `/api/v1/events?${q}`)).statusCode).toBe(422);
    }
  });
});
