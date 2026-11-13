// UNIT-BED / UNIT-CONFLICT: every rule row in design.md §6.3 and edge cases E1–E14 (§6.5).
import { describe, expect, it } from 'vitest';
import { emptyBoard, replay, type AnyEvent, type Board } from '../src/index.ts';
import { checkInvariants, deepFreeze, DEVICE, ev, log, run, ward } from './helpers.ts';

const P1 = 'T-AAA-0001';
const P2 = 'T-BBB-0001';
const P3 = 'T-CCC-0001';
const W = () => ward('B01', 'B02', 'B03', 'B04');

const admit = (patientId: string, bedId: string, basedOn = 0, device: string = DEVICE.A) =>
  ev('ADMIT', { patientId, label: `L-${patientId}`, bedId }, { basedOn, device });
const discharge = (patientId: string, bedId = 'B01') => ev('DISCHARGE', { patientId, bedId });
const transfer = (patientId: string, fromBedId: string, toBedId: string, basedOn = 0) =>
  ev('TRANSFER', { patientId, fromBedId, toBedId }, { basedOn });
const rename = (patientId: string, label: string) => ev('RENAME', { patientId, label });
const resolve = (conflictId: string, keep: AnyEvent | 'NONE', seen: AnyEvent[]) =>
  ev('RESOLVE_CONFLICT', { conflictId, keep: keep === 'NONE' ? 'NONE' : keep.eventId, candidatesSeen: seen.map((e) => e.eventId) });

const out = (b: Board, e: AnyEvent) => b.outcomes[e.eventId];
const checked = (...events: AnyEvent[]) => {
  const b = run(...events);
  expect(checkInvariants(b)).toEqual([]);
  return b;
};

/** W at seq 1, a1 (A) at seq 2, a2 (B, concurrent) at seq 3 → conflict C-3 on B01. */
function conflictOnB01() {
  const a1 = admit(P1, 'B01', 1, DEVICE.A);
  const a2 = admit(P2, 'B01', 1, DEVICE.B);
  return { a1, a2, events: [W(), a1, a2] };
}

describe('WARD_CONFIGURED', () => {
  it('creates empty beds', () => {
    const b = checked(W());
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'empty' });
    expect(Object.keys(b.beds)).toEqual(['B01', 'B02', 'B03', 'B04']);
  });

  it('relabels, adds and removes empty beds, keeping occupants', () => {
    const a = admit(P1, 'B01', 1);
    const re = ev('WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'Bay 1' }, { bedId: 'B05', label: 'B05' }] });
    const b = checked(W(), a, re);
    expect(out(b, re)).toEqual({ kind: 'applied' });
    expect(b.beds.B01).toMatchObject({ label: 'Bay 1', status: 'occupied', occupant: P1 });
    expect(Object.keys(b.beds).sort()).toEqual(['B01', 'B05']);
  });

  it('refuses to remove a bed in use', () => {
    const a = admit(P1, 'B02', 1);
    const re = ward('B01');
    const b = checked(W(), a, re);
    expect(out(b, re)).toEqual({ kind: 'invalid', reason: 'BED_IN_USE' });
    expect(Object.keys(b.beds)).toHaveLength(4);
  });

  it('sets the idle lock time; a config without it keeps the last value; a refused one changes nothing', () => {
    const set = ev('WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'B01' }, { bedId: 'B02', label: 'B02' }], idleLockMinutes: 10 });
    expect(checked(W()).idleLockMinutes).toBeUndefined(); // tablets use the 5 min default
    expect(checked(W(), set).idleLockMinutes).toBe(10);
    expect(checked(W(), set, ward('B01', 'B02')).idleLockMinutes).toBe(10);
    const refused = ev('WARD_CONFIGURED', { beds: [{ bedId: 'B01', label: 'B01' }], idleLockMinutes: 1 });
    const b = checked(W(), set, admit(P1, 'B02', 1), refused);
    expect(out(b, refused)).toEqual({ kind: 'invalid', reason: 'BED_IN_USE' });
    expect(b.idleLockMinutes).toBe(10);
  });
});

