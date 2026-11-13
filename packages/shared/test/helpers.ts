import { emptyBoard, replay, type AnyEvent, type Board, type EventType, type Ordered } from '../src/index.ts';

type EventOf<T extends EventType> = Extract<AnyEvent, { type: T }>;

export const SIG = 'A'.repeat(86); // placeholder until Ed25519 signing lands in M2
export const DEVICE = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
} as const;

let n = 0;
export const id = (k = ++n) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, '0')}`;
const deviceSeq: Record<string, number> = {};

export function ev<T extends EventType>(
  type: T,
  payload: EventOf<T>['payload'],
  o: { device?: string; basedOn?: number; eventId?: string } = {},
): EventOf<T> {
  const deviceId = o.device ?? DEVICE.A;
  deviceSeq[deviceId] = (deviceSeq[deviceId] ?? 0) + 1;
  return {
    v: 1,
    eventId: o.eventId ?? id(),
    type,
    deviceId,
    deviceSeq: deviceSeq[deviceId],
    staffId: 'S-0001',
    basedOn: o.basedOn ?? 0,
    hlc: '1762852443120.0.K3P',
    clientTime: '2026-11-11T09:14:03.120Z',
    payload,
    sig: SIG,
  } as EventOf<T>;
}

/** Server order = argument order, serverSeq from 1. */
export const log = (...events: AnyEvent[]): Ordered[] => events.map((event, i) => ({ serverSeq: i + 1, event }));
export const run = (...events: AnyEvent[]): Board => replay(log(...events), emptyBoard());

export const ward = (...bedIds: string[]) =>
  ev('WARD_CONFIGURED', { beds: bedIds.map((bedId) => ({ bedId, label: bedId })) });

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Structural invariants every board must satisfy after every event (PB-03). Returns violations. */
export function checkInvariants(b: Board): string[] {
  const errs: string[] = [];
  for (const [bedId, bed] of Object.entries(b.beds)) {
    if (bed.status === 'occupied') {
      const w = b.patients[bed.occupant]?.where;
      if (w?.kind !== 'bed' || w.bedId !== bedId) errs.push(`bed ${bedId} occupant not located there`);
    }
    if (bed.status === 'conflict') {
      const c = b.conflicts[bed.conflictId];
      if (c?.status !== 'open' || c.bedId !== bedId) errs.push(`bed ${bedId} points at a non-open conflict`);
    }
  }
  for (const [pid, p] of Object.entries(b.patients)) {
    const w = p.where;
    if (w.kind === 'bed') {
      const bed = b.beds[w.bedId];
      if (bed?.status !== 'occupied' || bed.occupant !== pid) errs.push(`patient ${pid} not the occupant of ${w.bedId}`);
    }
    if (w.kind === 'held') {
      const c = b.conflicts[w.conflictId];
      if (c?.status !== 'open' || !c.candidates.some((x) => x.patientId === pid)) errs.push(`patient ${pid} held outside an open conflict`);
    }
  }
  for (const [tid, t] of Object.entries(b.tasks)) {
    if (t.status === 'open' && !b.beds[t.bedId]) errs.push(`open task ${tid} on a bed that does not exist`);
  }
  for (const [bedId, notes] of Object.entries(b.notes)) {
    if (!b.beds[bedId]) errs.push(`notes kept for bed ${bedId}, which does not exist`);
    if (notes.length > 5) errs.push(`bed ${bedId} keeps ${notes.length} notes`);
  }
  for (const [cid, c] of Object.entries(b.conflicts)) {
    if (c.status === 'open') {
      const bed = b.beds[c.bedId];
      if (bed?.status !== 'conflict' || bed.conflictId !== cid) errs.push(`open conflict ${cid} not on its bed`);
      if (c.candidates.length === 0) errs.push(`open conflict ${cid} has no candidates`);
      if (new Set(c.candidates.map((x) => x.patientId)).size !== c.candidates.length) errs.push(`conflict ${cid} repeats a patient`);
      for (const x of c.candidates) {
        const w = b.patients[x.patientId]?.where;
        if (w?.kind !== 'held' || w.conflictId !== cid) errs.push(`candidate ${x.patientId} of ${cid} not held`);
        if (b.outcomes[x.eventId]?.kind !== 'held') errs.push(`candidate event ${x.eventId} of ${cid} not held`);
      }
    } else if (c.resolvedBy === null) errs.push(`resolved conflict ${cid} has no resolvedBy`);
  }
  return errs;
}
