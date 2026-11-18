// FR-16, SEC-32: hospital branding. Read without a session; only admins change it; logos are checked by their bytes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { inspectImage } from '../src/branding.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
const cookie: Record<string, string> = {};

/** The first 33 bytes of a PNG: signature and IHDR with this size. Enough for the checks, not a full image. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
/** SOI, an APP0 segment, then SOF0 with height 64 and width 128. */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

beforeAll(async () => {
  app = buildApp(db, { origin: ORIGIN, ward: 'Demo Ward' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  const d = await addDevice(pool);
  for (const [id, role] of [['S-0003', 'charge'], ['S-0004', 'admin']] as const) {
    await addStaff(pool, id, role);
    cookie[role] = await sessionCookie(pool, id, d.deviceId);
  }
});

const put = (role: string, url: string, payload: object | Buffer, type = 'application/json') =>
  app.inject({ method: 'PUT', url, headers: { ...CSRF, cookie: cookie[role] ?? '', 'content-type': type }, payload });
const SETTINGS = { hospitalName: 'Demo General Hospital', accent: '#1D4ED8', bays: [{ name: 'Bay A', beds: ['B01', 'B02'] }] };

describe('inspectImage', () => {
  it('reads PNG and JPEG sizes from the bytes and refuses anything else', () => {
    expect(inspectImage(png(64, 32))).toEqual({ type: 'image/png', width: 64, height: 32 });
    expect(inspectImage(jpeg)).toEqual({ type: 'image/jpeg', width: 128, height: 64 });
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('branding routes', () => {
  it('starts empty and is readable without signing in', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/branding' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ hospitalName: null, accent: null, logo: null, bays: null, ward: 'Demo Ward' });
  });

  it('an admin saves name, colour and bays; the change is audited', async () => {
    const r = await put('admin', '/api/v1/admin/branding', SETTINGS);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hospitalName: 'Demo General Hospital', accent: '#1d4ed8', bays: SETTINGS.bays });
    expect((await app.inject({ method: 'GET', url: '/api/v1/branding' })).json().accent).toBe('#1d4ed8');
    const { rows } = await owner.query("SELECT staff_id, code FROM audit_log WHERE action = 'BRANDING_CHANGED'");
    expect(rows).toEqual([{ staff_id: 'S-0004', code: 'settings' }]);
  });

  it('refuses charge nurses, light colours and a bed in two bays', async () => {
    const r = await put('charge', '/api/v1/admin/branding', SETTINGS);
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await put('admin', '/api/v1/admin/branding', { ...SETTINGS, accent: '#ffff00' })).statusCode).toBe(422);
    expect((await put('admin', '/api/v1/admin/branding', { ...SETTINGS, bays: [{ name: 'A', beds: ['B01'] }, { name: 'B', beds: ['B01'] }] })).statusCode).toBe(422);
  });

  it('stores a PNG or JPEG logo as typed by its bytes, whatever the header says', async () => {
    const r = await put('admin', '/api/v1/admin/branding/logo', png(64, 64), 'image/jpeg');
    expect(r.statusCode).toBe(200);
    expect(r.json().logo).toMatch(/^data:image\/png;base64,/);
    expect((await put('admin', '/api/v1/admin/branding/logo', jpeg, 'image/jpeg')).json().logo).toMatch(/^data:image\/jpeg;base64,/);
    const { rows } = await owner.query("SELECT code FROM audit_log WHERE action = 'BRANDING_CHANGED' ORDER BY audit_id");
    expect(rows.map((x) => x.code)).toEqual(['logo', 'logo']);
  });

  it('refuses SVG, oversized images, big files and non-admins', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const code = async (role: string, b: Buffer, type = 'image/png') => {
      const r = await put(role, '/api/v1/admin/branding/logo', b, type);
      return [r.statusCode, r.json().error.code];
    };
    expect(await code('admin', svg)).toEqual([422, 'LOGO_REFUSED']);
    expect(await code('admin', svg, 'image/svg+xml')).toEqual([415, 'BAD_REQUEST']);
    expect(await code('admin', png(2000, 10))).toEqual([422, 'LOGO_REFUSED']);
    expect(await code('admin', Buffer.concat([png(64, 64), Buffer.alloc(204_800)]))).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(await code('charge', png(64, 64))).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await owner.query('SELECT count(*)::int AS n FROM ward_settings')).rows[0].n).toBe(0);
  });
});
