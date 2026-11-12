// PB-08: the hash chain detects any change, removal or reordering (SEC-10).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AnyEvent } from '@wdb/shared';
import { entryHash, GENESIS_HASH, verifyEntries, type LedgerEntry } from '../src/chain.ts';

fc.configureGlobal({ seed: 42, numRuns: 500 });

const fakeEvent = (label: string, i: number) =>
  ({ v: 1, eventId: `e-${i}`, type: 'RENAME', payload: { patientId: 'T-AAA-0001', label } }) as unknown as AnyEvent;

function chain(labels: string[]): LedgerEntry[] {
  let prev = GENESIS_HASH;
  return labels.map((label, i) => {
    const serverSeq = i + 1;
    const serverTime = new Date(Date.UTC(2026, 10, 11, 0, 0, i)).toISOString();
    const event = fakeEvent(label, i);
    const hash = entryHash(prev, serverSeq, serverTime, event);
    const entry = { serverSeq, serverTime, prevHash: prev.toString('hex'), hash: hash.toString('hex'), event };
    prev = hash;
    return entry;
  });
}

const labels = fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 20 });

describe('hash chain', () => {
  it('accepts an untouched chain and reports its head', () => {
    fc.assert(
      fc.property(labels, (ls) => {
        const c = chain(ls);
        expect(verifyEntries(c)).toEqual({ ok: true, headSeq: c.length, headHash: c.at(-1)?.hash });
      }),
    );
    expect(verifyEntries([])).toEqual({ ok: true, headSeq: 0, headHash: GENESIS_HASH.toString('hex') });
  });

  it('pins the hash to known bytes (golden value guards accidental format changes)', () => {
    const h = entryHash(GENESIS_HASH, 1, '2026-11-11T00:00:00.000Z', fakeEvent('x', 0));
    // Cross-checked with Python: sha256(32 zero bytes + the canonical JSON of {event, serverSeq, serverTime}).
    expect(h.toString('hex')).toBe('1cf2e5468960634f9596d84c835a8edd0f149a60202a8c7f4f9e8436991a14d8');
    expect(h).not.toEqual(entryHash(GENESIS_HASH, 1, '2026-11-11T00:00:00.001Z', fakeEvent('x', 0)));
    expect(h).not.toEqual(entryHash(GENESIS_HASH, 2, '2026-11-11T00:00:00.000Z', fakeEvent('x', 0)));
  });

  it('finds the first entry whose event was edited', () => {
    fc.assert(
      fc.property(labels, fc.nat(), (ls, k) => {
        const c = chain(ls);
        const i = k % c.length;
        const bad = c.map((e, j) => (j === i ? { ...e, event: fakeEvent(`${ls[i]}!`, i) } : e));
        expect(verifyEntries(bad)).toMatchObject({ ok: false, firstBadSeq: i + 1 });
      }),
    );
  });

  it('detects a removed or reordered entry', () => {
    fc.assert(
      fc.property(labels.filter((l) => l.length >= 2), fc.nat(), (ls, k) => {
        const c = chain(ls);
        const i = k % c.length;
        const removed = c.filter((_, j) => j !== i);
        expect(verifyEntries(removed).ok).toBe(i === c.length - 1); // dropping the tail is only caught against log_head
        const swapped = [...c];
        const j = (i + 1) % c.length;
        [swapped[i], swapped[j]] = [c[j] as LedgerEntry, c[i] as LedgerEntry];
        expect(verifyEntries(swapped)).toMatchObject({ ok: false, firstBadSeq: Math.min(i, j) + 1 });
      }),
    );
  });

  it('detects a forged hash even when prevHash links are rewritten to match', () => {
    const c = chain(['a', 'b', 'c']);
    const forged = c.map((e) => ({ ...e }));
    const second = forged[1] as LedgerEntry;
    second.hash = 'f'.repeat(64);
    (forged[2] as LedgerEntry).prevHash = second.hash;
    expect(verifyEntries(forged)).toMatchObject({ ok: false, firstBadSeq: 2 });
  });
});
