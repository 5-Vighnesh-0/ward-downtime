import { describe, expect, it } from 'vitest';
import { labelsFromPatientsCsv, parseCsvLine } from '../src/synthea-labels.ts';

describe('parseCsvLine', () => {
  it('handles quoted commas and escaped quotes', () => {
    expect(parseCsvLine('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"']);
    expect(parseCsvLine('a,,b')).toEqual(['a', '', 'b']);
  });
});

describe('labelsFromPatientsCsv', () => {
  // Hand-written stand-in for Synthea's patients.csv: same column names, fake values.
  const csv = [
    'Id,BIRTHDATE,SSN,PREFIX,FIRST,MIDDLE,LAST,ADDRESS',
    'p1,2001-01-01,X,Mr.,Jacinto644,,Kris249,"1 Fake St, Apt 2"',
    'p2,1999-09-09,X,,Lena12,Q,Orr87,"2 Fake Rd"',
    '',
  ].join('\n');

  it('keeps only "First Last" labels', () => {
    expect(labelsFromPatientsCsv(csv)).toEqual(['Jacinto644 Kris249', 'Lena12 Orr87']);
  });

  it('drops every other field', () => {
    const out = JSON.stringify(labelsFromPatientsCsv(csv));
    for (const leaked of ['2001-01-01', 'Fake St', 'p1', 'Mr.']) expect(out).not.toContain(leaked);
  });

  it('caps labels at 40 characters', () => {
    const long = `Id,FIRST,LAST\np,${'A'.repeat(30)},${'B'.repeat(30)}`;
    expect(labelsFromPatientsCsv(long)[0]).toHaveLength(40);
  });

  it('fails loudly if the columns are missing', () => {
    expect(() => labelsFromPatientsCsv('Id,NAME\n1,x')).toThrow(/FIRST\/LAST/);
  });
});
