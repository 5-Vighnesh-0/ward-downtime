// What one bed card shows (design.md §10.4): the optimistic view compared with the confirmed board.
import type { Board } from '@wdb/shared';

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

export function cardName(bedLabel: string, s: CardState): string {
  switch (s.kind) {
    case 'empty':
      return `${bedLabel}, empty`;
    case 'occupied':
      return `${bedLabel}, ${s.label}, ${s.pending ? 'pending, not yet confirmed by ward server' : 'confirmed'}`;
    case 'conflict':
      return `${bedLabel}, conflict between ${s.count} patients, charge nurse must choose`;
    case 'pendingOut':
      return `${bedLabel}, ${s.label}, pending move or discharge`;
  }
}
