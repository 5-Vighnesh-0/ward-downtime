// Staff and device administration shared by the API and the bootstrap CLI.
import { and, eq } from 'drizzle-orm';
import type { Role } from '@wdb/shared';
import { hashPin, newTempPrefix } from './auth.ts';
import { devices, sessions, staff } from './db/schema.ts';
import type { Db } from './db.ts';

export async function addStaffMember(db: Db, s: { staffId: string; role: Role; displayName: string; pin: string }): Promise<void> {
  if (!/^[0-9]{6,8}$/.test(s.pin)) throw new Error('PIN must be 6–8 digits');
  if (!/^[^\u0000-\u001f\u007f]{1,40}$/.test(s.displayName)) throw new Error('displayName must be 1–40 printable characters');
  const { hash, salt } = await hashPin(s.pin);
  await db.insert(staff).values({ staffId: s.staffId, role: s.role, displayName: s.displayName, pinHash: hash, pinSalt: salt, status: 'active' });
}

/** Role, status, display name or PIN. A PIN reset clears the lockout; disabling ends every session (SEC-8). */
export async function updateStaffMember(
  db: Db,
  staffId: string,
  u: { role?: Role; status?: 'active' | 'disabled'; displayName?: string; pin?: string },
): Promise<{ staffId: string; displayName: string; role: Role; status: string }> {
  const pin = u.pin ? await hashPin(u.pin) : null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(staff)
      .set({
        ...(u.role ? { role: u.role } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(pin ? { pinHash: pin.hash, pinSalt: pin.salt, failedAttempts: 0, lockedUntil: null } : {}),
      })
      .where(eq(staff.staffId, staffId))
      .returning({ staffId: staff.staffId, displayName: staff.displayName, role: staff.role, status: staff.status });
    if (!row) throw new AdminError('NOT_FOUND', 'Staff member not found');
    if (u.status === 'disabled') await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.staffId, staffId));
    return row;
  });
}

export class AdminError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_PENDING';
  constructor(code: 'NOT_FOUND' | 'NOT_PENDING', message = code === 'NOT_FOUND' ? 'Device not found' : 'Device is not pending') {
    super(message);
    this.code = code;
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string; cause?: { code?: string } }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505';

/** pending → active, with a unique temp-ID prefix (design.md §7.1). Returns the prefix. */
export async function approveDevice(db: Db, deviceId: string, approvedBy: string | null = null): Promise<string> {
  const [dev] = await db.select({ status: devices.status }).from(devices).where(eq(devices.deviceId, deviceId));
  if (!dev) throw new AdminError('NOT_FOUND');
  if (dev.status !== 'pending') throw new AdminError('NOT_PENDING');
  for (let attempt = 0; attempt < 50; attempt++) {
    const tempPrefix = newTempPrefix();
    try {
      const [row] = await db
        .update(devices)
        .set({ status: 'active', tempPrefix, approvedBy, approvedAt: new Date() })
        .where(and(eq(devices.deviceId, deviceId), eq(devices.status, 'pending')))
        .returning({ tempPrefix: devices.tempPrefix });
      if (!row) throw new AdminError('NOT_PENDING'); // approved concurrently
      return tempPrefix;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // prefix already taken: try another
    }
  }
  throw new Error('could not find a free temp-ID prefix');
}

/** Any status → revoked; every session of the device ends (SEC-8). */
export async function revokeDevice(db: Db, deviceId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx.update(devices).set({ status: 'revoked', revokedAt: now }).where(eq(devices.deviceId, deviceId)).returning({ id: devices.deviceId });
    if (!row) throw new AdminError('NOT_FOUND');
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.deviceId, deviceId));
  });
}
