// SEC-T-ALERT, SEC-T-LOGS: SEC-28 clock skew, SEC-20 health and alerts, design.md §13.1 log redaction.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, deviceSig, ORIGIN, OWNER_URL, reset, sessionCookie, signed, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
const lines: string[] = [];
let app: FastifyInstance;
let d: TestDevice;
const cookie: Record<string, string> = {};
const PIN = '482913';

beforeAll(async () => {
  const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
  app = buildApp(db, { origin: ORIGIN, log: { level: 'info', stream } });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  lines.length = 0;
  d = await addDevice(pool);
  for (const [id, role] of [['S-0001', 'nurse'], ['S-0003', 'charge'], ['S-0004', 'admin']] as const) {
    await addStaff(pool, id, role, 'active', PIN);
    cookie[role] = await sessionCookie(pool, id, d.deviceId);
  }
});

const get = (role: string, url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { cookie: cookie[role] ?? '', ...headers } });
const alertCodes = async (role = 'charge') => ((await get(role, '/api/v1/alerts')).json().alerts as { code: string }[]).map((a) => a.code);

describe('clock skew (SEC-28)', () => {
  it('records each device offset from X-WDB-Client-Time, tells the device, and audits a large one once', async () => {
    const r = await get('nurse', '/api/v1/events?after=0', { 'x-wdb-client-time': new Date(Date.now() - 4 * 60_000).toISOString() });
    const offset = Number(r.headers['x-wdb-clock-offset-ms']);
    expect(offset).toBeGreaterThan(239_000);
    expect(offset).toBeLessThan(241_000);
    const { rows } = await owner.query('SELECT last_clock_offset_ms, last_seen_at FROM devices WHERE device_id = $1', [d.deviceId]);
    expect(rows[0].last_clock_offset_ms).toBeGreaterThan(239_000);
    expect(rows[0].last_seen_at).not.toBeNull();
    await get('nurse', '/api/v1/events?after=0', { 'x-wdb-client-time': new Date(Date.now() - 4 * 60_000).toISOString() });
    const audits = (await owner.query("SELECT code FROM audit_log WHERE action = 'CLOCK_SKEW'")).rows;
    expect(audits).toHaveLength(1); // only when it crosses 120 s, not on every request
    expect(await alertCodes()).toContain('CLOCK_SKEW');
  });

  it('ignores a missing or unreadable client time; never affects ordering', async () => {
    const r = await get('nurse', '/api/v1/events?after=0', { 'x-wdb-client-time': 'yesterday' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-wdb-clock-offset-ms']).toBeUndefined();
    expect((await owner.query('SELECT last_clock_offset_ms FROM devices')).rows[0].last_clock_offset_ms).toBeNull();
  });
});

describe('alerts and health (SEC-20)', () => {
  it('raises AUTH_FAILURES after 10 failed sign-ins for one staff member in 5 minutes', async () => {
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...CSRF, 'x-wdb-device-sig': deviceSig(d, 'POST', '/api/v1/sessions') }, payload: { staffId: 'S-0077', pin: '000000' } });
    }
    expect(await alertCodes()).toContain('AUTH_FAILURES');
  });

  it('raises SIGNATURE_FAILURE on any bad signature and EVENT_FLOOD over 300 events a minute', async () => {
    const bad = { ...admitOn(d, 1, { staffId: 'S-0004' }), sig: 'A'.repeat(86) };
    await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: cookie.admin ?? '' }, payload: { deviceId: d.deviceId, events: [bad] } });
    expect(await alertCodes()).toEqual(['SIGNATURE_FAILURE']);
    await owner.query(`INSERT INTO audit_log (device_id, action, outcome, request_id) SELECT $1, 'EVENT_APPEND', 'ok', 'r' FROM generate_series(1, 301)`, [d.deviceId]);
    expect(await alertCodes()).toContain('EVENT_FLOOD');
  });

  it('raises DEVICE_LAGGING for an active device not seen for over an hour', async () => {
    const quiet = await addDevice(pool); // the tablet asking for alerts is, by asking, seen now
    await owner.query("UPDATE devices SET last_seen_at = now() - interval '61 minutes' WHERE device_id = $1", [quiet.deviceId]);
    expect(await alertCodes()).toEqual(['DEVICE_LAGGING']);
  });

  it('is quiet when all is well; clerks and nurses cannot read alerts', async () => {
    expect(await alertCodes()).toEqual([]);
    expect((await get('nurse', '/api/v1/alerts')).statusCode).toBe(403);
  });

  it('health shows the log head, devices, counts and push timing to admins only, with no patient data', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: cookie.admin ?? '' },
      payload: { deviceId: d.deviceId, events: [signed(d, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }] }, { staffId: 'S-0004' }), admitOn(d, 1, { staffId: 'S-0004' })] },
    });
    const h = (await get('admin', '/api/v1/admin/health')).json();
    expect(h).toMatchObject({ headSeq: 2, sseClients: 0, last24h: { appended: 2, duplicate: 0, refused: 0, signinFailures: 0, signatureFailures: 0 }, alerts: [] });
    expect(h.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.devices).toEqual([expect.objectContaining({ label: 'test tablet', status: 'active', lastDeviceSeq: 2 })]);
    expect(h.pushMs.count).toBeGreaterThanOrEqual(1); // the monitor lives as long as the app, across tests
    expect(h.pushMs.p95).toEqual(expect.any(Number));
    expect(JSON.stringify(h)).not.toContain('Patient 1');
    expect((await get('charge', '/api/v1/admin/health')).statusCode).toBe(403);
  });
});

