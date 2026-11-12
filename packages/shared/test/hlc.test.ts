// Hybrid logical clock (design.md §3.3, §5.4): display/audit times that never go backwards (SEC-12).
import { describe, expect, it } from 'vitest';
import { EventSchema, formatHlc, nextHlc, type Hlc } from '../src/index.ts';
import { ev } from './helpers.ts';
import { fc } from './prop/fc.ts';

describe('nextHlc', () => {
  it('follows the wall clock when it moves forward', () => {
    expect(nextHlc(null, 1_762_852_443_120)).toEqual({ wallMs: 1_762_852_443_120, counter: 0 });
    expect(nextHlc({ wallMs: 100, counter: 4 }, 200)).toEqual({ wallMs: 200, counter: 0 });
  });

  it('counts up when the wall clock stalls or goes backwards', () => {
    expect(nextHlc({ wallMs: 200, counter: 0 }, 200)).toEqual({ wallMs: 200, counter: 1 });
    expect(nextHlc({ wallMs: 200, counter: 1 }, 50)).toEqual({ wallMs: 200, counter: 2 });
  });

  it('moves to the next millisecond instead of overflowing the 6-digit counter', () => {
    expect(nextHlc({ wallMs: 200, counter: 999_999 }, 10)).toEqual({ wallMs: 201, counter: 0 });
  });

  it('is strictly increasing for any sequence of wall clock readings', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1e12, max: 9e12 }), { minLength: 1, maxLength: 200 }), (walls) => {
        let prev: Hlc | null = null;
        for (const w of walls) {
          const h = nextHlc(prev, w);
          if (prev) expect(h.wallMs > prev.wallMs || (h.wallMs === prev.wallMs && h.counter > prev.counter)).toBe(true);
          prev = h;
        }
      }),
    );
  });

  it('formats into the envelope hlc field', () => {
    const hlc = formatHlc({ wallMs: 1_762_852_443_120, counter: 7 }, 'K3P');
    expect(hlc).toBe('1762852443120.7.K3P');
    const e = ev('ADMIT', { patientId: 'T-K3P-0001', label: 'Test Patient', bedId: 'B01' });
    expect(EventSchema.safeParse({ ...e, hlc }).success).toBe(true);
  });
});
