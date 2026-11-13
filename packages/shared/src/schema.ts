// Wire contract for v1 events (design.md §4.1–§4.2; FR-3, SEC-11, SEC-16).
import { z } from 'zod';

const MAX_EVENT_BYTES = 4096;

const patientId = z.string().regex(/^T-[A-Z0-9]{3}-[0-9]{4,6}$/);
const bedId = z.string().regex(/^B[0-9]{2}$/);
// No control characters: they break display, and Postgres jsonb rejects NUL outright.
const noControl = /^[^\u0000-\u001f\u007f]*$/;
const label = z.string().min(1).max(40).regex(noControl);

const envelope = {
  v: z.literal(1),
  eventId: z.uuid(),
  deviceId: z.uuid(),
  deviceSeq: z.int().min(1).max(2147483647),
  staffId: z.string().regex(/^S-[0-9]{4}$/),
  basedOn: z.int().min(0),
  hlc: z.string().regex(/^[0-9]{13}\.[0-9]{1,6}\.[A-Z0-9]{3}$/), // display/audit only (SEC-12)
  clientTime: z.iso.datetime(), // display/audit only (SEC-12)
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/), // Ed25519, base64url
};

const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, type: z.literal(type), payload });

export const WardConfiguredEvent = event(
  'WARD_CONFIGURED',
  z.strictObject({
    beds: z.array(z.strictObject({ bedId, label: z.string().min(1).max(16).regex(noControl) })).min(1).max(60),
    idleLockMinutes: z.int().min(1).max(15).optional(), // SEC-7 per-ward idle lock; absent keeps the last value
  }),
);
export const AdmitEvent = event('ADMIT', z.strictObject({ patientId, label, bedId }));
export const DischargeEvent = event('DISCHARGE', z.strictObject({ patientId, bedId }));
export const TransferEvent = event('TRANSFER', z.strictObject({ patientId, fromBedId: bedId, toBedId: bedId }));
export const RenameEvent = event('RENAME', z.strictObject({ patientId, label }));
export const ResolveConflictEvent = event(
  'RESOLVE_CONFLICT',
  z.strictObject({
    conflictId: z.string().regex(/^C-[0-9]+$/),
    keep: z.union([z.uuid(), z.literal('NONE')]),
    candidatesSeen: z.array(z.uuid()).min(1).max(10),
  }),
);

/** UTF-8 byte length without platform APIs (the shared package stays pure). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export const EventSchema = z
  .discriminatedUnion('type', [WardConfiguredEvent, AdmitEvent, DischargeEvent, TransferEvent, RenameEvent, ResolveConflictEvent])
  .refine((e) => utf8Length(JSON.stringify(e)) <= MAX_EVENT_BYTES, { error: `event exceeds ${MAX_EVENT_BYTES} bytes` });

export type AnyEvent = z.infer<typeof EventSchema>;
export type EventType = AnyEvent['type'];
