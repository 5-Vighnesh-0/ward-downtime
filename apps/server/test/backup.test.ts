// SEC-13, SEC-27: encrypted backups, restore into an empty database, retention (design.md §11.3).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { backupFileName, keep, openBackup, restoreDatabase, takeBackup } from '../src/backup.ts';
import { createDb } from '../src/db.ts';
import { verifyChain } from '../src/verify-chain.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie, signed, type TestDevice } from './support.ts';

const RESTORE_URL = OWNER_URL.replace(/\/wdb_test$/, '/wdb_restore_test');
const owner = new pg.Pool({ connectionString: OWNER_URL });
const app_ = createDb(APP_URL);
let app: FastifyInstance;
let d: TestDevice;
const key = randomBytes(32);

beforeAll(async () => {
  app = buildApp(app_.db, { origin: ORIGIN });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await app_.pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  await owner.query('DROP DATABASE IF EXISTS wdb_restore_test WITH (FORCE)');
  await owner.query('CREATE DATABASE wdb_restore_test');
  d = await addDevice(pool());
  await addStaff(pool(), 'S-0004', 'admin');
  const cookie = await sessionCookie(pool(), 'S-0004', d.deviceId);
  const events = [signed(d, 'WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }, { bedId: 'B02', label: 'Bed 2' }] }, { staffId: 'S-0004' }), admitOn(d, 1, { staffId: 'S-0004' })];
  await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie }, payload: { deviceId: d.deviceId, events } });
  await app.inject({ method: 'POST', url: '/api/v1/exports', headers: { ...CSRF, cookie }, payload: { passphrase: 'correct horse battery staple' } });
});
const pool = () => app_.pool;

describe('backup and restore', () => {
  it('a backup taken by the app role restores into an empty database with the same chain, audit and exports', async () => {
    const { bytes, headSeq } = await takeBackup(pool(), key);
    expect(headSeq).toBe(2);
    expect(bytes.subarray(0, 5).toString()).toBe('WDBB1');
    expect(bytes.includes(Buffer.from('Patient 1'))).toBe(false); // encrypted

    const target = createDb(RESTORE_URL);
    try {
      const r = await restoreDatabase(target.pool, target.db, openBackup(bytes, key));
      expect(r).toMatchObject({ headSeq: 2 });
      const src = await verifyChain(app_.db);
      expect(await verifyChain(target.db)).toEqual(src); // same head seq and hash
      // The BACKUP_DONE row is written after the snapshot, so the backup cannot contain it.
      const count = async (p: pg.Pool, t: string) => (await p.query(`SELECT count(*)::int AS n FROM ${t}${t === 'audit_log' ? " WHERE action <> 'BACKUP_DONE'" : ''}`)).rows[0].n;
      for (const t of ['staff', 'devices', 'events', 'audit_log', 'exports']) expect(await count(target.pool, t)).toBe(await count(pool(), t));
      expect(await count(target.pool, 'sessions')).toBe(0); // everyone signs in again after a restore
      // New audit rows continue after the restored ones instead of colliding.
      await target.pool.query("INSERT INTO audit_log (action, outcome, request_id) VALUES ('X', 'ok', 'r')");
      // The restored device keeps its key, so it can keep pushing.
      const { rows } = await target.pool.query('SELECT last_device_seq FROM devices');
      expect(rows[0].last_device_seq).toBe(2);
    } finally {
      await target.pool.end();
    }
  });

  it('refuses a wrong key, an edited file, and a database that is not empty', async () => {
    const { bytes } = await takeBackup(pool(), key);
    expect(() => openBackup(bytes, randomBytes(32))).toThrow();
    const edited = Buffer.from(bytes);
    edited[40] = (edited[40] ?? 0) ^ 1;
    expect(() => openBackup(edited, key)).toThrow();
    await expect(restoreDatabase(owner, createDb(OWNER_URL).db, openBackup(bytes, key))).rejects.toThrow(/not empty/);
  });

  it('refuses a restore whose log does not verify (an altered backup that still decrypts)', async () => {
    const data = openBackup((await takeBackup(pool(), key)).bytes, key);
    const ev = data.rows.events?.[1] as { body: { payload: { label: string } } };
    ev.body.payload.label = 'Altered';
    const target = createDb(RESTORE_URL);
    try {
      await expect(restoreDatabase(target.pool, target.db, data)).rejects.toThrow(/does not verify/);
    } finally {
      await target.pool.end();
    }
  });

  it('records each backup in the audit log, without patient data', async () => {
    await takeBackup(pool(), key);
    const { rows } = await owner.query("SELECT code FROM audit_log WHERE action = 'BACKUP_DONE'");
    expect(rows).toEqual([{ code: '2' }]);
  });
});

describe('retention (96 × 15 min, 30 daily, 12 monthly)', () => {
  it('keeps the newest 96, then the newest of each day for 30 days, then of each month for 12 months', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const files: string[] = [];
    for (let i = 0; i < 400 * 96; i += 7) files.push(backupFileName(new Date(now - i * 15 * 60_000), i)); // about 400 days, sparse
    const kept = new Set(keep(files, now));
    const recent = [...files].sort().reverse().slice(0, 96);
    for (const f of recent) expect(kept.has(f)).toBe(true);
    const days = new Set([...kept].map((f) => f.slice(4, 12)));
    expect(days.size).toBeGreaterThanOrEqual(30);
    expect([...kept].every((f) => Date.parse(`${f.slice(4, 8)}-${f.slice(8, 10)}-${f.slice(10, 12)}`) > now - 366 * 86_400_000)).toBe(true);
    expect(kept.size).toBeLessThan(96 + 30 + 12 + 1);
    expect(keep(['notes.txt', ...files.slice(0, 3)], now)).toContain('notes.txt'); // other files are never touched
  });
});