describe('ADMIT', () => {
  it('unknown bed → invalid, nothing created', () => {
    const a = admit(P1, 'B09');
    const b = checked(W(), a);
    expect(out(b, a)).toEqual({ kind: 'invalid', reason: 'UNKNOWN_BED' });
    expect(b.patients[P1]).toBeUndefined();
  });

  it('empty bed → applied', () => {
    const a = admit(P1, 'B01', 1);
    const b = checked(W(), a);
    expect(out(b, a)).toEqual({ kind: 'applied' });
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'occupied', occupant: P1, placedBy: a.eventId, placedAtSeq: 2 });
    expect(b.patients[P1]).toEqual({ label: `L-${P1}`, where: { kind: 'bed', bedId: 'B01' } });
  });

  it('patient already in a bed → invalid PATIENT_ACTIVE', () => {
    const again = admit(P1, 'B02', 2);
    const b = checked(W(), admit(P1, 'B01', 1), again);
    expect(out(b, again)).toEqual({ kind: 'invalid', reason: 'PATIENT_ACTIVE' });
    expect(b.beds.B02?.status).toBe('empty');
  });

  it('patient held in a conflict → invalid PATIENT_ACTIVE', () => {
    const { events } = conflictOnB01();
    const again = admit(P1, 'B02', 3);
    expect(out(checked(...events, again), again)).toEqual({ kind: 'invalid', reason: 'PATIENT_ACTIVE' });
  });

  it('E10: bed the device already knew was occupied → invalid BED_KNOWN_OCCUPIED', () => {
    const a1 = admit(P1, 'B01', 1);
    const a2 = admit(P2, 'B01', 2); // basedOn 2 ≥ placedAtSeq 2
    const b = checked(W(), a1, a2);
    expect(out(b, a2)).toEqual({ kind: 'invalid', reason: 'BED_KNOWN_OCCUPIED' });
    expect(b.beds.B01).toMatchObject({ status: 'occupied', occupant: P1 });
    expect(b.patients[P2]).toBeUndefined();
  });

  it('FR-6: concurrent admit to an occupied bed opens a conflict; both held, neither overwritten', () => {
    const { a1, a2, events } = conflictOnB01();
    const b = checked(...events);
    expect(out(b, a1)).toEqual({ kind: 'held', conflictId: 'C-3' });
    expect(out(b, a2)).toEqual({ kind: 'held', conflictId: 'C-3' });
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'conflict', conflictId: 'C-3' });
    expect(b.conflicts['C-3']).toEqual({
      bedId: 'B01',
      status: 'open',
      resolvedBy: null,
      candidates: [{ eventId: a1.eventId, patientId: P1 }, { eventId: a2.eventId, patientId: P2 }],
    });
    expect(b.patients[P1]?.where).toEqual({ kind: 'held', conflictId: 'C-3' });
    expect(b.patients[P2]?.where).toEqual({ kind: 'held', conflictId: 'C-3' });
  });

  it('sibling conflict: a third admit joins the open conflict', () => {
    const { events } = conflictOnB01();
    const a3 = admit(P3, 'B01', 1, DEVICE.C);
    const b = checked(...events, a3);
    expect(out(b, a3)).toEqual({ kind: 'held', conflictId: 'C-3' });
    expect(b.conflicts['C-3']?.candidates).toHaveLength(3);
  });

  it('E9: same person on two tablets with two temp IDs in two beds → no conflict', () => {
    const a1 = admit(P1, 'B01', 1, DEVICE.A);
    const a2 = admit(P2, 'B02', 1, DEVICE.B);
    const b = checked(W(), a1, a2);
    expect([out(b, a1), out(b, a2)]).toEqual([{ kind: 'applied' }, { kind: 'applied' }]);
  });

  it('E13: a patient not kept after a conflict can be admitted to another bed', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', a1, [a1, a2]);
    const again = admit(P2, 'B02', 4);
    const b = checked(...events, r, again);
    expect(out(b, again)).toEqual({ kind: 'applied' });
    expect(b.patients[P2]?.where).toEqual({ kind: 'bed', bedId: 'B02' });
    expect(out(b, a2)).toMatchObject({ kind: 'rejected' }); // history unchanged (FR-8)
  });

  it('a discharged patient can be re-admitted, with the new label', () => {
    const again = ev('ADMIT', { patientId: P1, label: 'New label', bedId: 'B03' }, { basedOn: 3 });
    const b = checked(W(), admit(P1, 'B01', 1), discharge(P1), again);
    expect(out(b, again)).toEqual({ kind: 'applied' });
    expect(b.patients[P1]).toEqual({ label: 'New label', where: { kind: 'bed', bedId: 'B03' } });
  });
});

