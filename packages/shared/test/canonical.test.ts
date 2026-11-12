// PB-07 (canonical part): RFC 8785 JSON canonicalization used for signatures and the hash chain.
import { describe, expect, it } from 'vitest';
import { ALLOWED_ROLES, canonicalize, signingInput } from '../src/index.ts';
import { ev } from './helpers.ts';
import { fc } from './prop/fc.ts';

const shuffleKeys = (v: unknown, seed: number): unknown => {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    const rotated = entries.slice(seed % (entries.length || 1)).concat(entries.slice(0, seed % (entries.length || 1)));
    return Object.fromEntries(rotated.reverse().map(([k, x]) => [k, shuffleKeys(x, seed)]));
  }
  return v;
};

describe('canonicalize', () => {
  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3)', () => {
    const keys = ['\u20ac', '\r', '\ufb33', '1', '\ud83d\ude00', '\u0080', '\u00f6'];
    const sorted = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'];
    const expected = `{${sorted.map((k) => `${JSON.stringify(k)}:0`).join(',')}}`;
    expect(canonicalize(Object.fromEntries(keys.map((k) => [k, 0])))).toBe(expected);
  });

  it('has no whitespace and serializes -0 as 0', () => {
    expect(canonicalize({ b: [1, { a: null }], a: true, c: -0 })).toBe('{"a":true,"b":[1,{"a":null}],"c":0}');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });

  it('is independent of key order and stable through a parse round trip', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.nat(), (v, seed) => {
        const c = canonicalize(v);
        expect(canonicalize(shuffleKeys(v, seed))).toBe(c);
        expect(canonicalize(JSON.parse(c))).toBe(c);
      }),
    );
  });

  it('signingInput covers every field except sig', () => {
    const e = ev('RENAME', { patientId: 'T-AAA-0001', label: 'x' });
    const input = signingInput(e);
    expect(JSON.parse(input)).toEqual({ ...e, sig: undefined });
    expect(input).not.toContain(e.sig);
    expect(signingInput({ ...e, sig: 'B'.repeat(86) })).toBe(input);
    expect(signingInput({ ...e, payload: { ...e.payload, label: 'y' } })).not.toBe(input);
  });
});

describe('ALLOWED_ROLES (design.md §9.5)', () => {
  it('lets only charge and admin resolve, only admin configure', () => {
    expect(ALLOWED_ROLES.RESOLVE_CONFLICT).toEqual(['charge', 'admin']);
    expect(ALLOWED_ROLES.WARD_CONFIGURED).toEqual(['admin']);
    for (const t of ['ADMIT', 'DISCHARGE', 'TRANSFER', 'RENAME'] as const) {
      expect([...ALLOWED_ROLES[t]].sort()).toEqual(['admin', 'charge', 'clerk', 'nurse']);
    }
  });
});
