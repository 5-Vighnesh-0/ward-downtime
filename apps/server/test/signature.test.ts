// PB-07 (signature part): Ed25519 over the canonical signing input (SEC-9).
import { generateKeyPairSync } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { publicKeyFromRaw, verifySignature } from '../src/signature.ts';
import { signed, type TestDevice } from './support.ts';

fc.configureGlobal({ seed: 42, numRuns: 300 });

function device(): { d: TestDevice; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { d: { deviceId: '00000000-0000-4000-8000-000000000001', privateKey, seq: 0 }, raw };
}

describe('verifySignature', () => {
  const a = device();
  const b = device();
  const keyA = publicKeyFromRaw(a.raw);

  it('accepts what the device signed and rejects any change', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 39 }).filter((s) => !/[\u0000-\u001f\u007f]/.test(s)), (label) => {
        const e = signed(a.d, 'RENAME', { patientId: 'T-AAA-0001', label });
        expect(verifySignature(e, keyA)).toBe(true);
        expect(verifySignature({ ...e, payload: { ...e.payload, label: `${label}x` } }, keyA)).toBe(false);
        expect(verifySignature({ ...e, deviceSeq: e.deviceSeq + 1 }, keyA)).toBe(false);
        expect(verifySignature({ ...e, staffId: 'S-9999' }, keyA)).toBe(false);
      }),
    );
  });

  it('rejects a signature from another key, and garbage signatures', () => {
    const e = signed(b.d, 'RENAME', { patientId: 'T-AAA-0001', label: 'x' });
    expect(verifySignature(e, keyA)).toBe(false);
    expect(verifySignature({ ...e, sig: 'A'.repeat(86) }, publicKeyFromRaw(b.raw))).toBe(false);
  });

  it('refuses public keys that are not 32 bytes', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow();
  });
});