describe('DISCHARGE', () => {
  it('E1 / acceptance 5: discharge of an empty bed is a harmless no-op', () => {
    const before = checked(W());
    const d = discharge(P1, 'B01');
    const after = checked(W(), d);
    expect(out(after, d)).toEqual({ kind: 'noop', reason: 'NOT_PLACED' });
    expect(after.beds).toEqual(before.beds);
    expect(after.patients).toEqual({});
    expect(after.conflicts).toEqual({});
  });

  it('patient in a bed → applied, bed empty', () => {
    const d = discharge(P1);
    const b = checked(W(), admit(P1, 'B01', 1), d);
    expect(out(b, d)).toEqual({ kind: 'applied' });
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'empty' });
    expect(b.patients[P1]?.where).toEqual({ kind: 'discharged' });
  });

  it('already discharged or unplaced → noop NOT_PLACED', () => {
    const d2 = discharge(P1);
    expect(out(checked(W(), admit(P1, 'B01', 1), discharge(P1), d2), d2)).toEqual({ kind: 'noop', reason: 'NOT_PLACED' });
    const { a1, a2, events } = conflictOnB01();
    const d3 = discharge(P2);
    expect(out(checked(...events, resolve('C-3', a1, [a1, a2]), d3), d3)).toEqual({ kind: 'noop', reason: 'NOT_PLACED' });
  });

  it('follows the patient after a concurrent transfer (bedId is informational)', () => {
    const d = discharge(P1, 'B01'); // device still thinks P1 is in B01
    const b = checked(W(), admit(P1, 'B01', 1), transfer(P1, 'B01', 'B02', 2), d);
    expect(out(b, d)).toEqual({ kind: 'applied' });
    expect(b.beds.B02?.status).toBe('empty');
  });

  it('E8: discharge of a held patient removes the candidate; conflict stays open for the charge nurse', () => {
    const { a1, a2, events } = conflictOnB01();
    const d = discharge(P1);
    const b = checked(...events, d);
    expect(out(b, d)).toEqual({ kind: 'applied' });
    expect(out(b, a1)).toEqual({ kind: 'applied' }); // design.md §6.4: held → applied on discharge
    expect(b.patients[P1]?.where).toEqual({ kind: 'discharged' });
    expect(b.conflicts['C-3']).toMatchObject({ status: 'open', candidates: [{ eventId: a2.eventId, patientId: P2 }] });
    expect(b.beds.B01?.status).toBe('conflict');
  });

  it('E14: discharging the last candidate closes the empty conflict and frees the bed', () => {
    const { events } = conflictOnB01();
    const d2 = discharge(P2);
    const b = checked(...events, discharge(P1), d2);
    expect(b.conflicts['C-3']).toMatchObject({ status: 'resolved', resolvedBy: d2.eventId, candidates: [] });
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'empty' });
  });
});

