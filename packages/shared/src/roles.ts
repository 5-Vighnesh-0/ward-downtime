// Who may record which event (design.md §9.5, SEC-6). The server enforces this; the UI only hides actions.
import type { EventType } from './schema.ts';

export type Role = 'clerk' | 'nurse' | 'charge' | 'admin';

const ALL: readonly Role[] = ['clerk', 'nurse', 'charge', 'admin'];

export const ALLOWED_ROLES: Record<EventType, readonly Role[]> = {
  WARD_CONFIGURED: ['admin'],
  ADMIT: ALL,
  DISCHARGE: ALL,
  TRANSFER: ALL,
  RENAME: ALL,
  RESOLVE_CONFLICT: ['charge', 'admin'],
  TASK_CREATED: ALL,
  TASK_COMPLETED: ALL,
};
