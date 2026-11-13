// Pure board reducer (design.md §4.3, §6). Same ordered log in → same board out, on every device.
// No clocks, randomness or I/O: outcomes depend only on event content and serverSeq order.
import type { AnyEvent } from './schema.ts';

export interface Ordered {
  serverSeq: number;
  event: AnyEvent;
}

export type Bed = { label: string } & (
  | { status: 'empty' }
  | { status: 'occupied'; occupant: string; placedBy: string; placedAtSeq: number }
  | { status: 'conflict'; conflictId: string }
);

export type Where =
  | { kind: 'bed'; bedId: string }
  | { kind: 'held'; conflictId: string }
  | { kind: 'unplaced' }
  | { kind: 'discharged' };

export interface Patient {
  label: string;
  where: Where;
}

export interface Candidate {
  eventId: string;
  patientId: string;
}

export interface Conflict {
  bedId: string;
  candidates: Candidate[]; // in serverSeq order
  status: 'open' | 'resolved';
  resolvedBy: string | null;
}

/** FR-15. Tied to a bed, not a patient: it stays when the patient moves or leaves. */
export interface Task {
  bedId: string;
  title: string;
  assignee: string | null;
  dueAt: string | null; // display only (SEC-12)
  createdBy: string;
  status: 'open' | 'done';
  doneBy: string | null;
}

export type NoopReason = 'NOT_PLACED' | 'SAME_BED' | 'UNKNOWN_PATIENT' | 'ALREADY_RESOLVED' | 'UNKNOWN_TASK' | 'ALREADY_DONE';
export type InvalidReason =
  | 'UNKNOWN_BED'
  | 'PATIENT_ACTIVE'
  | 'BED_KNOWN_OCCUPIED'
  | 'PATIENT_NOT_PLACED'
  | 'UNKNOWN_CONFLICT'
  | 'CANDIDATES_CHANGED'
  | 'NOT_A_CANDIDATE'
  | 'BED_IN_USE';

export type Outcome =
  | { kind: 'applied' }
  | { kind: 'held'; conflictId: string }
  | { kind: 'rejected'; conflictId: string; by: string }
  | { kind: 'noop'; reason: NoopReason }
  | { kind: 'invalid'; reason: InvalidReason };

export interface Board {
  atSeq: number;
  beds: Record<string, Bed>;
  patients: Record<string, Patient>;
  conflicts: Record<string, Conflict>;
  outcomes: Record<string, Outcome>;
  tasks: Record<string, Task>;
  idleLockMinutes?: number; // unset until a WARD_CONFIGURED sets it; tablets then use 5 (SEC-7)
}

export const emptyBoard = (): Board => ({ atSeq: 0, beds: {}, patients: {}, conflicts: {}, outcomes: {}, tasks: {} });

/** Apply entries in order on top of `from`. `from` is never mutated. */
export function replay(entries: Iterable<Ordered>, from: Board = emptyBoard()): Board {
  // Copy the records once; nested values are always replaced, never mutated.
  const b: Board = {
    ...from,
    beds: { ...from.beds },
    patients: { ...from.patients },
    conflicts: { ...from.conflicts },
    outcomes: { ...from.outcomes },
    tasks: { ...from.tasks }, // a snapshot saved before v2 has none
  };
  for (const entry of entries) apply(b, entry);
  return b;
}

const APPLIED: Outcome = { kind: 'applied' };
const has = Object.hasOwn;

function apply(b: Board, { serverSeq, event: e }: Ordered): void {
  if (serverSeq <= b.atSeq) return; // already applied (SSE + pull overlap)
  b.atSeq = serverSeq;
  if (has(b.outcomes, e.eventId)) return; // idempotent by eventId (FR-4)
  b.outcomes[e.eventId] = outcomeOf(b, serverSeq, e);
}

