// What one bed card shows (design.md §10.4): the optimistic view compared with the confirmed board.
import type { Board, Note } from '@wdb/shared';

export type CardState =
  | { kind: 'empty' }
  | { kind: 'occupied'; patientId: string; label: string; pending: boolean }
  | { kind: 'conflict'; count: number }
  | { kind: 'pendingOut'; patientId: string; label: string }; // confirmed here, but a pending change moves them out

export function cardState(bedId: string, view: Board, confirmed: Board): CardState {
  const bed = view.beds[bedId];
  const was = confirmed.beds[bedId];
  if (bed?.status === 'conflict') return { kind: 'conflict', count: view.conflicts[bed.conflictId]?.candidates.length ?? 0 };
  if (bed?.status === 'occupied') {
    const label = view.patients[bed.occupant]?.label ?? '';
    const pending = was?.status !== 'occupied' || was.occupant !== bed.occupant || confirmed.patients[bed.occupant]?.label !== label;
    return { kind: 'occupied', patientId: bed.occupant, label, pending };
  }
  if (was?.status === 'occupied') return { kind: 'pendingOut', patientId: was.occupant, label: confirmed.patients[was.occupant]?.label ?? '' };
  return { kind: 'empty' };
}

export interface TaskSummary {
  open: number;
  overdue: number;
}

/** Open tasks on a bed (FR-15). Overdue uses this tablet's clock: display only, never ordering (SEC-12). */
export function taskSummary(view: Board, bedId: string, now: number): TaskSummary {
  const open = Object.values(view.tasks ?? {}).filter((t) => t.bedId === bedId && t.status === 'open');
  return { open: open.length, overdue: open.filter((t) => t.dueAt !== null && Date.parse(t.dueAt) < now).length };
}

/** "2 tasks, 1 overdue": the card shows the same words, so they stay inside its accessible name (WCAG 2.5.3). */
export const taskWords = (t: TaskSummary | undefined): string[] =>
  !t || t.open === 0 ? [] : [`${t.open} ${t.open === 1 ? 'task' : 'tasks'}`, ...(t.overdue ? [`${t.overdue} overdue`] : [])];

export function cardName(bedLabel: string, s: CardState, tasks?: TaskSummary): string {
  const t = taskWords(tasks).map((w) => `, ${w}`).join('');
  switch (s.kind) {
    case 'empty':
      return `${bedLabel}, empty${t}`;
    case 'occupied':
      return `${bedLabel}, ${s.label}${t}, ${s.pending ? 'pending, not yet confirmed by ward server' : 'confirmed'}`;
    case 'conflict':
      return `${bedLabel}, conflict: ${s.count} patients${t}, charge nurse must choose`; // contains the visible text (WCAG 2.5.3)
    case 'pendingOut':
      return `${bedLabel}, ${s.label}${t}, pending move or discharge`;
  }
}

export const FILTERS = ['All', 'Empty', 'Occupied', 'Conflict', 'Pending'] as const;
export type Filter = (typeof FILTERS)[number];

/** Board filters (design.md §10.2). A pending move or discharge still has its patient in the bed, so it counts as occupied. */
export function matches(f: Filter, s: CardState): boolean {
  switch (f) {
    case 'All':
      return true;
    case 'Empty':
      return s.kind === 'empty';
    case 'Occupied':
      return s.kind === 'occupied' || s.kind === 'pendingOut';
    case 'Conflict':
      return s.kind === 'conflict';
    case 'Pending':
      return (s.kind === 'occupied' && s.pending) || s.kind === 'pendingOut';
  }
}

/** Handoff notes written for whoever is in the bed now (none when empty means notes written while it was empty), newest first. */
export function notesFor(view: Board, bedId: string): Note[] {
  const bed = view.beds[bedId];
  const occupant = bed?.status === 'occupied' ? bed.occupant : null;
  return (view.notes?.[bedId] ?? []).filter((n) => n.patientId === occupant).reverse();
}
