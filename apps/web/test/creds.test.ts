// SEC-7 offline sign-in: PIN verifier, expiry, 5-failure wipe (design.md §9.4.3).
import { describe, expect, it } from 'vitest';
import { checkOffline, saveCred } from '../src/sync/creds.ts';
import { openDb } from '../src/sync/db.ts';

const HOUR = 3_600_000;
let n = 0;
const fresh = () => openDb(`creds-test-${++n}`);

describe('offline credential', () => {
  it('accepts the right PIN until it expires, and stores no PIN', async () => {
    const db = fresh();
    const now = Date.now();
    await saveCred(db, { staffId: 'S-0001', role: 'nurse', expiresAt: new Date(now + 12 * HOUR).toISOString() }, '482913');
    const stored = await db.creds.get('S-0001');
    expect(stored?.iterations).toBe(600_000);
    expect(JSON.stringify(stored)).not.toContain('482913');
    expect(await checkOffline(db, 'S-0001', '482913', now)).toEqual({ ok: true, role: 'nurse' });
    expect(await checkOffline(db, 'S-0001', '482913', now + 13 * HOUR)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(await checkOffline(db, 'S-0077', '482913', now)).toEqual({ ok: false, reason: 'NO_CREDENTIAL' });
  });

  it('deletes the credential after 5 wrong PINs; a right PIN resets the count', async () => {
    const db = fresh();
    const now = Date.now();
    await saveCred(db, { staffId: 'S-0001', role: 'nurse', expiresAt: new Date(now + HOUR).toISOString() }, '482913');
    for (let i = 0; i < 4; i++) expect(await checkOffline(db, 'S-0001', '000000', now)).toEqual({ ok: false, reason: 'WRONG_PIN', triesLeft: 4 - i });
    expect((await checkOffline(db, 'S-0001', '482913', now)).ok).toBe(true);
    for (let i = 0; i < 4; i++) await checkOffline(db, 'S-0001', '000000', now);
    expect(await checkOffline(db, 'S-0001', '000000', now)).toEqual({ ok: false, reason: 'WIPED' });
    expect(await db.creds.get('S-0001')).toBeUndefined();
  }, 60_000);
});