describe('TRANSFER', () => {
  it('unknown target bed → invalid UNKNOWN_BED', () => {
    const t = transfer(P1, 'B01', 'B09', 2);
    expect(out(checked(W(), admit(P1, 'B01', 1), t), t)).toEqual({ kind: 'invalid', reason: 'UNKNOWN_BED' });
  });

  it('E4: patient held (or unknown) → invalid PATIENT_NOT_PLACED', () => {
    const { events } = conflictOnB01();
    const t = transfer(P1, 'B01', 'B02', 3);
    expect(out(checked(...events, t), t)).toEqual({ kind: 'invalid', reason: 'PATIENT_NOT_PLACED' });
    const t2 = transfer(P3, 'B01', 'B02');
    expect(out(checked(W(), t2), t2)).toEqual({ kind: 'invalid', reason: 'PATIENT_NOT_PLACED' });
  });

  it('already in the target bed → noop SAME_BED', () => {
    const t = transfer(P1, 'B01', 'B01', 2);
    expect(out(checked(W(), admit(P1, 'B01', 1), t), t)).toEqual({ kind: 'noop', reason: 'SAME_BED' });
  });

  it('empty target → applied; old bed freed', () => {
    const t = transfer(P1, 'B01', 'B02', 2);
    const b = checked(W(), admit(P1, 'B01', 1), t);
    expect(out(b, t)).toEqual({ kind: 'applied' });
    expect(b.beds.B01?.status).toBe('empty');
    expect(b.beds.B02).toEqual({ label: 'B02', status: 'occupied', occupant: P1, placedBy: t.eventId, placedAtSeq: 3 });
  });

  it('target the device knew was occupied → invalid BED_KNOWN_OCCUPIED', () => {
    const t = transfer(P1, 'B01', 'B02', 3);
    const b = checked(W(), admit(P1, 'B01', 1), admit(P2, 'B02', 1), t);
    expect(out(b, t)).toEqual({ kind: 'invalid', reason: 'BED_KNOWN_OCCUPIED' });
    expect(b.patients[P1]?.where).toEqual({ kind: 'bed', bedId: 'B01' });
  });

  it('concurrent transfer into an occupied bed → conflict on the target; old bed freed', () => {
    const a2 = admit(P2, 'B02', 1);
    const t = transfer(P1, 'B01', 'B02', 2); // basedOn 2 < placedAtSeq 3 of B02
    const b = checked(W(), admit(P1, 'B01', 1), a2, t);
    expect(out(b, t)).toEqual({ kind: 'held', conflictId: 'C-4' });
    expect(out(b, a2)).toEqual({ kind: 'held', conflictId: 'C-4' });
    expect(b.beds.B01?.status).toBe('empty');
    expect(b.beds.B02).toEqual({ label: 'B02', status: 'conflict', conflictId: 'C-4' });
  });

  it('E3: transfer into a conflicted bed joins the conflict', () => {
    const { events } = conflictOnB01();
    const t = transfer(P3, 'B02', 'B01', 1);
    const b = checked(...events.slice(0, 1), admit(P3, 'B02', 1), ...events.slice(1), t);
    expect(out(b, t)).toEqual({ kind: 'held', conflictId: 'C-4' });
    expect(b.conflicts['C-4']?.candidates.map((c) => c.patientId)).toEqual([P1, P2, P3]);
    expect(b.beds.B02?.status).toBe('empty');
  });
});

describe('RENAME (FR-9: later in server order wins)', () => {
  it('unknown patient → noop UNKNOWN_PATIENT (E11)', () => {
    const r = rename(P1, 'X');
    expect(out(checked(W(), r), r)).toEqual({ kind: 'noop', reason: 'UNKNOWN_PATIENT' });
  });

  it('last rename in server order wins', () => {
    const b = checked(W(), admit(P1, 'B01', 1), rename(P1, 'First'), rename(P1, 'Second'));
    expect(b.patients[P1]?.label).toBe('Second');
  });

  it('E2: rename during a conflict updates the held patient', () => {
    const { events } = conflictOnB01();
    const r = rename(P2, 'Renamed');
    const b = checked(...events, r);
    expect(out(b, r)).toEqual({ kind: 'applied' });
    expect(b.patients[P2]).toEqual({ label: 'Renamed', where: { kind: 'held', conflictId: 'C-3' } });
  });

  it('rename of a discharged patient still applies (for the export)', () => {
    const r = rename(P1, 'Late fix');
    expect(out(checked(W(), admit(P1, 'B01', 1), discharge(P1), r), r)).toEqual({ kind: 'applied' });
  });
});

