// UNIT-EXPORT (design.md §7.2, FR-11, prd.md acceptance 6): applied events only, original times, temp IDs, safe CSV.
import { describe, expect, it } from 'vitest';
import { buildRecoveryExport, csvCell, type AnyEvent, type LedgerLike } from '../src/index.ts';
import { DEVICE, ev, ward } from './helpers.ts';
import { fc } from './prop/fc.ts';

const at = (events: AnyEvent[]): LedgerLike[] =>
  events.map((event, i) => ({ serverSeq: i + 1, serverTime: `2026-11-11T10:00:${String(i).padStart(2, '0')}.000Z`, hash: `h${i + 1}`, event }));

const opts = { generatedAt: '2026-11-11T14:02:11.000Z', ward: 'Ward A', source: 'server' as const, deviceLabels: { [DEVICE.A]: 'Bay A tablet 1' } };

describe('buildRecoveryExport', () => {
  it('keeps applied patient events only, with original tablet times and temp IDs (acceptance 6)', () => {
    const a = ev('ADMIT', { patientId: 'T-K3P-0001', label: 'Rowan Ashby', bedId: 'B01' }, { device: DEVICE.A });
    const b = ev('ADMIT', { patientId: 'T-M7Q-0001', label: 'Imani Calloway', bedId: 'B01' }, { device: DEVICE.B });
    const resolve = ev('RESOLVE_CONFLICT', { conflictId: 'C-3', keep: b.eventId, candidatesSeen: [a.eventId, b.eventId] });
    const empty = ev('DISCHARGE', { patientId: 'T-K3P-0099', bedId: 'B02' }); // noop NOT_PLACED
    const rename = ev('RENAME', { patientId: 'T-M7Q-0001', label: 'Imani C' });
    const known = ev('ADMIT', { patientId: 'T-K3P-0002', label: 'Mira Holt', bedId: 'B01' }, { basedOn: 4 }); // invalid BED_KNOWN_OCCUPIED
    const log = at([ward('B01', 'B02'), a, b, resolve, empty, rename, known]);
    const { json, csv } = buildRecoveryExport(log, opts);
    const r = JSON.parse(json);

    expect(r).toMatchObject({ format: 'wdb-recovery-export/1', ward: 'Ward A', source: 'server', upToSeq: 7, headHash: 'h7', openConflicts: [] });
    expect(r.classification).toMatch(/^SYNTHETIC DATA - CONFIDENTIAL/);
    // Rejected (a), noop (empty), invalid (known), the ward setup and the resolution itself are left out.
    expect(r.events.map((e: { eventId: string }) => e.eventId)).toEqual([b.eventId, rename.eventId]);
    expect(r.events[0]).toEqual({
      serverSeq: 3, eventId: b.eventId, type: 'ADMIT', patientId: 'T-M7Q-0001', label: 'Imani Calloway', bedId: 'B01',
      fromBedId: null, toBedId: null, clientTime: b.clientTime, serverTime: '2026-11-11T10:00:02.000Z',
      deviceId: DEVICE.B, deviceLabel: null, staffId: 'S-0001',
    });
    for (const e of r.events) expect(e.patientId).toMatch(/^T-/);

    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('# SYNTHETIC DATA - CONFIDENTIAL - WARD DOWNTIME RECOVERY EXPORT - upToSeq=7');
    expect(lines[1]).toBe('serverSeq,eventId,type,patientId,label,bedId,fromBedId,toBedId,clientTime,serverTime,deviceLabel,staffId');
    expect(lines).toHaveLength(4);
  });

  it('lists open conflicts so the export is known to be incomplete', () => {
    const a = ev('ADMIT', { patientId: 'T-K3P-0001', label: 'Rowan Ashby', bedId: 'B01' });
    const b = ev('ADMIT', { patientId: 'T-M7Q-0001', label: 'Imani Calloway', bedId: 'B01' }, { device: DEVICE.B });
    const r = JSON.parse(buildRecoveryExport(at([ward('B01'), a, b]), opts).json);
    expect(r.events).toEqual([]);
    expect(r.openConflicts).toEqual([
      { conflictId: 'C-3', bedId: 'B01', candidates: [
        { eventId: a.eventId, patientId: 'T-K3P-0001', label: 'Rowan Ashby' },
        { eventId: b.eventId, patientId: 'T-M7Q-0001', label: 'Imani Calloway' },
      ] },
    ]);
  });

  it('uses device labels when known and the label at the time of each event', () => {
    const a = ev('ADMIT', { patientId: 'T-K3P-0001', label: 'Rowan Ashby', bedId: 'B01' }, { device: DEVICE.A });
    const move = ev('TRANSFER', { patientId: 'T-K3P-0001', fromBedId: 'B01', toBedId: 'B02' }, { device: DEVICE.A, basedOn: 2 });
    const rename = ev('RENAME', { patientId: 'T-K3P-0001', label: 'Rowan A' });
    const out = ev('DISCHARGE', { patientId: 'T-K3P-0001', bedId: 'B02' });
    const r = JSON.parse(buildRecoveryExport(at([ward('B01', 'B02'), a, move, rename, out]), opts).json);
    expect(r.events.map((e: { type: string; label: string; deviceLabel: string | null }) => [e.type, e.label, e.deviceLabel])).toEqual([
      ['ADMIT', 'Rowan Ashby', 'Bay A tablet 1'],
      ['TRANSFER', 'Rowan Ashby', 'Bay A tablet 1'],
      ['RENAME', 'Rowan A', 'Bay A tablet 1'],
      ['DISCHARGE', 'Rowan A', 'Bay A tablet 1'],
    ]);
    expect(r.events[1]).toMatchObject({ bedId: null, fromBedId: 'B01', toBedId: 'B02' });
  });

  it('an empty log exports an empty, valid file', () => {
    const r = JSON.parse(buildRecoveryExport([], opts).json);
    expect(r).toMatchObject({ upToSeq: 0, headHash: '0'.repeat(64), events: [], openConflicts: [] });
  });
});

describe('csvCell (RFC 4180 + CSV injection guard)', () => {
  it('quotes and neutralises formula starts', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1,2')).toBe('"\'-1,2"');
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });

  it('every cell round-trips through an RFC 4180 parser, and never starts with a formula character', () => {
    const parse = (cell: string) => (cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell);
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const out = parse(csvCell(s));
        expect(out).toBe(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
        expect(/^[=+\-@\t\r]/.test(out)).toBe(false);
      }),
    );
  });
});
