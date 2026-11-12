import { describe, expect, it } from 'vitest';
import { scanText } from '../src/synthetic-check.ts';

// Trigger strings are assembled at runtime so this file itself passes the repo scan.
const ssn = ['123', '45', '6789'].join('-');
const at = '@';

describe('scanText', () => {
  it('flags SSN-shaped numbers', () => {
    expect(scanText('f', `id ${ssn}`)).toMatchObject([{ rule: 'ssn', line: 1 }]);
  });

  it('flags MRN-like identifiers', () => {
    expect(scanText('f', `${'MR'}N: 1234567`)[0]?.rule).toBe('mrn');
  });

  it('flags real email domains but allows reserved ones', () => {
    expect(scanText('f', `pat${at}gmail.com`)[0]?.rule).toBe('email');
    expect(scanText('f', `pat${at}example.com nurse${at}ward.test`)).toEqual([]);
  });

  it('flags DOB-like fields', () => {
    expect(scanText('f', `{"${'dob'}": "x"}`)[0]?.rule).toBe('dob-field');
    expect(scanText('f', `birth${'_'}date = 1`)[0]?.rule).toBe('dob-field');
  });

  it('ignores ISO dates, versions and package specs', () => {
    expect(scanText('f', '2026-11-11 pnpm@10.34.5 @types/node T-SD0-0001')).toEqual([]);
  });

  it('reports the line number', () => {
    expect(scanText('f', `a\nb\n${ssn}`)[0]?.line).toBe(3);
  });
});