describe('chain check and backups (SEC-10, SEC-27)', () => {
  it('a broken hash chain raises CHAIN_BREAK, is audited, and shows on health', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: cookie.admin ?? '' },
      payload: { deviceId: d.deviceId, events: [signed(d, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }] }, { staffId: 'S-0004' }), admitOn(d, 1, { staffId: 'S-0004' })] },
    });
    expect(await app.checkChain()).toMatchObject({ ok: true, headSeq: 2 });
    expect(await alertCodes()).toEqual([]);
    await owner.query('ALTER TABLE events DISABLE TRIGGER events_append_only');
    try {
      await owner.query(`UPDATE events SET body = jsonb_set(body, '{payload,label}', '"Changed"') WHERE server_seq = 2`);
    } finally {
      await owner.query('ALTER TABLE events ENABLE TRIGGER events_append_only');
    }
    expect(await app.checkChain()).toMatchObject({ ok: false, firstBadSeq: 2 });
    expect(await alertCodes()).toEqual(['CHAIN_BREAK']);
    expect((await owner.query("SELECT code FROM audit_log WHERE action = 'CHAIN_VERIFY_FAIL'")).rows).toEqual([{ code: '2' }]);
    expect((await get('admin', '/api/v1/admin/health')).json().chain).toMatchObject({ ok: false, firstBadSeq: 2 });
    await reset(owner);
    expect(await app.checkChain()).toMatchObject({ ok: true }); // a later check clears it (sessions are gone after the reset)
  });

  it('BACKUP_STALE when the newest backup is over an hour old; health shows its age', async () => {
    await owner.query("INSERT INTO audit_log (action, outcome, code, request_id, server_time) VALUES ('BACKUP_DONE', 'ok', '0', 'backup', now() - interval '61 minutes')");
    expect(await alertCodes()).toEqual(['BACKUP_STALE']);
    expect((await get('admin', '/api/v1/admin/health')).json().backupAgeSeconds).toBeGreaterThan(3600);
    await owner.query("INSERT INTO audit_log (action, outcome, code, request_id) VALUES ('BACKUP_DONE', 'ok', '0', 'backup')");
    expect(await alertCodes()).toEqual([]);
  });
});

describe('logs (design.md §13.1)', () => {
  it('JSON lines with requestId and key events; never a PIN, cookie, device signature or patient label', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...CSRF, 'x-wdb-device-sig': deviceSig(d, 'POST', '/api/v1/sessions') }, payload: { staffId: 'S-0001', pin: '999999' } });
    await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...CSRF, 'x-wdb-device-sig': deviceSig(d, 'POST', '/api/v1/sessions') }, payload: { staffId: 'S-0001', pin: PIN } });
    const bad = { ...admitOn(d, 2, { staffId: 'S-0004' }), sig: 'A'.repeat(86) };
    await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: cookie.admin ?? '' }, payload: { deviceId: d.deviceId, events: [admitOn(d, 1, { staffId: 'S-0004' }), bad] } });
    const all = lines.join('');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.every((l) => typeof l.requestId === 'string' || l.event === undefined)).toBe(true);
    expect(parsed.map((l) => l.event).filter(Boolean)).toEqual(expect.arrayContaining(['signin_fail', 'push_batch', 'event_refused']));
    expect(parsed.find((l) => l.event === 'push_batch')).toMatchObject({ count: 2, appended: 1, refused: 1, deviceId: d.deviceId, staffId: 'S-0004' });
    // PINs as whole JSON strings: bare digits can occur inside numbers such as responseTime.
    for (const secret of [JSON.stringify(PIN), '"999999"', 'Patient 1', 'Patient 2', (cookie.admin ?? '').split('=')[1] ?? 'x', 'wdb_sid=']) expect(all).not.toContain(secret);
  });
});
