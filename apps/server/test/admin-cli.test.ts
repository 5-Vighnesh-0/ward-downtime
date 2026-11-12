// Bootstrap commands: the first admin and the first device cannot be approved through the API.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { addStaffMember, approveDevice } from '../src/admin.ts';
import { checkPin } from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { addDevice, APP_URL, OWNER_URL, reset } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);

afterAll(async () => {
  await pool.end();
  await owner.end();
});
beforeEach(() => reset(owner));

describe('admin-cli', () => {
  it('adds a staff member with a hashed PIN', async () => {
    await addStaffMember(db, { staffId: 'S-0009', role: 'admin', displayName: 'Ada Admin', pin: '482913' });
    const [row] = (await owner.query("SELECT role, status, pin_hash, pin_salt FROM staff WHERE staff_id = 'S-0009'")).rows;
    expect(row).toMatchObject({ role: 'admin', status: 'active' });
    expect(await checkPin('482913', row.pin_hash, row.pin_salt)).toBe(true);
    await expect(addStaffMember(db, { staffId: 'S-0010', role: 'clerk', displayName: 'x', pin: '12' })).rejects.toThrow(/PIN/);
    await expect(addStaffMember(db, { staffId: 'bad', role: 'clerk', displayName: 'x', pin: '482913' })).rejects.toThrow();
  });

  it('approves a pending device and assigns a prefix', async () => {
    const d = await addDevice(pool, 'pending');
    const prefix = await approveDevice(db, d.deviceId);
    expect(prefix).toMatch(/^[0-9BCDFGHJKMNPQRSTVWXYZ]{3}$/);
    const [row] = (await owner.query('SELECT status, temp_prefix FROM devices WHERE device_id = $1', [d.deviceId])).rows;
    expect(row).toEqual({ status: 'active', temp_prefix: prefix });
    await expect(approveDevice(db, d.deviceId)).rejects.toThrow(/not pending/);
  });
});