describe('RESOLVE_CONFLICT (FR-7, FR-8)', () => {
  it('acceptance 1: keep one; the other stays in the log, marked rejected', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', a2, [a1, a2]);
    const b = checked(...events, r);
    expect(out(b, r)).toEqual({ kind: 'applied' });
    expect(out(b, a2)).toEqual({ kind: 'applied' });
    expect(out(b, a1)).toEqual({ kind: 'rejected', conflictId: 'C-3', by: r.eventId });
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'occupied', occupant: P2, placedBy: a2.eventId, placedAtSeq: 4 });
    expect(b.patients[P1]?.where).toEqual({ kind: 'unplaced' });
    expect(b.conflicts['C-3']).toMatchObject({ status: 'resolved', resolvedBy: r.eventId });
  });

  it('keep NONE → bed empty, every candidate rejected and unplaced', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', 'NONE', [a1, a2]);
    const b = checked(...events, r);
    expect(b.beds.B01).toEqual({ label: 'B01', status: 'empty' });
    expect([out(b, a1)?.kind, out(b, a2)?.kind]).toEqual(['rejected', 'rejected']);
    expect([b.patients[P1]?.where, b.patients[P2]?.where]).toEqual([{ kind: 'unplaced' }, { kind: 'unplaced' }]);
  });

  it('unknown conflict → invalid UNKNOWN_CONFLICT', () => {
    const r = ev('RESOLVE_CONFLICT', { conflictId: 'C-99', keep: 'NONE', candidatesSeen: [admit(P1, 'B01').eventId] });
    expect(out(checked(W(), r), r)).toEqual({ kind: 'invalid', reason: 'UNKNOWN_CONFLICT' });
  });

  it('E6: second resolution of the same conflict → noop ALREADY_RESOLVED', () => {
    const { a1, a2, events } = conflictOnB01();
    const r2 = resolve('C-3', a2, [a1, a2]);
    const b = checked(...events, resolve('C-3', a1, [a1, a2]), r2);
    expect(out(b, r2)).toEqual({ kind: 'noop', reason: 'ALREADY_RESOLVED' });
    expect(b.beds.B01).toMatchObject({ occupant: P1 });
  });

  it('E7 / E12: candidates changed since the nurse looked → invalid; conflict stays open', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', a1, [a1, a2]);
    const b = checked(...events, admit(P3, 'B01', 1, DEVICE.C), r);
    expect(out(b, r)).toEqual({ kind: 'invalid', reason: 'CANDIDATES_CHANGED' });
    expect(b.conflicts['C-3']).toMatchObject({ status: 'open' });
    expect(b.conflicts['C-3']?.candidates).toHaveLength(3);
  });

  it('keep is not a candidate → invalid NOT_A_CANDIDATE', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', admit(P3, 'B02'), [a1, a2]);
    expect(out(checked(...events, r), r)).toEqual({ kind: 'invalid', reason: 'NOT_A_CANDIDATE' });
  });

  it('after a resolution, only admits that saw it count as "known occupied"', () => {
    const { a1, a2, events } = conflictOnB01();
    const r = resolve('C-3', a1, [a1, a2]); // seq 4
    const stale = admit(P3, 'B01', 3); // saw the conflict, not the resolution → new conflict
    const b = checked(...events, r, stale);
    expect(out(b, stale)).toEqual({ kind: 'held', conflictId: 'C-5' });
    const informed = admit(P3, 'B01', 4);
    expect(out(checked(...events, r, informed), informed)).toEqual({ kind: 'invalid', reason: 'BED_KNOWN_OCCUPIED' });
  });
});

