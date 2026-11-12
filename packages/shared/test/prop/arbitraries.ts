import type { AnyEvent, Ordered } from '../../src/index.ts';
import { ev, id, ward } from '../helpers.ts';
import { fc } from './fc.ts';

const BEDS = ['B01', 'B02', 'B03', 'B04']; // B04 is never configured, so UNKNOWN_BED occurs
const PATIENTS = ['T-AAA-0001', 'T-AAA-0002', 'T-BBB-0001', 'T-BBB-0002', 'T-CCC-0001'];

const bed = fc.constantFrom(...BEDS);
const patient = fc.constantFrom(...PATIENTS);

/** One arbitrary event, valid against the schema but not against any device's view (buggy/hostile clients). */
const anyEvent = (n: number): fc.Arbitrary<(eventIds: string[]) => AnyEvent> =>
  fc.oneof(
    fc.record({ p: patient, b: bed, basedOn: fc.nat(n) }).map(({ p, b, basedOn }) => () =>
      ev('ADMIT', { patientId: p, label: `L ${p}`, bedId: b }, { basedOn })),
    fc.record({ p: patient, b: bed }).map(({ p, b }) => () => ev('DISCHARGE', { patientId: p, bedId: b })),
    fc.record({ p: patient, f: bed, t: bed, basedOn: fc.nat(n) }).map(({ p, f, t, basedOn }) => () =>
      ev('TRANSFER', { patientId: p, fromBedId: f, toBedId: t }, { basedOn })),
    fc.record({ p: patient, l: fc.string({ minLength: 1, maxLength: 8 }) }).map(({ p, l }) => () =>
      ev('RENAME', { patientId: p, label: l })),
    fc.record({ c: fc.integer({ min: 1, max: n + 1 }), k: fc.nat(), seen: fc.array(fc.nat(), { minLength: 1, maxLength: 4 }) }).map(
      ({ c, k, seen }) => (ids: string[]) =>
        ev('RESOLVE_CONFLICT', {
          conflictId: `C-${c}`,
          keep: k % 4 === 0 || ids.length === 0 ? 'NONE' : (ids[k % ids.length] ?? 'NONE'),
          candidatesSeen: ids.length === 0 ? [id()] : [...new Set(seen.map((s) => ids[s % ids.length] ?? id()))],
        }),
    ),
  );

/** A server log of arbitrary events (after one WARD_CONFIGURED), serverSeq 1..n. */
export const arbitraryLog = (maxEvents = 40): fc.Arbitrary<Ordered[]> =>
  fc.array(anyEvent(maxEvents), { maxLength: maxEvents }).map((makers) => {
    const events: AnyEvent[] = [ward('B01', 'B02', 'B03')];
    for (const make of makers) events.push(make(events.map((e) => e.eventId)));
    return events.map((event, i) => ({ serverSeq: i + 1, event }));
  });
