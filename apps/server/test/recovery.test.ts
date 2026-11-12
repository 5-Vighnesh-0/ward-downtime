// SEC-T-EXPORT: recovery export, audit export, queue import, decrypt CLI (FR-11, FR-12, FR-14, SEC-15, SEC-18).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { decryptToFiles } from '../src/export-cli.ts';
import { openWdbx, sealWdbx } from '../src/wdbx.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie, signed, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let d: TestDevice;
const cookie: Record<string, string> = {};
const PASS = 'correct horse battery staple';

beforeAll(async () => {
  app = buildApp(db, { origin: ORIGIN, ward: 'Ward A' });
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

const as = (role: string, method: 'POST', url: string, payload: object) => app.inject({ method, url, headers: { ...CSRF, cookie: cookie[role] ?? '' }, payload });
const push = (events: object[]) => as('admin', 'POST', '/api/v1/events', { deviceId: d.deviceId, events });
const code = (r: { statusCode: number; json: () => { error: { code: string } } }) => [r.statusCode, r.json().error.code];
const actions = async () => (await owner.query('SELECT action, code FROM audit_log ORDER BY audit_id')).rows as { action: string; code: string | null }[];

describe('POST /api/v1/exports', () => {
  it('returns an encrypted .wdbx with JSON and CSV, records its hash, and audits it (FR-11, SEC-15)', async () => {
    await push([signed(d, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }] }, { staffId: 'S-0004' }), admitOn(d, 1, { staffId: 'S-0004' })]);
    const r = await as('charge', 'POST', '/api/v1/exports', { passphrase: PASS });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="recovery-2.wdbx"');
    expect(r.body).not.toContain('Patient 1');
    const files = openWdbx(r.body, PASS);
    expect(Object.keys(files).sort()).toEqual(['recovery.csv', 'recovery.json']);
    const json = JSON.parse(files['recovery.json'] ?? '');
    expect(json).toMatchObject({ ward: 'Ward A', source: 'server', upToSeq: 2, events: [{ type: 'ADMIT', patientId: 'T-TST-0001', deviceLabel: 'test tablet' }] });
    const sha = createHash('sha256').update(r.body).digest();
    const { rows } = await owner.query('SELECT created_by, up_to_seq, encrypted, formats, sha256 FROM exports');
    expect(rows).toEqual([{ created_by: 'S-0003', up_to_seq: '2', encrypted: true, formats: ['json', 'csv'], sha256: sha }]);
    expect((await actions()).at(-1)).toEqual({ action: 'EXPORT_CREATE', code: sha.toString('hex') });
    expect(() => openWdbx(r.body, 'wrong passphrase here')).toThrow();
  });

  it('refuses clerks, short passphrases, and unencrypted files for anyone but an admin', async () => {
    expect(code(await as('clerk', 'POST', '/api/v1/exports', { passphrase: PASS }))).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await as('charge', 'POST', '/api/v1/exports', { passphrase: 'short' })).statusCode).toBe(422);
    expect((await as('charge', 'POST', '/api/v1/exports', {})).statusCode).toBe(422);
    expect(code(await as('charge', 'POST', '/api/v1/exports', { plaintext: true }))).toEqual([403, 'ROLE_FORBIDDEN']);
    const plain = await as('admin', 'POST', '/api/v1/exports', { plaintext: true });
    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body)).toMatchObject({ wdbx: 1, alg: 'none' });
    expect((await actions()).map((a) => a.action)).toEqual(['EXPORT_PLAINTEXT']);
    expect((await owner.query('SELECT encrypted FROM exports')).rows).toEqual([{ encrypted: false }]);
  });

  it('the exports record cannot be changed or deleted by the app', async () => {
    await as('charge', 'POST', '/api/v1/exports', { passphrase: PASS });
    await expect(pool.query('UPDATE exports SET encrypted = false')).rejects.toThrow(/permission denied|append-only/);
    await expect(pool.query('DELETE FROM exports')).rejects.toThrow(/permission denied|append-only/);
  });
});