describe('TASK_CREATED / TASK_COMPLETED (FR-15)', () => {
  const task = (bedId: string, title = 'Clean bed') => ev('TASK_CREATED', { bedId, title });
  const done = (t: AnyEvent) => ev('TASK_COMPLETED', { taskId: t.eventId });

  it('opens a task on a bed, keyed by its event ID; completing it records who', () => {
    const t = task('B02');
    const b = checked(W(), t);
    expect(out(b, t)).toEqual({ kind: 'applied' });
    expect(b.tasks[t.eventId]).toEqual({ bedId: 'B02', title: 'Clean bed', assignee: null, dueAt: null, createdBy: 'S-0001', status: 'open', doneBy: null });
    const c = done(t);
    expect(checked(W(), t, c).tasks[t.eventId]).toMatchObject({ status: 'done', doneBy: 'S-0001' });
  });

  it('a task for an unknown bed is invalid; a second completion and an unknown task change nothing', () => {
    const bad = task('B09');
    expect(out(checked(W(), bad), bad)).toEqual({ kind: 'invalid', reason: 'UNKNOWN_BED' });
    const t = task('B01');
    const [c1, c2] = [done(t), done(t)];
    const b = checked(W(), t, c1, c2);
    expect(out(b, c2)).toEqual({ kind: 'noop', reason: 'ALREADY_DONE' });
    const ghost = ev('TASK_COMPLETED', { taskId: '00000000-0000-4000-8000-0000000000ff' });
    expect(out(checked(W(), ghost), ghost)).toEqual({ kind: 'noop', reason: 'UNKNOWN_TASK' });
  });

  it('stays with the bed through discharge and transfer, and keeps that bed from being removed while open', () => {
    const t = task('B01');
    const b = checked(W(), admit(P1, 'B01', 1), t, transfer(P1, 'B01', 'B02'));
    expect(b.tasks[t.eventId]?.bedId).toBe('B01');
    const re = ward('B02', 'B03');
    expect(out(checked(W(), t, re), re)).toEqual({ kind: 'invalid', reason: 'BED_IN_USE' });
    const re2 = ward('B02', 'B03');
    expect(out(checked(W(), t, done(t), re2), re2)).toEqual({ kind: 'applied' });
  });
});

describe('HANDOFF_NOTE_ADDED (FR-15)', () => {
  const note = (bedId: string, text: string) => ev('HANDOFF_NOTE_ADDED', { bedId, text });

  it('records the note on the bed with its writer and the occupant at that time', () => {
    const a = admit(P1, 'B01', 1);
    const n = note('B01', 'Family visiting at 2');
    const b = checked(W(), a, n);
    expect(out(b, n)).toEqual({ kind: 'applied' });
    expect(b.notes.B01).toEqual([{ eventId: n.eventId, text: 'Family visiting at 2', by: 'S-0001', at: n.clientTime, patientId: P1 }]);
    const empty = note('B02', 'Bed needs a new mattress');
    expect(checked(W(), empty).notes.B02?.[0]?.patientId).toBeNull();
  });

  it('a note for an unknown bed is invalid; only the last 5 per bed are kept', () => {
    const bad = note('B09', 'x');
    expect(out(checked(W(), bad), bad)).toEqual({ kind: 'invalid', reason: 'UNKNOWN_BED' });
    const many = Array.from({ length: 7 }, (_, i) => note('B01', `Note ${i}`));
    expect(checked(W(), ...many).notes.B01?.map((x) => x.text)).toEqual(['Note 2', 'Note 3', 'Note 4', 'Note 5', 'Note 6']);
  });

  it('a removed bed takes its notes with it', () => {
    const b = checked(W(), note('B04', 'x'), ward('B01', 'B02'));
    expect(b.notes.B04).toBeUndefined();
  });
});

describe('replay', () => {
  it('E5: replaying the same log (including a resolution) gives the same board', () => {
    const { a1, a2, events } = conflictOnB01();
    const l = log(...events, resolve('C-3', a1, [a1, a2]));
    expect(replay(l, emptyBoard())).toEqual(replay(l, emptyBoard()));
  });

  it('ignores entries it has already applied (same serverSeq or same eventId)', () => {
    const { a1, a2, events } = conflictOnB01();
    const l = log(...events, resolve('C-3', a1, [a1, a2]));
    const once = replay(l, emptyBoard());
    expect(replay([...l, ...l], emptyBoard())).toEqual(once);
    expect(replay([...l, { serverSeq: 99, event: a2 }], emptyBoard())).toEqual({ ...once, atSeq: 99 });
  });

  it('never mutates the board it is given', () => {
    const base = deepFreeze(run(W(), admit(P1, 'B01', 1)));
    const next = replay(log(W(), admit(P1, 'B01', 1), discharge(P1)).slice(2).map((e) => ({ ...e, serverSeq: 3 })), base);
    expect(next.beds.B01?.status).toBe('empty');
    expect(base.beds.B01?.status).toBe('occupied');
  });

  it('tracks atSeq', () => {
    expect(run(W(), admit(P1, 'B01', 1)).atSeq).toBe(2);
    expect(emptyBoard().atSeq).toBe(0);
  });
});
