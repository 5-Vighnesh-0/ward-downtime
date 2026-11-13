// PB-01 convergence and PB-03 invariants under realistic offline behaviour (FR-4, FR-5, NFR-Convergence).
import { describe, expect, it } from 'vitest';
import { emptyBoard, replay, type AnyEvent, type Board, type Ordered } from '../../src/index.ts';
import { checkInvariants, ev, ward } from '../helpers.ts';
import { fc } from './fc.ts';

interface Device {
  deviceId: string;
  prefix: string;
  counter: number;
  isCharge: boolean;
  confirmed: Board; // built incrementally from pulled chunks
  outbox: AnyEvent[];
}

const DEVICES = 3;

/** Optimistic view = confirmed board + pending events (design.md §6.6). */
const view = (d: Device): Board =>
  replay(d.outbox.map((event, i) => ({ serverSeq: d.confirmed.atSeq + 1 + i, event })), d.confirmed);

const pick = <T>(xs: T[], k: number): T | undefined => (xs.length === 0 ? undefined : xs[k % xs.length]);
const sorted = <T>(r: Record<string, T>) => Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1));

/** Build one event that the UI would allow on this device's current view, or nothing. */
function makeChange(d: Device, kind: number, a: number, b: number): AnyEvent | undefined {
  const v = view(d);
  const opts = { device: d.deviceId, basedOn: d.confirmed.atSeq };
  const emptyBeds = sorted(v.beds).filter(([, x]) => x.status === 'empty').map(([k]) => k);
  const placed = sorted(v.patients).filter(([, p]) => p.where.kind === 'bed');
  const unplaced = sorted(v.patients).filter(([, p]) => p.where.kind === 'unplaced').map(([k]) => k);
  switch (kind) {
    case 0: {
      const bedId = pick(emptyBeds, a);
      if (!bedId) return undefined;
      const reuse = b % 3 === 0 ? pick(unplaced, b) : undefined;
      const patientId = reuse ?? `T-${d.prefix}-${String(++d.counter).padStart(4, '0')}`;
      return ev('ADMIT', { patientId, label: `L${a}`, bedId }, opts);
    }
    case 1: {
      const p = pick(placed, a);
      return p && p[1].where.kind === 'bed' ? ev('DISCHARGE', { patientId: p[0], bedId: p[1].where.bedId }, opts) : undefined;
    }
    case 2: {
      const p = pick(placed, a);
      const to = pick(emptyBeds, b);
      return p && to && p[1].where.kind === 'bed'
        ? ev('TRANSFER', { patientId: p[0], fromBedId: p[1].where.bedId, toBedId: to }, opts)
        : undefined;
    }
    case 3: {
      const p = pick(sorted(v.patients), a);
      return p ? ev('RENAME', { patientId: p[0], label: `R${b}` }, opts) : undefined;
    }
    case 5: {
      const bedId = pick(sorted(v.beds).map(([k]) => k), a);
      return bedId ? ev('TASK_CREATED', { bedId, title: `Task ${a}` }, opts) : undefined;
    }
    case 6: {
      // Any task, done or not: two devices completing the same one offline must also converge.
      const t = pick(sorted(v.tasks), a);
      return t ? ev('TASK_COMPLETED', { taskId: t[0] }, opts) : undefined;
    }
    case 8: {
      const bedId = pick(sorted(v.beds).map(([k]) => k), a);
      return bedId ? ev('HANDOFF_NOTE_ADDED', { bedId, text: `Note ${a}` }, opts) : undefined;
    }
    case 9: {
      // The admin screen sets beds B01..Bn; fewer beds than now removes some (refused while in use).
      if (!d.isCharge) return undefined;
      const n = 1 + (a % 7);
      return ev('WARD_CONFIGURED', { beds: Array.from({ length: n }, (_, i) => ({ bedId: `B0${i + 1}`, label: `${b % 2 ? 'Bay' : 'Bed'} ${i + 1}` })) }, opts);
    }
    default: {
      if (!d.isCharge) return undefined;
      const c = pick(sorted(v.conflicts).filter(([, x]) => x.status === 'open'), a);
      if (!c) return undefined;
      const ids = c[1].candidates.map((x) => x.eventId);
      const keep = b % (ids.length + 1) === ids.length ? 'NONE' : (ids[b % (ids.length + 1)] ?? 'NONE');
      return ev('RESOLVE_CONFLICT', { conflictId: c[0], keep, candidatesSeen: ids }, opts);
    }
  }
}