describe('POST /api/v1/audit/export', () => {
  it('exports the audit log as CSV with no patient data, charge and admin only (FR-14)', async () => {
    await push([admitOn(d, 1, { staffId: 'S-0004' })]);
    const r = await as('charge', 'POST', '/api/v1/audit/export', { passphrase: PASS });
    expect(r.statusCode).toBe(200);
    const csv = openWdbx(r.body, PASS)['audit.csv'] ?? '';
    expect(csv.split('\r\n')[0]).toBe('auditId,serverTime,staffId,deviceId,action,eventId,outcome,code,requestId');
    expect(csv).toContain('EVENT_APPEND');
    expect(csv).not.toContain('Patient 1');
    expect((await actions()).at(-1)?.action).toBe('AUDIT_EXPORT');
    expect(code(await as('clerk', 'POST', '/api/v1/audit/export', { passphrase: PASS }))).toEqual([403, 'ROLE_FORBIDDEN']);
  });
});

describe('POST /api/v1/recovery/queue-import (§8.4)', () => {
  it("appends a revoked tablet's saved events, verified with its own key; already-synced ones are duplicates", async () => {
    const lost = await addDevice(pool);
    const ward = signed(d, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }, { bedId: 'B02', label: 'Bed 2' }] }, { staffId: 'S-0004' });
    await push([ward]);
    const synced = admitOn(lost, 1, { staffId: 'S-0001' });
    const lostCookie = await sessionCookie(pool, 'S-0001', lost.deviceId);
    await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: lostCookie }, payload: { deviceId: lost.deviceId, events: [synced] } });
    const unsent = signed(lost, 'ADMIT', { patientId: 'T-TST-0002', label: 'Patient 2', bedId: 'B02' }, { staffId: 'S-0001' });
    await owner.query("UPDATE devices SET status = 'revoked' WHERE device_id = $1", [lost.deviceId]);
    const forged = { ...signed(lost, 'RENAME', { patientId: 'T-TST-0002', label: 'Forged' }, { staffId: 'S-0001' }), sig: unsent.sig };

    const r = await as('admin', 'POST', '/api/v1/recovery/queue-import', { deviceId: lost.deviceId, events: [synced, unsent, forged] });
    expect(r.statusCode).toBe(200);
    expect(r.json().results.map((x: { status: string; code?: string }) => x.code ?? x.status)).toEqual(['duplicate', 'appended', 'SIGNATURE_INVALID']);
    expect((await actions()).filter((a) => a.action === 'QUEUE_IMPORT')).toHaveLength(1);
    // A revoked tablet itself still cannot push.
    expect(code(await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie: lostCookie }, payload: { deviceId: lost.deviceId, events: [unsent] } }))).toEqual([403, 'DEVICE_REVOKED']);
  });

  it('is admin only and refuses unknown or pending devices', async () => {
    expect(code(await as('charge', 'POST', '/api/v1/recovery/queue-import', { deviceId: d.deviceId, events: [admitOn(d, 1)] }))).toEqual([403, 'ROLE_FORBIDDEN']);
    const pending = await addDevice(pool, 'pending');
    expect(code(await as('admin', 'POST', '/api/v1/recovery/queue-import', { deviceId: pending.deviceId, events: [admitOn(pending, 1)] }))).toEqual([403, 'DEVICE_NOT_ACTIVE']);
  });
});

describe('export:decrypt CLI', () => {
  it('writes each file next to the input and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wdbx-'));
    const file = join(dir, 'recovery-7.wdbx');
    writeFileSync(file, sealWdbx({ 'recovery.json': '{"a":1}', 'recovery.csv': 'x\r\n' }, PASS));
    expect(decryptToFiles(file, PASS).sort()).toEqual([join(dir, 'recovery-7-recovery.csv'), join(dir, 'recovery-7-recovery.json')]);
    expect(readFileSync(join(dir, 'recovery-7-recovery.json'), 'utf8')).toBe('{"a":1}');
    expect(() => decryptToFiles(file, PASS)).toThrow(/EEXIST/);
  });

  it('refuses path tricks in file names inside the container', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wdbx-'));
    const file = join(dir, 'evil.wdbx');
    writeFileSync(file, sealWdbx({ '../../escape.txt': 'x' }, PASS));
    expect(() => decryptToFiles(file, PASS)).toThrow(/odd file name/);
  });
});
