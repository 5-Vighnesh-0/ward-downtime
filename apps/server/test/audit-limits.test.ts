// INT-AUDIT, SEC-T-LOGS (audit part), SEC-T-SIZE (rate/backpressure): SEC-18, SEC-19, SEC-23.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie, signEvent, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let d: TestDevice;
let cookie: string;

afterAll(async () => {
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  await addStaff(pool, 'S-0001', 'clerk');
  d = await addDevice(pool);
  cookie = await sessionCookie(pool, 'S-0001', d.deviceId);
});

const pushTo = (app: ReturnType<typeof buildApp>, events: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie }, payload: { deviceId: d.deviceId, events } });

describe('audit log (SEC-18)', () => {
  it('records who, device, action, event, outcome and request id for every pushed event', async () => {
    const app = buildApp(db, { origin: ORIGIN });
    const e = admitOn(d, 1);
    const forged = { ...admitOn(d, 2), payload: { patientId: 'T-TST-0002', label: 'Edited', bedId: 'B01' } };
    const r = await pushTo(app, [e, e, forged]);
    const requestId = r.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = (await owner.query('SELECT staff_id, device_id, action, event_id, outcome, code, request_id FROM audit_log ORDER BY audit_id')).rows;
    expect(rows).toEqual([
      { staff_id: 'S-0001', device_id: d.deviceId, action: 'EVENT_APPEND', event_id: e.eventId, outcome: 'ok', code: null, request_id: requestId },
      { staff_id: 'S-0001', device_id: d.deviceId, action: 'EVENT_DUPLICATE', event_id: e.eventId, outcome: 'duplicate', code: null, request_id: requestId },
      { staff_id: 'S-0001', device_id: d.deviceId, action: 'EVENT_REFUSED', event_id: forged.eventId, outcome: 'refused', code: 'SIGNATURE_INVALID', request_id: requestId },
    ]);
    await app.close();
  });

  it('never stores patient labels (SEC-19)', async () => {
    const app = buildApp(db, { origin: ORIGIN });
    await pushTo(app, [admitOn(d, 1), signEvent({ ...admitOn(d, 2), extra: 1 } as never, d.privateKey)]);
    const dump = JSON.stringify((await owner.query('SELECT * FROM audit_log')).rows);
    expect(dump).not.toContain('Patient 1');
    expect(dump).not.toContain('T-TST-0001');
    await app.close();
  });
});

describe('limits (SEC-23)', () => {
  it('rate-limits pushes to 60 a minute per device', async () => {
    const app = buildApp(db, { origin: ORIGIN });
    for (let i = 0; i < 60; i++) expect((await pushTo(app, [admitOn(d, i + 1)])).statusCode).toBe(200);
    const r = await pushTo(app, [admitOn(d, 61)]);
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('answers 503 with Retry-After instead of queueing without bound', async () => {
    const app = buildApp(db, { origin: ORIGIN, maxInflightPushes: 0 });
    const r = await pushTo(app, [admitOn(d, 1)]);
    expect([r.statusCode, r.json().error.code, r.headers['retry-after']]).toEqual([503, 'BACKPRESSURE', '5']);
    await app.close();
  });
});
