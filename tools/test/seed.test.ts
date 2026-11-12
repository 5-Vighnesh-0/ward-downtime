import { describe, expect, it } from 'vitest';
import { makeSeed } from '../src/seed.ts';
import { scanText } from '../src/synthetic-check.ts';

const opts = { beds: 60, staff: 12, patients: 50, seed: 7 };

describe('makeSeed', () => {
  it('is deterministic for a given seed', () => {
    expect(makeSeed(opts)).toEqual(makeSeed(opts));
    expect(makeSeed(opts)).not.toEqual(makeSeed({ ...opts, seed: 8 }));
  });

  it('produces IDs in the design.md formats', () => {
    const s = makeSeed(opts);
    expect(s.beds.map((b) => b.bedId).every((id) => /^B\d{2}$/.test(id))).toBe(true);
    expect(s.staff.every((x) => /^S-\d{4}$/.test(x.staffId))).toBe(true);
    expect(s.patients.every((p) => /^T-[A-Z0-9]{3}-\d{4}$/.test(p.patientId))).toBe(true);
    expect(s.patients.every((p) => p.label.length >= 1 && p.label.length <= 40)).toBe(true);
    expect(new Set(s.staff.map((x) => x.role))).toEqual(new Set(['admin', 'charge', 'clerk', 'nurse']));
  });

  it('holds only label + temp ID per patient (SEC-16) and passes the synthetic check', () => {
    const s = makeSeed(opts);
    expect(s.patients.every((p) => Object.keys(p).sort().join() === 'label,patientId')).toBe(true);
    expect(scanText('seed.json', JSON.stringify(s, null, 2))).toEqual([]);
  });

  it('rejects out-of-range sizes', () => {
    expect(() => makeSeed({ ...opts, beds: 61 })).toThrow(/beds/);
    expect(() => makeSeed({ ...opts, staff: 0 })).toThrow(/staff/);
    expect(() => makeSeed({ ...opts, patients: 1.5 })).toThrow(/patients/);
  });
});
