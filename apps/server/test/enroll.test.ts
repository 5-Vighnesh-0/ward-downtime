// SEC-T-ENROLL, SEC-T-REVOKE: device enrollment, admin approval and revocation (SEC-4, SEC-8).
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, deviceSig, ORIGIN, OWNER_URL, reset, sessionCookie, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let adminDevice: TestDevice;
let adminCookie: string;

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
  await addStaff(pool, 'S-0001', 'clerk');
  await addStaff(pool, 'S-0004', 'admin');
  adminDevice = await addDevice(pool);
  adminCookie = await sessionCookie(pool, 'S-0004', adminDevice.deviceId);
});

function newKey(): TestDevice & { publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { deviceId: randomUUID(), privateKey, seq: 0, publicKey: publicKey.export({ format: 'jwk' }).x ?? '' };
}
const enroll = (k: { deviceId: string; publicKey: string }, label = 'Bay A tablet 2', ip = '10.0.0.5') =>
  app.inject({ method: 'POST', url: '/api/v1/devices', headers: CSRF, remoteAddress: ip, payload: { deviceId: k.deviceId, publicKey: k.publicKey, label } });
const status = (d: TestDevice) => {
  const path = `/api/v1/devices/${d.deviceId}/status`;
  return app.inject({ method: 'GET', url: path, headers: { 'x-wdb-device-sig': deviceSig(d, 'GET', path) } });
};
const admin = (action: string, deviceId: string, cookie = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/v1/admin/devices/${deviceId}/${action}`, headers: { ...CSRF, cookie } });
const audit = async () => (await owner.query('SELECT action, outcome, device_id, staff_id FROM audit_log ORDER BY audit_id')).rows;

describe('enrollment', () => {
  it('registers a pending device and returns the fingerprint to read aloud', async () => {
    const k = newKey();
    const r = await enroll(k);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ status: 'pending', fingerprint: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{12}$/) });
    expect((await status(k)).json()).toEqual({ status: 'pending', tempPrefix: null });
    expect(await audit()).toContainEqual({ action: 'DEVICE_ENROLL', outcome: 'ok', device_id: k.deviceId, staff_id: null });
  });

  it('refuses a duplicate deviceId and bad bodies', async () => {
    const k = newKey();
    await enroll(k);
    expect((await enroll(k)).json().error.code).toBe('DEVICE_EXISTS');
    expect((await enroll({ ...newKey(), publicKey: 'short' })).statusCode).toBe(422);
    expect((await enroll(newKey(), 'bad\nlabel')).statusCode).toBe(422);
  });

  it('status needs a valid signature from that device', async () => {
    const k = newKey();
    await enroll(k);
    const path = `/api/v1/devices/${k.deviceId}/status`;
    const other = newKey();
    for (const headers of [{}, { 'x-wdb-device-sig': deviceSig({ ...other, deviceId: k.deviceId }, 'GET', path) }]) {
      const r = await app.inject({ method: 'GET', url: path, headers });
      expect([r.statusCode, r.json().error.code]).toEqual([401, 'DEVICE_SIG_INVALID']);
    }
  });

  it('rate-limits enrollment to 10 per hour per address (SEC-23)', async () => {
    for (let i = 0; i < 10; i++) expect((await enroll(newKey(), 'x', '10.9.9.9')).statusCode).toBe(202);
    const r = await enroll(newKey(), 'x', '10.9.9.9');
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect((await enroll(newKey(), 'x', '10.9.9.8')).statusCode).toBe(202);
  });
});

describe('admin approval and revocation', () => {
  it('approve activates the device and assigns a unique temp-ID prefix', async () => {
    const k = newKey();
    await enroll(k);
    const r = await admin('approve', k.deviceId);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'active', tempPrefix: expect.stringMatching(/^[0-9BCDFGHJKMNPQRSTVWXYZ]{3}$/) });
    expect((await status(k)).json()).toEqual({ status: 'active', tempPrefix: r.json().tempPrefix });
    expect((await admin('approve', k.deviceId)).json().error.code).toBe('NOT_PENDING');
    expect((await admin('approve', randomUUID())).statusCode).toBe(404);
    expect(await audit()).toContainEqual({ action: 'DEVICE_APPROVE', outcome: 'ok', device_id: k.deviceId, staff_id: 'S-0004' });
  });

  it('only admins may approve or revoke (SEC-6)', async () => {
    const k = newKey();
    await enroll(k);
    const clerk = await sessionCookie(pool, 'S-0001', adminDevice.deviceId);
    expect((await admin('approve', k.deviceId, clerk)).json().error.code).toBe('ROLE_FORBIDDEN');
    expect((await admin('revoke', k.deviceId, clerk)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/devices', headers: { cookie: clerk } })).statusCode).toBe(403);
  });

  it('revocation blocks the device at its next request (SEC-8)', async () => {
    const d = await addDevice(pool);
    const cookie = await sessionCookie(pool, 'S-0001', d.deviceId);
    const pushIt = () =>
      app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie }, payload: { deviceId: d.deviceId, events: [admitOn(d, 1)] } });
    expect((await pushIt()).statusCode).toBe(200);
    expect((await admin('revoke', d.deviceId)).json()).toEqual({ status: 'revoked' });
    const r = await pushIt();
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'DEVICE_REVOKED']);
    expect((await status(d)).json().status).toBe('revoked');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/admin/devices', headers: { cookie: adminCookie } })).json();
    expect(list.devices.find((x: { deviceId: string }) => x.deviceId === d.deviceId)).toMatchObject({ status: 'revoked' });
  });
});
