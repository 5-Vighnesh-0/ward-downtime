// Bed card states and accessible names (design.md §10.4, FR-10).
import { describe, expect, it } from 'vitest';
import { replay, type AnyEvent } from '@wdb/shared';
import { cardName, cardState, FILTERS, matches, type CardState } from '../src/ui/bedState.ts';

let n = 0;
const ev = (type: AnyEvent['type'], payload: object, basedOn = 0): AnyEvent =>
  ({ v: 1, eventId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, type, deviceId: '00000000-0000-4000-8000-00000000000a', deviceSeq: n, staffId: 'S-0001', basedOn, hlc: '1762852443120.0.K3P', clientTime: '2026-11-11T09:14:03.120Z', payload, sig: 'A'.repeat(86) }) as AnyEvent;
const log = (...es: AnyEvent[]) => replay(es.map((event, i) => ({ serverSeq: i + 1, event })));

const ward = ev('WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bed 1' }, { bedId: 'B02', label: 'Bed 2' }] });
const admitA = ev('ADMIT', { patientId: 'T-K3P-0001', label: 'Rowan Ashby', bedId: 'B01' });

describe('cardState', () => {
  it('empty, confirmed and pending occupancy', () => {
    const confirmed = log(ward);
    const view = log(ward, admitA);
    expect(cardState('B02', view, confirmed)).toEqual({ kind: 'empty' });
    expect(cardState('B01', view, confirmed)).toEqual({ kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: true });
    expect(cardState('B01', view, view)).toEqual({ kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: false });
  });

  it('a pending rename, discharge or move shows as pending', () => {
    const confirmed = log(ward, admitA);
    const renamed = log(ward, admitA, ev('RENAME', { patientId: 'T-K3P-0001', label: 'Rowan A' }));
    expect(cardState('B01', renamed, confirmed)).toMatchObject({ kind: 'occupied', label: 'Rowan A', pending: true });
    const out = log(ward, admitA, ev('TRANSFER', { patientId: 'T-K3P-0001', fromBedId: 'B01', toBedId: 'B02' }));
    expect(cardState('B01', out, confirmed)).toEqual({ kind: 'pendingOut', patientId: 'T-K3P-0001', label: 'Rowan Ashby' });
    expect(cardState('B02', out, confirmed)).toMatchObject({ kind: 'occupied', pending: true });
  });

  it('conflict counts the candidates', () => {
    const b = log(ward, admitA, ev('ADMIT', { patientId: 'T-M7Q-0001', label: 'Mira Holt', bedId: 'B01' }));
    expect(cardState('B01', b, b)).toEqual({ kind: 'conflict', count: 2 });
  });
});

describe('cardName', () => {
  it('says the status in words, never by colour alone', () => {
    expect(cardName('Bed 4', { kind: 'empty' })).toBe('Bed 4, empty');
    expect(cardName('Bed 4', { kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: false })).toBe('Bed 4, Rowan Ashby, confirmed');
    expect(cardName('Bed 4', { kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: true })).toBe('Bed 4, Rowan Ashby, pending, not yet confirmed by ward server');
    expect(cardName('Bed 4', { kind: 'conflict', count: 2 })).toBe('Bed 4, conflict: 2 patients, charge nurse must choose');
    expect(cardName('Bed 4', { kind: 'pendingOut', patientId: 'T-K3P-0001', label: 'Rowan Ashby' })).toBe('Bed 4, Rowan Ashby, pending move or discharge');
  });
});

describe('board filters', () => {
  it('each state shows under All and its own filters only', () => {
    const states: [CardState, string[]][] = [
      [{ kind: 'empty' }, ['All', 'Empty']],
      [{ kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: false }, ['All', 'Occupied']],
      [{ kind: 'occupied', patientId: 'T-K3P-0001', label: 'Rowan Ashby', pending: true }, ['All', 'Occupied', 'Pending']],
      [{ kind: 'pendingOut', patientId: 'T-K3P-0001', label: 'Rowan Ashby' }, ['All', 'Occupied', 'Pending']],
      [{ kind: 'conflict', count: 2 }, ['All', 'Conflict']],
    ];
    for (const [s, want] of states) expect(FILTERS.filter((f) => matches(f, s))).toEqual(want);
  });
});
