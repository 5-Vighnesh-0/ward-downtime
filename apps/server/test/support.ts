import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import pg from 'pg';
import { signingInput, type AnyEvent, type EventType } from '@wdb/shared';
import { hashPin } from '../src/auth.ts';

// Throwaway test database from compose.yaml (trust auth, localhost only).
export const OWNER_URL = 'postgres://wdb_owner@127.0.0.1:55432/wdb_test';
export const APP_URL = 'postgres://wdb_app@127.0.0.1:55432/wdb_test';
export const ORIGIN = 'https://wdb.test';
export const CSRF = { 'x-wdb-request': '1' } as const;

export async function reset(owner: pg.Pool): Promise<void> {
  await owner.query(`TRUNCATE events, audit_log, sessions, devices, staff RESTART IDENTITY CASCADE`);
  await owner.query(`UPDATE log_head SET last_seq = 0, last_hash = decode(repeat('00', 32), 'hex')`);
}

export async function addStaff(pool: pg.Pool, staffId: string, role: string, status = 'active', pin?: string): Promise<void> {
  const { hash, salt } = pin ? await hashPin(pin) : { hash: Buffer.alloc(32), salt: Buffer.alloc(16) };
  await pool.query(
    `INSERT INTO staff (staff_id, display_name, role, pin_hash, pin_salt, status) VALUES ($1, $2, $3, $4, $5, $6)`,
    [staffId, `Test ${staffId}`, role, hash, salt, status],
  );
}

/** Inserts a live session directly (sign-in itself is tested in session.test.ts). Returns the Cookie header. */
export async function sessionCookie(pool: pg.Pool, staffId: string, deviceId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, staff_id, device_id, expires_at) VALUES ($1, $2, $3, now() + interval '12 hours')`,
    [createHash('sha256').update(token).digest(), staffId, deviceId],
  );
  return `wdb_sid=${token}`;
}

/** X-WDB-Device-Sig header value (design.md §9.2). */
export function deviceSig(d: TestDevice, method: string, path: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const sig = sign(null, Buffer.from(`${method} ${path} ${unixSeconds}`), d.privateKey).toString('base64url');
  return `${d.deviceId}.${unixSeconds}.${sig}`;
}

export interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  seq: number;
  publicKeyRaw?: Buffer;
}

export async function addDevice(pool: pg.Pool, status = 'active'): Promise<TestDevice> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  const deviceId = randomUUID();
  await pool.query(
    `INSERT INTO devices (device_id, public_key, fingerprint, label, status) VALUES ($1, $2, 'TESTFINGERPR', 'test tablet', $3)`,
    [deviceId, raw, status],
  );
  return { deviceId, privateKey, seq: 0, publicKeyRaw: raw };
}

type EventOf<T extends EventType> = Extract<AnyEvent, { type: T }>;

export const signEvent = (e: AnyEvent, key: KeyObject): AnyEvent => ({
  ...e,
  sig: sign(null, Buffer.from(signingInput(e)), key).toString('base64url'),
});

export function signed<T extends EventType>(
  d: TestDevice,
  type: T,
  payload: EventOf<T>['payload'],
  o: { staffId?: string; basedOn?: number; eventId?: string; deviceSeq?: number; clientTime?: string } = {},
): EventOf<T> {
  d.seq = o.deviceSeq ?? d.seq + 1;
  const unsigned = {
    v: 1,
    eventId: o.eventId ?? randomUUID(),
    type,
    deviceId: d.deviceId,
    deviceSeq: d.seq,
    staffId: o.staffId ?? 'S-0001',
    basedOn: o.basedOn ?? 0,
    hlc: '1762852443120.0.K3P',
    clientTime: o.clientTime ?? '2026-11-11T09:14:03.120Z',
    payload,
    sig: 'A'.repeat(86),
  } as EventOf<T>;
  return signEvent(unsigned, d.privateKey) as EventOf<T>;
}

export const admitOn = (d: TestDevice, n: number, o: Parameters<typeof signed>[3] = {}) =>
  signed(d, 'ADMIT', { patientId: `T-TST-${String(n).padStart(4, '0')}`, label: `Patient ${n}`, bedId: 'B01' }, o);