function outcomeOf(b: Board, seq: number, e: AnyEvent): Outcome {
  switch (e.type) {
    case 'WARD_CONFIGURED':
      return configure(b, e.payload);
    case 'ADMIT':
      return admit(b, seq, e);
    case 'DISCHARGE':
      return discharge(b, e.eventId, e.payload.patientId);
    case 'TRANSFER':
      return transfer(b, seq, e);
    case 'RENAME': {
      const p = b.patients[e.payload.patientId];
      if (!p) return { kind: 'noop', reason: 'UNKNOWN_PATIENT' };
      b.patients[e.payload.patientId] = { ...p, label: e.payload.label }; // FR-9: later in server order wins
      return APPLIED;
    }
    case 'RESOLVE_CONFLICT':
      return resolve(b, seq, e.eventId, e.payload);
    case 'TASK_CREATED': {
      const { bedId, title, assignee, dueAt } = e.payload;
      if (!b.beds[bedId]) return { kind: 'invalid', reason: 'UNKNOWN_BED' };
      b.tasks[e.eventId] = { bedId, title, assignee: assignee ?? null, dueAt: dueAt ?? null, createdBy: e.staffId, status: 'open', doneBy: null };
      return APPLIED;
    }
    case 'TASK_COMPLETED': {
      const t = b.tasks[e.payload.taskId];
      if (!t) return { kind: 'noop', reason: 'UNKNOWN_TASK' };
      if (t.status === 'done') return { kind: 'noop', reason: 'ALREADY_DONE' }; // two nurses ticked it offline
      b.tasks[e.payload.taskId] = { ...t, status: 'done', doneBy: e.staffId };
      return APPLIED;
    }
  }
}

function configure(b: Board, { beds, idleLockMinutes }: { beds: { bedId: string; label: string }[]; idleLockMinutes?: number | undefined }): Outcome {
  const keep = new Set(beds.map((x) => x.bedId));
  for (const [id, bed] of Object.entries(b.beds)) {
    if (bed.status !== 'empty' && !keep.has(id)) return { kind: 'invalid', reason: 'BED_IN_USE' };
  }
  for (const t of Object.values(b.tasks)) if (t.status === 'open' && !keep.has(t.bedId)) return { kind: 'invalid', reason: 'BED_IN_USE' };
  const next: Record<string, Bed> = {};
  for (const { bedId, label } of beds) {
    const old = b.beds[bedId];
    next[bedId] = old ? { ...old, label } : { label, status: 'empty' };
  }
  b.beds = next;
  if (idleLockMinutes !== undefined) b.idleLockMinutes = idleLockMinutes;
  return APPLIED;
}

const isActive = (p: Patient | undefined) => p !== undefined && (p.where.kind === 'bed' || p.where.kind === 'held');
const locate = (b: Board, patientId: string, where: Where) => {
  const p = b.patients[patientId];
  if (p) b.patients[patientId] = { label: p.label, where };
};

/** basedOn is a serverSeq, so "the device already saw this occupant" needs no clock (SEC-12, ADR-006). */
const knownOccupied = (bed: Bed, basedOn: number) => bed.status === 'occupied' && basedOn >= bed.placedAtSeq;

/** Put a patient into a bed that passed `knownOccupied`. Opens or joins a conflict if the bed is taken. */
function place(b: Board, seq: number, eventId: string, patientId: string, bedId: string): Outcome {
  const bed = b.beds[bedId];
  if (!bed) return { kind: 'invalid', reason: 'UNKNOWN_BED' };
  const me: Candidate = { eventId, patientId };
  if (bed.status === 'empty') {
    b.beds[bedId] = { label: bed.label, status: 'occupied', occupant: patientId, placedBy: eventId, placedAtSeq: seq };
    locate(b, patientId, { kind: 'bed', bedId });
    return APPLIED;
  }
  if (bed.status === 'occupied') {
    // FR-6: concurrent placement. Hold both; overwrite neither.
    const conflictId = `C-${seq}`;
    const occupant: Candidate = { eventId: bed.placedBy, patientId: bed.occupant };
    b.conflicts[conflictId] = { bedId, candidates: [occupant, me], status: 'open', resolvedBy: null };
    b.beds[bedId] = { label: bed.label, status: 'conflict', conflictId };
    b.outcomes[occupant.eventId] = { kind: 'held', conflictId };
    locate(b, occupant.patientId, { kind: 'held', conflictId });
    locate(b, patientId, { kind: 'held', conflictId });
    return { kind: 'held', conflictId };
  }
  const c = b.conflicts[bed.conflictId];
  if (c) b.conflicts[bed.conflictId] = { ...c, candidates: [...c.candidates, me] }; // sibling conflict
  locate(b, patientId, { kind: 'held', conflictId: bed.conflictId });
  return { kind: 'held', conflictId: bed.conflictId };
}

