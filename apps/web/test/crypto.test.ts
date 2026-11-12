// The device must produce the exact bytes the server checks: signatures (SEC-9) and chain hashes (SEC-10).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { entryHash as serverEntryHash, GENESIS_HASH } from '@wdb/server/src/chain.ts';
import { publicKeyFromRaw, verifySignature } from '@wdb/server/src/signature.ts';
import { parseDeviceSig, verifyDeviceSig } from '@wdb/server/src/auth.ts';
import type { AnyEvent } from '@wdb/shared';
import { deviceSigHeader, entryHash, newDeviceKey, rawPublicKey, signEvent } from '../src/sync/crypto.ts';
import { backoffMs, parseSse } from '../src/sync/engine.ts';

const unsigned = (label: string, deviceSeq: number): Omit<AnyEvent, 'sig'> => ({
  v: 1,
  eventId: '0d6e9a51-3c1b-4b8e-a0d5-1f6f2a9e7c33',
  type: 'ADMIT',
  deviceId: '3b0e6a8e-6d1c-4f37-9b0a-2f9d1d2c7a10',
  deviceSeq,
  staffId: 'S-0003',
  basedOn: 0,
  hlc: '1762852443120.0.K3P',
  clientTime: '2026-11-11T09:14:03.120Z',
  payload: { patientId: 'T-K3P-0007', label, bedId: 'B04' },
});

describe('device crypto matches the server', () => {
  it('event signatures verify with the server code', async () => {
    const pair = await newDeviceKey();
    const key = publicKeyFromRaw(Buffer.from(await rawPublicKey(pair), 'base64url'));
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 1e6 }), async (label, seq) => {
        const e = await signEvent(unsigned(label, seq), pair.privateKey);
        expect(verifySignature(e, key)).toBe(true);
        expect(verifySignature({ ...e, deviceSeq: seq + 1 }, key)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('device-signature headers verify with the server code', async () => {
    const pair = await newDeviceKey();
    const key = publicKeyFromRaw(Buffer.from(await rawPublicKey(pair), 'base64url'));
    const now = Date.now();
    const header = await deviceSigHeader('3b0e6a8e-6d1c-4f37-9b0a-2f9d1d2c7a10', pair.privateKey, 'POST', '/api/v1/sessions', now);
    const p = parseDeviceSig(header);
    expect(p && verifyDeviceSig(p, 'POST', '/api/v1/sessions', key, Math.floor(now / 1000))).toBe(true);
    expect(p && verifyDeviceSig(p, 'GET', '/api/v1/sessions', key, Math.floor(now / 1000))).toBe(false);
  });

  it('chain hashes equal the server hashes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 1e6 }), async (label, seq) => {
        const event = { ...unsigned(label, seq), sig: 'A'.repeat(86) } as AnyEvent;
        const serverTime = '2026-11-11T00:00:00.000Z';
        const expected = serverEntryHash(GENESIS_HASH, seq, serverTime, event).toString('hex');
        expect(await entryHash(GENESIS_HASH.toString('hex'), { serverSeq: seq, serverTime, event })).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('non-extractable private key, readable public key', async () => {
    const pair = await newDeviceKey();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });
});

describe('parseSse', () => {
  it('splits frames, joins data lines, skips pings and keeps the partial tail', () => {
    const { frames, rest } = parseSse(': ping\n\nid: 3\nevent: appended\ndata: {"a":\ndata: 1}\n\nevent: resync\ndata: {}\n\nid: 4\nev');
    expect(frames).toEqual([
      { id: '3', event: 'appended', data: '{"a":\n1}' },
      { event: 'resync', data: '{}' },
    ]);
    expect(rest).toBe('id: 4\nev');
  });
});

describe('backoffMs', () => {
  it('is full jitter, doubling from 1 s and capped at 60 s', () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
    expect(backoffMs(5, () => 0)).toBe(0);
  });
});
