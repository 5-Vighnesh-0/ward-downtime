// PB-02 idempotence, PB-03 invariants on arbitrary logs, PB-04 rename LWW, PB-05 clock independence, PB-06 snapshots.
import { describe, expect, it } from 'vitest';
import { emptyBoard, replay, type Ordered } from '../../src/index.ts';
import { checkInvariants, deepFreeze, ev, ward } from '../helpers.ts';
import { arbitraryLog } from './arbitraries.ts';
import { fc } from './fc.ts';

const full = (l: Ordered[]) => replay(l, emptyBoard());

describe('replay properties', () => {
  it('PB-03: invariants hold after every event of any log, and every event gets one outcome', () => {
    fc.assert(
      fc.property(arbitraryLog(), (l) => {
        let b = emptyBoard();
        for (const entry of l) {
          b = replay([entry], b);
          expect(checkInvariants(b)).toEqual([]);
          expect(b.outcomes[entry.event.eventId]).toBeDefined();
        }
      }),
    );
  });

  it('PB-02: re-delivering entries already applied changes nothing', () => {
    fc.assert(
      fc.property(arbitraryLog(), fc.array(fc.nat()), (l, picks) => {
        const once = full(l);
        const again = picks.map((p) => l[p % l.length]).filter((x): x is Ordered => x !== undefined);
        expect(replay(again, once)).toEqual(once);
      }),
    );
  });

  it('PB-06: snapshot + tail equals full replay for any split, without mutating the snapshot', () => {
    fc.assert(
      fc.property(arbitraryLog(), fc.nat(), (l, k) => {
        const cut = k % (l.length + 1);
        const snap = deepFreeze(full(l.slice(0, cut)));
        expect(replay(l.slice(cut), snap)).toEqual(full(l));
      }),
    );
  });

  it('PB-05: device clocks and HLC never change the board (SEC-12)', () => {
    fc.assert(
      fc.property(arbitraryLog(), fc.array(fc.date({ noInvalidDate: true, min: new Date(0) })), (l, dates) => {
        const shifted = l.map((x, i) => {
          const d = dates[i % Math.max(dates.length, 1)] ?? new Date(0);
          return { ...x, event: { ...x.event, clientTime: d.toISOString(), hlc: `${String(d.getTime()).padStart(13, '0')}.${i}.ZZZ` } };
        });
        expect(full(shifted)).toEqual(full(l));
      }),
    );
  });

  it('PB-04: the final label is the last rename in server order', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1 }), (labels) => {
        const p = 'T-AAA-0001';
        const l = [ward('B01'), ev('ADMIT', { patientId: p, label: 'first', bedId: 'B01' }), ...labels.map((label) => ev('RENAME', { patientId: p, label }))]
          .map((event, i) => ({ serverSeq: i + 1, event }));
        expect(full(l).patients[p]?.label).toBe(labels.at(-1));
      }),
    );
  });
});