function admit(b: Board, seq: number, e: Extract<AnyEvent, { type: 'ADMIT' }>): Outcome {
  const { patientId, label, bedId } = e.payload;
  const bed = b.beds[bedId];
  if (!bed) return { kind: 'invalid', reason: 'UNKNOWN_BED' };
  if (isActive(b.patients[patientId])) return { kind: 'invalid', reason: 'PATIENT_ACTIVE' };
  if (knownOccupied(bed, e.basedOn)) return { kind: 'invalid', reason: 'BED_KNOWN_OCCUPIED' };
  b.patients[patientId] = { label, where: { kind: 'unplaced' } };
  return place(b, seq, e.eventId, patientId, bedId);
}

function transfer(b: Board, seq: number, e: Extract<AnyEvent, { type: 'TRANSFER' }>): Outcome {
  const { patientId, toBedId } = e.payload;
  const to = b.beds[toBedId];
  if (!to) return { kind: 'invalid', reason: 'UNKNOWN_BED' };
  const where = b.patients[patientId]?.where;
  if (where?.kind !== 'bed') return { kind: 'invalid', reason: 'PATIENT_NOT_PLACED' };
  if (where.bedId === toBedId) return { kind: 'noop', reason: 'SAME_BED' };
  if (knownOccupied(to, e.basedOn)) return { kind: 'invalid', reason: 'BED_KNOWN_OCCUPIED' };
  const from = b.beds[where.bedId];
  if (from) b.beds[where.bedId] = { label: from.label, status: 'empty' }; // fromBedId is informational
  return place(b, seq, e.eventId, patientId, toBedId);
}

function discharge(b: Board, eventId: string, patientId: string): Outcome {
  const where = b.patients[patientId]?.where;
  if (where?.kind === 'bed') {
    const bed = b.beds[where.bedId];
    if (bed) b.beds[where.bedId] = { label: bed.label, status: 'empty' };
  } else if (where?.kind === 'held') {
    const c = b.conflicts[where.conflictId];
    if (c) {
      const leaving = c.candidates.find((x) => x.patientId === patientId);
      if (leaving) b.outcomes[leaving.eventId] = APPLIED; // design.md §6.4: held → applied when discharged
      const rest = c.candidates.filter((x) => x.patientId !== patientId);
      if (rest.length === 0) {
        // E14: nobody left to choose between, so the conflict closes and the bed frees up.
        b.conflicts[where.conflictId] = { ...c, candidates: [], status: 'resolved', resolvedBy: eventId };
        const bed = b.beds[c.bedId];
        if (bed) b.beds[c.bedId] = { label: bed.label, status: 'empty' };
      } else b.conflicts[where.conflictId] = { ...c, candidates: rest };
    }
  } else return { kind: 'noop', reason: 'NOT_PLACED' };
  locate(b, patientId, { kind: 'discharged' });
  return APPLIED;
}

function resolve(
  b: Board,
  seq: number,
  eventId: string,
  p: Extract<AnyEvent, { type: 'RESOLVE_CONFLICT' }>['payload'],
): Outcome {
  const c = b.conflicts[p.conflictId];
  if (!c) return { kind: 'invalid', reason: 'UNKNOWN_CONFLICT' };
  if (c.status === 'resolved') return { kind: 'noop', reason: 'ALREADY_RESOLVED' };
  const ids = c.candidates.map((x) => x.eventId);
  const seen = new Set(p.candidatesSeen);
  if (seen.size !== ids.length || !ids.every((x) => seen.has(x))) return { kind: 'invalid', reason: 'CANDIDATES_CHANGED' };
  if (p.keep !== 'NONE' && !ids.includes(p.keep)) return { kind: 'invalid', reason: 'NOT_A_CANDIDATE' };

  let kept: Candidate | undefined;
  for (const x of c.candidates) {
    if (x.eventId === p.keep) {
      kept = x;
      b.outcomes[x.eventId] = APPLIED;
      locate(b, x.patientId, { kind: 'bed', bedId: c.bedId });
    } else {
      b.outcomes[x.eventId] = { kind: 'rejected', conflictId: p.conflictId, by: eventId }; // FR-8: stays in the log
      locate(b, x.patientId, { kind: 'unplaced' });
    }
  }
  const bed = b.beds[c.bedId];
  if (bed) {
    b.beds[c.bedId] = kept
      ? { label: bed.label, status: 'occupied', occupant: kept.patientId, placedBy: kept.eventId, placedAtSeq: seq }
      : { label: bed.label, status: 'empty' };
  }
  b.conflicts[p.conflictId] = { ...c, status: 'resolved', resolvedBy: eventId };
  return APPLIED;
}
