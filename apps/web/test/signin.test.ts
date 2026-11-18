// Sign-in screen logic against the real server (SEC-7, FR-13, NFR-Offline): when the ward server cannot answer,
// the tablet falls back to the offline PIN check instead of saying the PIN is wrong.
import { afterEach, describe, expect, it } from 'vitest';
import { copy } from '../src/copy.en.ts';
import { signInAnywhere } from '../src/screens/Access.tsx';
import { PIN, startWard, tablet, type Tablet, type Ward } from './support.ts';

let ward: Ward;
let t: Tablet;
afterEach(async () => {
  t?.engine.stop();
  await ward?.close();
});

async function signedInOnce(): Promise<string> {
  ward = await startWard();
  t = await tablet(ward, 'nurse');
  const staffId = (await t.db.session.get('current'))?.staffId ?? '';
  expect(await signInAnywhere(t.db, t.net, staffId, PIN)).toBeNull(); // online: also saves the offline credential
  await t.db.session.delete('current');
  return staffId;
}

/** Replaces the tablet's network with one that always gets this reply. */
function answer(status: number, body: unknown): void {
  t.net.fetch = async () => new Response(body === null ? 'Bad Gateway' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('signInAnywhere', () => {
  it.each([
    ['a proxy answers 502 because the ward server is down', 502, null],
    ['the server answers 500 because its database is down', 500, { error: { code: 'INTERNAL', message: 'Internal error' } }],
  ])('uses the offline PIN when %s', async (_, status, body) => {
    const staffId = await signedInOnce();
    answer(status, body);
    expect(await signInAnywhere(t.db, t.net, staffId, PIN)).toBeNull();
    expect(await t.db.session.get('current')).toMatchObject({ staffId, role: 'nurse' });
    answer(status, body);
    expect(await signInAnywhere(t.db, t.net, staffId, '000000')).toBe(copy.wrongPin(4)); // the offline check still counts tries
  });

  it('says the tablet cannot be verified (clock off, or unknown after a restore) instead of signing in offline', async () => {
    const staffId = await signedInOnce();
    answer(401, { error: { code: 'DEVICE_SIG_INVALID', message: 'Bad device signature' } });
    expect(await signInAnywhere(t.db, t.net, staffId, PIN)).toBe(copy.deviceSigInvalid);
    expect(await t.db.session.get('current')).toBeUndefined();
  });

  it('still refuses a wrong PIN the server checked, without trying offline', async () => {
    const staffId = await signedInOnce();
    expect(await signInAnywhere(t.db, t.net, staffId, '000000')).toBe(copy.wrongPinOnline);
    expect(await t.db.session.get('current')).toBeUndefined();
  });
});