// Step k → the change makeChange builds; any other k is a push (7, 8) or a pull (9 partial, 10 full).
// Tasks (5, 6) appear twice so double completions show up in short runs.
const CHANGE: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 7, 5: 5, 6: 6, 11: 5, 12: 6, 13: 8, 14: 9 };
const step = fc.record({ d: fc.nat(DEVICES - 1), k: fc.nat(14), a: fc.nat(1000), b: fc.nat(1000) });
let conflictsSeen = 0;
let doubleDone = 0;
let bedsRemoved = 0;

describe('PB-01 / PB-03: offline devices converge', () => {
  it('every device ends with the board a full replay of the server log produces', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 80 }), (steps) => {
        const log: Ordered[] = [];
        const onServer = new Set<string>();
        const push = (d: Device) => {
          for (const e of d.outbox) {
            if (onServer.has(e.eventId)) continue; // FR-4: idempotent by eventId
            onServer.add(e.eventId);
            log.push({ serverSeq: log.length + 1, event: e });
          }
        };
        const pull = (d: Device, max = Infinity) => {
          const chunk = log.slice(d.confirmed.atSeq, d.confirmed.atSeq + max);
          d.confirmed = replay(chunk, d.confirmed);
          d.outbox = d.outbox.filter((e) => !(e.eventId in d.confirmed.outcomes));
        };

        log.push({ serverSeq: 1, event: ward('B01', 'B02', 'B03', 'B04', 'B05') });
        const devices: Device[] = Array.from({ length: DEVICES }, (_, i) => ({
          deviceId: `00000000-0000-4000-8000-0000000000d${i}`,
          prefix: `D${i}X`,
          counter: 0,
          isCharge: i === 0,
          confirmed: emptyBoard(),
          outbox: [],
        }));
        devices.forEach((d) => pull(d));
        const created = new Set<string>();

        for (const { d: di, k, a, b } of steps) {
          const d = devices[di];
          if (!d) continue;
          const kind = CHANGE[k];
          if (kind !== undefined) {
            const e = makeChange(d, kind, a, b);
            if (e) {
              d.outbox.push(e);
              created.add(e.eventId);
            }
          } else if (k <= 8) push(d); // 8 also covers retries: already-sent events are skipped
          else pull(d, k === 9 ? 1 + (a % 5) : Infinity);
        }

        devices.forEach(push);
        devices.forEach((d) => pull(d));

        const full = replay(log, emptyBoard());
        for (const d of devices) {
          expect(d.outbox).toEqual([]);
          expect(d.confirmed).toEqual(full);
        }
        // Zero silent losses: every change made on any device reached the log once and has an outcome.
        expect(log.length).toBe(created.size + 1);
        expect(Object.keys(full.outcomes)).toHaveLength(log.length);
        // Invariants hold after every single event.
        let b = emptyBoard();
        for (const entry of log) {
          b = replay([entry], b);
          expect(checkInvariants(b)).toEqual([]);
        }
        conflictsSeen += Object.keys(full.conflicts).length;
        bedsRemoved += log.filter((x, i) => i > 0 && x.event.type === 'WARD_CONFIGURED' && full.outcomes[x.event.eventId]?.kind === 'applied' && x.event.payload.beds.length < 5).length;
        doubleDone += Object.values(full.outcomes).filter((o) => o.kind === 'noop' && o.reason === 'ALREADY_DONE').length;
      }),
    );
    expect(conflictsSeen).toBeGreaterThan(0); // the generator really produces concurrency
    expect(doubleDone).toBeGreaterThan(0); // and tasks completed twice
    expect(bedsRemoved).toBeGreaterThan(0); // and the ward shrinking under live beds, tasks and notes
  });
});
