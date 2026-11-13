// UNIT-SCHEMA (FR-3, SEC-11, SEC-16)
import { describe, expect, it } from 'vitest';
import { EventSchema, looksLikeIdentifier, utf8Length } from '../src/index.ts';
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

  it('accepts an idle lock time of 1–15 whole minutes on WARD_CONFIGURED', () => {
    const w = (idleLockMinutes: unknown) => ev('WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'B01' }], idleLockMinutes: idleLockMinutes as number });
    expect(ok(w(1))).toBe(true);
    expect(ok(w(15))).toBe(true);
    for (const bad of [0, 16, 2.5, '5', null]) expect(ok(w(bad))).toBe(false);
  });

  it('caps serialized size at 4 KiB', () => {
    // 60 beds with 16-char labels is the largest valid event; it must fit.
    const big = ev('WARD_CONFIGURED', {
      beds: Array.from({ length: 60 }, (_, i) => ({ bedId: `B${String(i + 1).padStart(2, '0')}`, label: 'L'.repeat(16) })),
      idleLockMinutes: 15,
    });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(4096); // ASCII only, so chars = bytes
    expect(ok(big)).toBe(true);
  });

  it('counts multi-byte characters as UTF-8 bytes', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
  });
});

describe('v2 tasks (FR-15) and the free-text policy (SEC-16)', () => {
  const task = (payload: object) => ev('TASK_CREATED', payload as never);
  it('accepts a short task with optional assignee and due time', () => {
    expect(ok(task({ bedId: 'B01', title: 'Bed needs cleaning' }))).toBe(true);
    expect(ok(task({ bedId: 'B01', title: 'Call porter', assignee: 'S-0002', dueAt: '2026-11-12T14:00:00.000Z' }))).toBe(true);
    expect(ok(ev('TASK_COMPLETED', { taskId: admit().eventId }))).toBe(true);
  });

  it('bounds the title and refuses unknown fields', () => {
    expect(ok(task({ bedId: 'B01', title: 'x'.repeat(60) }))).toBe(true);
    expect(ok(task({ bedId: 'B01', title: 'x'.repeat(61) }))).toBe(false);
    expect(ok(task({ bedId: 'B01', title: '' }))).toBe(false);
    expect(ok(task({ bedId: 'B01', title: 'ok', notes: 'more' }))).toBe(false);
    expect(ok(task({ bedId: 'B01', title: 'ok', assignee: 'nurse1' }))).toBe(false);
    expect(ok(ev('TASK_COMPLETED', { taskId: 'K-1' }))).toBe(false);
  });

  it('refuses text that looks like an identifier', () => {
    // Identifier-shaped samples are built at runtime, so the repo's synthetic-data check (SEC-17) sees none.
    for (const bad of [`SSN ${['123', '45', '6789'].join('-')}`, `MRN ${'1234567'}`, `mrn#${'998877'}`, 'mail jo@example.org', 'DOB 3/4/1950', 'born 1950-03-04', 'call 555 123 4567', 'date of birth check', 'birthdate']) {
      expect(looksLikeIdentifier(bad), bad).toBe(true);
      expect(ok(task({ bedId: 'B01', title: bad })), bad).toBe(false);
    }
    for (const fine of ['Bed needs cleaning', 'Porter at 14:30', 'Family visiting 2 pm', 'Move to bay 3', 'Check 2 bags']) {
      expect(looksLikeIdentifier(fine), fine).toBe(false);
    }
  });
});
