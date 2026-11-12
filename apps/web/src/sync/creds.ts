// Offline sign-in (design.md §9.4.3, SEC-7). Not signed: editing the role locally only changes what the UI offers,
// because the server re-checks the role of every pushed event (§9.5).
import type { Role } from '@wdb/shared';
import { fromBase64url, toBase64url } from './crypto.ts';
import type { WdbDb } from './db.ts';

const ITERATIONS = 600_000;
const MAX_FAILURES = 5;

async function verifier(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return toBase64url(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)));
}

/** After an online sign-in: keep a PIN verifier so this staff member can sign in here offline until `expiresAt`. */
export async function saveCred(db: WdbDb, s: { staffId: string; role: Role; expiresAt: string }, pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await verifier(pin, salt, ITERATIONS);
  await db.creds.put({ staffId: s.staffId, role: s.role, exp: s.expiresAt, salt: toBase64url(salt), hash, iterations: ITERATIONS, failCount: 0 });
}

export type OfflineResult =
  | { ok: true; role: Role }
  | { ok: false; reason: 'NO_CREDENTIAL' | 'EXPIRED' | 'WIPED' }
  | { ok: false; reason: 'WRONG_PIN'; triesLeft: number };

export async function checkOffline(db: WdbDb, staffId: string, pin: string, nowMs: number): Promise<OfflineResult> {
  const c = await db.creds.get(staffId);
  if (!c) return { ok: false, reason: 'NO_CREDENTIAL' };
  if (Date.parse(c.exp) <= nowMs) return { ok: false, reason: 'EXPIRED' };
  const h = await verifier(pin, fromBase64url(c.salt), c.iterations);
  if (h === c.hash) {
    if (c.failCount) await db.creds.update(staffId, { failCount: 0 });
    return { ok: true, role: c.role };
  }
  if (c.failCount + 1 >= MAX_FAILURES) {
    await db.creds.delete(staffId); // online sign-in required from now on
    return { ok: false, reason: 'WIPED' };
  }
  await db.creds.update(staffId, { failCount: c.failCount + 1 });
  return { ok: false, reason: 'WRONG_PIN', triesLeft: MAX_FAILURES - c.failCount - 1 };
}
