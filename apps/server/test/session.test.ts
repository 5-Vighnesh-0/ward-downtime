// SEC-T-AUTH, SEC-T-CSRF: staff sign-in, lockout, session lifetime, CSRF (SEC-5, SEC-7, SEC-22).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, deviceSig, ORIGIN, OWNER_URL, reset, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let d: TestDevice;
const PIN = '482913';

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
  await addStaff(pool, 'S-0001', 'clerk', 'active', PIN);
  await addStaff(pool, 'S-0002', 'nurse', 'disabled', PIN);
  d = await addDevice(pool);
});

const signIn = (staffId: string, pin: string, dev: TestDevice = d, sig = true) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: { ...CSRF, ...(sig ? { 'x-wdb-device-sig': deviceSig(dev, 'POST', '/api/v1/sessions') } : {}) },
    payload: { staffId, pin },
  });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0] ?? '';
const pushWith = (cookie: string) =>
  app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie }, payload: { deviceId: d.deviceId, events: [admitOn(d, 1)] } });
const code = (r: { statusCode: number; json: () => { error: { code: string } } }) => [r.statusCode, r.json().error.code];
const actions = async () => (await owner.query('SELECT action FROM audit_log ORDER BY audit_id')).rows.map((x) => x.action);

describe('POST /api/v1/sessions', () => {
  it('signs in with a PIN and sets a hardened session cookie', async () => {
    const r = await signIn('S-0001', PIN);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ staffId: 'S-0001', role: 'clerk', expiresAt: expect.any(String), offlineUntil: expect.any(String) });
    const setCookie = String(r.headers['set-cookie']);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=43200']) expect(setCookie).toContain(flag); // gitleaks:allow (cookie flag, not a secret)
    expect((await pushWith(cookieOf(r))).statusCode).toBe(200);
    expect(await actions()).toContain('SIGNIN_OK');
  });

  it('gives the same answer for an unknown staff ID and a wrong PIN', async () => {
    expect(code(await signIn('S-0001', '000000'))).toEqual([401, 'SIGNIN_FAILED']);
    expect(code(await signIn('S-0077', PIN))).toEqual([401, 'SIGNIN_FAILED']);
    expect(code(await signIn('S-0002', PIN))).toEqual([401, 'SIGNIN_FAILED']); // disabled
  });

  it('locks the account for 15 minutes after 5 wrong PINs, even against the right PIN', async () => {
    for (let i = 0; i < 4; i++) await signIn('S-0001', '000000');
    expect((await signIn('S-0001', PIN)).statusCode).toBe(201); // success resets the counter
    for (let i = 0; i < 5; i++) await signIn('S-0001', '000000');
    expect(code(await signIn('S-0001', PIN))).toEqual([401, 'ACCOUNT_LOCKED']);
    expect(await actions()).toContain('SIGNIN_LOCKED');
    await owner.query("UPDATE staff SET locked_until = now() - interval '1 second' WHERE staff_id = 'S-0001'");
    expect((await signIn('S-0001', PIN)).statusCode).toBe(201);
  });

  it('pauses sign-in on a device after 20 failures in 15 minutes', async () => {
    for (let i = 0; i < 20; i++) await signIn(`S-${String(100 + i).padStart(4, '0')}`, '000000');
    expect(code(await signIn('S-0001', PIN))).toEqual([429, 'SIGNIN_PAUSED']);
  });

  it('needs a device signature from an active device', async () => {
    expect(code(await signIn('S-0001', PIN, d, false))).toEqual([401, 'DEVICE_SIG_INVALID']);
    expect(code(await signIn('S-0001', PIN, await addDevice(pool, 'pending')))).toEqual([403, 'DEVICE_NOT_ACTIVE']);
    expect(code(await signIn('S-0001', PIN, await addDevice(pool, 'revoked')))).toEqual([403, 'DEVICE_REVOKED']);
  });

  it('validates the PIN format', async () => {
    for (const pin of ['12345', '123456789', 'abcdef']) expect((await signIn('S-0001', pin)).statusCode).toBe(422);
  });
});

describe('session lifetime', () => {
  it('sign-out ends the session', async () => {
    const cookie = cookieOf(await signIn('S-0001', PIN));
    const out = await app.inject({ method: 'DELETE', url: '/api/v1/sessions/current', headers: { ...CSRF, cookie } });
    expect(out.statusCode).toBe(204);
    expect(code(await pushWith(cookie))).toEqual([401, 'NO_SESSION']);
    expect(await actions()).toContain('SIGNOUT');
  });

  it('expires after 12 hours and after 30 idle minutes, and when staff is disabled', async () => {
    for (const q of [
      "UPDATE sessions SET expires_at = now() - interval '1 second'",
      "UPDATE sessions SET last_seen_at = now() - interval '31 minutes'",
      "UPDATE staff SET status = 'disabled'",
    ]) {
      await owner.query("UPDATE staff SET status = 'active' WHERE staff_id = 'S-0001'");
      const cookie = cookieOf(await signIn('S-0001', PIN));
      await owner.query(q);
      expect(code(await pushWith(cookie))).toEqual([401, 'NO_SESSION']);
    }
  });

  it('rejects a forged cookie', async () => {
    expect(code(await pushWith('wdb_sid=forged'))).toEqual([401, 'NO_SESSION']);
  });
});

describe('CSRF (SEC-22)', () => {
  it('state-changing requests need X-WDB-Request and a matching Origin', async () => {
    const cookie = cookieOf(await signIn('S-0001', PIN));
    const send = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/v1/events', headers: { cookie, ...headers }, payload: { deviceId: d.deviceId, events: [admitOn(d, 1)] } });
    expect(code(await send({}))).toEqual([403, 'CSRF_FAILED']);
    expect(code(await send({ ...CSRF, origin: 'https://evil.example' }))).toEqual([403, 'CSRF_FAILED']);
    expect((await send({ ...CSRF, origin: ORIGIN })).statusCode).toBe(200);
  });
});
