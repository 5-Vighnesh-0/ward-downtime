// UNIT-SCHEMA (FR-3, SEC-11, SEC-16)
import { describe, expect, it } from 'vitest';
import { EventSchema, utf8Length } from '../src/index.ts';
import { ev, ward } from './helpers.ts';

const admit = () => ev('ADMIT', { patientId: 'T-K3P-0007', label: 'Rowan Ashby', bedId: 'B04' });
const ok = (e: unknown) => EventSchema.safeParse(e).success;

describe('EventSchema', () => {
  it('accepts every v1 event type', () => {
    expect(ok(admit())).toBe(true);
    expect(ok(ev('DISCHARGE', { patientId: 'T-K3P-0007', bedId: 'B04' }))).toBe(true);
    expect(ok(ev('TRANSFER', { patientId: 'T-K3P-0007', fromBedId: 'B04', toBedId: 'B09' }))).toBe(true);
    expect(ok(ev('RENAME', { patientId: 'T-K3P-0007', label: 'R. Ashby' }))).toBe(true);
    expect(ok(ev('RESOLVE_CONFLICT', { conflictId: 'C-122', keep: 'NONE', candidatesSeen: [admit().eventId] }))).toBe(true);
    expect(ok(ward('B01', 'B02'))).toBe(true);
  });

  it('rejects unknown fields at the top level and in the payload (SEC-11)', () => {
    expect(ok({ ...admit(), extra: 1 })).toBe(false);
    const e = admit();
    expect(ok({ ...e, payload: { ...e.payload, mrn: 'x' } })).toBe(false); // SEC-16: no extra patient data
  });

  it('rejects v2 and unknown types', () => {
    expect(ok({ ...admit(), type: 'TASK_CREATED' })).toBe(false);
  });

  it('enforces formats and limits', () => {
    const e = admit();
    const withPayload = (p: object) => ({ ...e, payload: { ...e.payload, ...p } });
    expect(ok(withPayload({ label: '' }))).toBe(false);
    expect(ok(withPayload({ label: 'x'.repeat(41) }))).toBe(false);
    expect(ok(withPayload({ label: 'x'.repeat(40) }))).toBe(true);
    expect(ok(withPayload({ label: 'Zoë O\'Neil-Ng' }))).toBe(true);
    expect(ok(withPayload({ label: 'a\u0000b' }))).toBe(false); // Postgres jsonb rejects NUL
    expect(ok(withPayload({ label: 'a\nb' }))).toBe(false);
    expect(ok(withPayload({ label: 'a\u007fb' }))).toBe(false);
    expect(ok(withPayload({ patientId: 'P-1' }))).toBe(false);
    expect(ok(withPayload({ bedId: 'bed4' }))).toBe(false);
    expect(ok({ ...e, eventId: 'not-a-uuid' })).toBe(false);
    expect(ok({ ...e, deviceSeq: 0 })).toBe(false);
    expect(ok({ ...e, deviceSeq: 1.5 })).toBe(false);
    expect(ok({ ...e, basedOn: -1 })).toBe(false);
    expect(ok({ ...e, staffId: 'nurse1' })).toBe(false);
    expect(ok({ ...e, clientTime: 'yesterday' })).toBe(false);
    expect(ok({ ...e, sig: 'short' })).toBe(false);
    expect(ok({ ...e, v: 2 })).toBe(false);
  });

  it('bounds WARD_CONFIGURED and RESOLVE_CONFLICT arrays', () => {
    const beds = Array.from({ length: 61 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`);
    expect(ok(ward(...beds.slice(0, 60)))).toBe(true);
    expect(ok(ward(...beds))).toBe(false); // > 60 beds
    expect(ok(ev('RESOLVE_CONFLICT', { conflictId: 'C-1', keep: 'NONE', candidatesSeen: [] }))).toBe(false);
  });

  it('caps serialized size at 4 KiB', () => {
    // 60 beds with 16-char labels is the largest valid event; it must fit.
    const big = ev('WARD_CONFIGURED', {
      beds: Array.from({ length: 60 }, (_, i) => ({ bedId: `B${String(i + 1).padStart(2, '0')}`, label: 'L'.repeat(16) })),
    });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(4096); // ASCII only, so chars = bytes
    expect(ok(big)).toBe(true);
  });

  it('counts multi-byte characters as UTF-8 bytes', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
  });
});
