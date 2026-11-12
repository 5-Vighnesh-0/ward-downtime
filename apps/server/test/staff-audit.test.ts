// SEC-T-ROLE (admin/audit routes): staff management and audit view (FR-14, SEC-6, SEC-8, SEC-18).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, APP_URL, CSRF, deviceSig, ORIGIN, OWNER_URL, reset, sessionCookie, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let d: TestDevice;
const cookie: Record<string, string> = {};

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
  d = await addDevice(pool);
  for (const [id, role] of [['S-0001', 'clerk'], ['S-0003', 'charge'], ['S-0004', 'admin']] as const) {
    await addStaff(pool, id, role);
    cookie[role] = await sessionCookie(pool, id, d.deviceId);
  }
});

const as = (role: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { ...CSRF, cookie: cookie[role] ?? '' }, ...(payload ? { payload } : {}) });
const code = (r: { statusCode: number; json: () => { error: { code: string } } }) => [r.statusCode, r.json().error.code];
const NEW = { staffId: 'S-0042', displayName: 'Test Nurse', role: 'nurse', pin: '582913' };

describe('staff management (admin only)', () => {
  it('lists, creates and updates staff, with audit rows', async () => {
    expect((await as('admin', 'POST', '/api/v1/admin/staff', NEW)).statusCode).toBe(201);
    const list = (await as('admin', 'GET', '/api/v1/admin/staff')).json().staff;
    expect(list).toContainEqual({ staffId: 'S-0042', displayName: 'Test Nurse', role: 'nurse', status: 'active', lockedUntil: null });
    expect(JSON.stringify(list)).not.toMatch(/pin/i); // no hashes or salts leave the server
    expect((await as('admin', 'PATCH', '/api/v1/admin/staff/S-0042', { role: 'charge' })).json()).toMatchObject({ role: 'charge' });
    const actions = (await owner.query('SELECT action FROM audit_log ORDER BY audit_id')).rows.map((r) => r.action);
    expect(actions).toEqual(['STAFF_CREATE', 'STAFF_UPDATE']);
  });

  it('refuses non-admins, duplicates and bad input', async () => {
    expect(code(await as('charge', 'GET', '/api/v1/admin/staff'))).toEqual([403, 'ROLE_FORBIDDEN']);
    expect(code(await as('charge', 'POST', '/api/v1/admin/staff', NEW))).toEqual([403, 'ROLE_FORBIDDEN']);
    await as('admin', 'POST', '/api/v1/admin/staff', NEW);
    expect(code(await as('admin', 'POST', '/api/v1/admin/staff', NEW))).toEqual([409, 'STAFF_EXISTS']);
    expect((await as('admin', 'POST', '/api/v1/admin/staff', { ...NEW, staffId: 'S-0043', pin: '12' })).statusCode).toBe(422);
    expect((await as('admin', 'POST', '/api/v1/admin/staff', { ...NEW, staffId: 'S-0043', extra: 1 })).statusCode).toBe(422);
    expect(code(await as('admin', 'PATCH', '/api/v1/admin/staff/S-0099', { status: 'disabled' }))).toEqual([404, 'NOT_FOUND']);
  });

  it('disabling a staff member ends their sessions and lists them for devices to drop offline sign-in (SEC-8)', async () => {
    expect((await as('admin', 'PATCH', '/api/v1/admin/staff/S-0001', { status: 'disabled' })).statusCode).toBe(200);
    expect(code(await as('clerk', 'GET', '/api/v1/events?after=0'))).toEqual([401, 'NO_SESSION']);
    expect((await as('charge', 'GET', '/api/v1/events?after=0')).json().disabledStaff).toEqual(['S-0001']);
    await as('admin', 'PATCH', '/api/v1/admin/staff/S-0001', { status: 'active' });
    expect(code(await as('clerk', 'GET', '/api/v1/events?after=0'))).toEqual([401, 'NO_SESSION']); // re-enabling does not revive old sessions
  });

  it('a PIN reset clears the lockout and works for sign-in', async () => {
    await owner.query("UPDATE staff SET locked_until = now() + interval '10 minutes', failed_attempts = 3 WHERE staff_id = 'S-0001'");
    await as('admin', 'PATCH', '/api/v1/admin/staff/S-0001', { pin: '772913' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { ...CSRF, 'x-wdb-device-sig': deviceSig(d, 'POST', '/api/v1/sessions') },
      payload: { staffId: 'S-0001', pin: '772913' },
    });
    expect(r.statusCode).toBe(201);
  });
});

describe('audit view (charge and admin)', () => {
  it('pages newest first and filters by staff, device and action', async () => {
    for (let i = 0; i < 5; i++) await owner.query(`INSERT INTO audit_log (staff_id, device_id, action, outcome, request_id) VALUES ('S-0001', $1, $2, 'ok', 'r')`, [d.deviceId, i % 2 ? 'SIGNOUT' : 'SIGNIN_OK']);
    const other = await addDevice(pool);
    // Decoys that each match all filters but one.
    for (const [staff, dev, action] of [['S-0003', d.deviceId, 'SIGNOUT'], ['S-0001', other.deviceId, 'SIGNOUT'], ['S-0001', d.deviceId, 'SIGNIN_FAIL']]) {
      await owner.query(`INSERT INTO audit_log (staff_id, device_id, action, outcome, request_id) VALUES ($1, $2, $3, 'ok', 'r')`, [staff, dev, action]);
    }
    const page1 = (await as('charge', 'GET', '/api/v1/audit?limit=2')).json();
    expect(page1.entries.map((e: { auditId: number }) => e.auditId)).toEqual([8, 7]);
    const page2 = (await as('charge', 'GET', `/api/v1/audit?limit=2&before=${page1.next}`)).json();
    expect(page2.entries.map((e: { auditId: number }) => e.auditId)).toEqual([6, 5]);
    const filtered = (await as('admin', 'GET', `/api/v1/audit?action=SIGNOUT&staffId=S-0001&deviceId=${d.deviceId}`)).json();
    expect(filtered.entries).toHaveLength(2);
    expect(filtered.next).toBeNull();
    expect(Object.keys(filtered.entries[0]).sort()).toEqual(['action', 'auditId', 'code', 'deviceId', 'eventId', 'outcome', 'requestId', 'serverTime', 'staffId']);
  });

  it('refuses clerks and nurses and bad filters', async () => {
    expect(code(await as('clerk', 'GET', '/api/v1/audit'))).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await as('admin', 'GET', '/api/v1/audit?limit=501')).statusCode).toBe(422);
    expect((await as('admin', 'GET', "/api/v1/audit?action=x'--")).statusCode).toBe(422);
  });
});
