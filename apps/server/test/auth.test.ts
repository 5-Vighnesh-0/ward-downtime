// Unit tests for the auth building blocks (SEC-4, SEC-5).
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPin, fingerprint, hashPin, newTempPrefix, parseDeviceSig, verifyDeviceSig } from '../src/auth.ts';
import { publicKeyFromRaw } from '../src/signature.ts';
import { deviceSig, type TestDevice } from './support.ts';

function device(): { d: TestDevice; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { d: { deviceId: '00000000-0000-4000-8000-000000000001', privateKey, seq: 0 }, raw };
}

describe('PINs', () => {
  it('verifies the right PIN, rejects others, and salts every hash', async () => {
    const a = await hashPin('482913');
    const b = await hashPin('482913');
    expect(a.hash.equals(b.hash)).toBe(false);
    expect(await checkPin('482913', a.hash, a.salt)).toBe(true);
    expect(await checkPin('482914', a.hash, a.salt)).toBe(false);
    expect(await checkPin('', a.hash, a.salt)).toBe(false);
  });
});

describe('device identity', () => {
  it('fingerprint: 12 Crockford base32 characters, stable per key', () => {
    const { raw } = device();
    expect(fingerprint(raw)).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(fingerprint(raw)).toBe(fingerprint(Buffer.from(raw)));
    expect(fingerprint(device().raw)).not.toBe(fingerprint(raw));
  });

  it('temp prefix: 3 characters, no vowels, no ambiguous letters', () => {
    for (let i = 0; i < 200; i++) expect(newTempPrefix()).toMatch(/^[0-9BCDFGHJKMNPQRSTVWXYZ]{3}$/);
  });
});

describe('device signature header', () => {
  const { d, raw } = device();
  const key = publicKeyFromRaw(raw);
  const now = 1_762_852_443;
  const ok = (header: string, method = 'POST', path = '/api/v1/sessions', at = now) => {
    const p = parseDeviceSig(header);
    return p !== null && p.deviceId === d.deviceId && verifyDeviceSig(p, method, path, key, at);
  };

  it('accepts a fresh signature over method, path and time', () => {
    expect(ok(deviceSig(d, 'POST', '/api/v1/sessions', now))).toBe(true);
    expect(ok(deviceSig(d, 'POST', '/api/v1/sessions', now - 299))).toBe(true);
  });

  it('rejects another method, path or key', () => {
    expect(ok(deviceSig(d, 'GET', '/api/v1/sessions', now))).toBe(false);
    expect(ok(deviceSig(d, 'POST', '/api/v1/events', now))).toBe(false);
    expect(ok(deviceSig(device().d, 'POST', '/api/v1/sessions', now))).toBe(false);
  });

  it('rejects signatures more than 300 s old or ahead', () => {
    expect(ok(deviceSig(d, 'POST', '/api/v1/sessions', now - 301))).toBe(false);
    expect(ok(deviceSig(d, 'POST', '/api/v1/sessions', now + 301))).toBe(false);
  });

  it('rejects malformed headers', () => {
    for (const h of ['', 'x', `${d.deviceId}.abc.sig`, `${d.deviceId}.${now}`, `not-a-uuid.${now}.AAAA`]) {
      expect(parseDeviceSig(h)).toBeNull();
    }
  });
});
