// SEC-T-TAMPER, INT-CHAIN: the log is append-only for the app and tampering by the owner is detected.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { appendBatch } from '../src/append.ts';
import { createDb } from '../src/db.ts';
import { verifyChain } from '../src/verify-chain.ts';
import { addDevice, addStaff, admitOn, APP_URL, OWNER_URL, reset } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);

afterAll(async () => {
  await pool.end();
  await owner.end();
});

beforeEach(async () => {
  await reset(owner);
  await addStaff(pool, 'S-0001', 'clerk');
  const d = await addDevice(pool);
  await appendBatch(db, d.deviceId, [admitOn(d, 1), admitOn(d, 2), admitOn(d, 3)]);
});

describe('append-only log', () => {
  it('the app role cannot update, delete or truncate history', async () => {
    for (const q of ["UPDATE events SET type = 'X'", 'DELETE FROM events', 'TRUNCATE events', 'DELETE FROM audit_log']) {
      await expect(pool.query(q)).rejects.toThrow(/permission denied/);
    }
  });

  it('a trigger blocks updates and deletes even for the owner', async () => {
    await expect(owner.query("UPDATE events SET type = 'X' WHERE server_seq = 2")).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM events WHERE server_seq = 3')).rejects.toThrow(/append-only/);
  });

  it('verify-chain passes on an untouched log', async () => {
    expect(await verifyChain(db)).toMatchObject({ ok: true, headSeq: 3 });
  });

  it('verify-chain finds an owner who disables the trigger and edits history', async () => {
    await owner.query('ALTER TABLE events DISABLE TRIGGER events_append_only');
    try {
      await owner.query(`UPDATE events SET body = jsonb_set(body, '{payload,label}', '"Edited"') WHERE server_seq = 2`);
    } finally {
      await owner.query('ALTER TABLE events ENABLE TRIGGER events_append_only');
    }
    expect(await verifyChain(db)).toMatchObject({ ok: false, firstBadSeq: 2 });
  });

  it('verify-chain notices a log_head that does not match the last entry', async () => {
    await owner.query('UPDATE log_head SET last_seq = 2');
    expect(await verifyChain(db)).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
  });
});
