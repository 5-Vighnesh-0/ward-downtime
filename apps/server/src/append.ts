// Push path (design.md §5.3): verify, dedupe, order and chain one device's batch in one transaction.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ALLOWED_ROLES, canonicalize, EventSchema, type Role } from '@wdb/shared';
import { entryHash } from './chain.ts';
import { auditLog, devices, events, logHead, sessions, staff } from './db/schema.ts';
import type { Db } from './db.ts';
import { publicKeyFromRaw, verifySignature } from './signature.ts';

export type RefusalCode =
  | 'SCHEMA_INVALID'
  | 'DEVICE_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'IDEMPOTENCY_MISMATCH'
  | 'ROLE_FORBIDDEN'
  | 'STAFF_NOT_ON_DEVICE'
  | 'DEVICE_SEQ_REGRESSION';

export type EventResult =
  | { eventId: string; status: 'appended' | 'duplicate'; serverSeq: number }
  | { eventId: string | null; status: 'refused'; code: RefusalCode };

export type BatchOutcome =
  | { ok: true; headSeq: number; headHash: string; results: EventResult[] }
  | { ok: false; status: 403; code: 'DEVICE_NOT_ACTIVE' | 'DEVICE_REVOKED' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventIdOf = (raw: unknown): string | null => {
  const id = (raw as { eventId?: unknown } | null)?.eventId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest();

const AUDIT = { appended: ['EVENT_APPEND', 'ok'], duplicate: ['EVENT_DUPLICATE', 'duplicate'], refused: ['EVENT_REFUSED', 'refused'] } as const;

/** `importing`: an admin imports a saved device file (§8.4), so a revoked device's key still verifies its own events. */
export function appendBatch(db: Db, deviceId: string, raw: unknown[], ctx: { requestId: string; importing?: boolean } = { requestId: 'internal' }): Promise<BatchOutcome> {
  return db.transaction(async (tx) => {
    const [device] = await tx.select().from(devices).where(eq(devices.deviceId, deviceId)).for('update');
    if (!device || (device.status !== 'active' && !(ctx.importing && device.status === 'revoked'))) {
      const code = device?.status === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_NOT_ACTIVE';
      await tx.insert(auditLog).values({ deviceId: device ? deviceId : null, action: 'PUSH_DENIED', outcome: 'denied', code, requestId: ctx.requestId });
      return { ok: false, status: 403, code };
    }

    // One row lock serializes every append, so serverSeq is gap-free and the chain is linear (FR-5).
    const [head] = await tx.select().from(logHead).where(eq(logHead.id, 1)).for('update');
    if (!head) throw new Error('log_head row missing; run migrations');
    let { lastSeq, lastHash } = head;
    let lastDeviceSeq = device.lastDeviceSeq;
    const key = publicKeyFromRaw(device.publicKey);
    const roles = new Map<string, Role | null>();
    const onDevice = new Map<string, boolean>();
    const results: EventResult[] = [];
    const staffOf: (string | null)[] = []; // per result, for the audit rows (SEC-18)

    for (const r of raw) {
      let who: string | null = null;
      const refuse = (code: RefusalCode, eventId = eventIdOf(r)) => {
        results.push({ eventId, status: 'refused', code });
        staffOf.push(who);
      };
      const parsed = EventSchema.safeParse(r);
      if (!parsed.success) {
        refuse('SCHEMA_INVALID');
        continue;
      }
      const e = parsed.data;
      who = e.staffId;
      if (e.deviceId !== deviceId) {
        refuse('DEVICE_MISMATCH');
        continue;
      }
      if (!verifySignature(e, key)) {
        refuse('SIGNATURE_INVALID');
        continue;
      }
      // Before the role check, so a retry after a staff change still reports "duplicate" (FR-4).
      const bodySha256 = sha256(canonicalize(e));
      const [existing] = await tx
        .select({ serverSeq: events.serverSeq, bodySha256: events.bodySha256 })
        .from(events)
        .where(eq(events.eventId, e.eventId));
      if (existing) {
        if (existing.bodySha256.equals(bodySha256)) {
          results.push({ eventId: e.eventId, status: 'duplicate', serverSeq: existing.serverSeq });
          staffOf.push(who);
        } else refuse('IDEMPOTENCY_MISMATCH');
        continue;
      }
      if (!roles.has(e.staffId)) {
        const [s] = await tx.select({ role: staff.role, status: staff.status }).from(staff).where(eq(staff.staffId, e.staffId));
        roles.set(e.staffId, s?.status === 'active' ? s.role : null);
      }
      const role = roles.get(e.staffId);
      if (!role || !ALLOWED_ROLES[e.type].includes(role)) {
        refuse('ROLE_FORBIDDEN');
        continue;
      }
      // SEC-6, SEC-18: the staffId is inside the device-signed body, so a modified client could name anyone. Only staff
      // who have signed in on this tablet can have made a change on it (offline sign-in needs an earlier online one).
      if (!onDevice.has(e.staffId)) {
        const [s] = await tx.select({ x: sessions.staffId }).from(sessions).where(and(eq(sessions.staffId, e.staffId), eq(sessions.deviceId, deviceId))).limit(1);
        // Sessions are not in backups; after a restore the SIGNIN_OK audit rows (which are) still show who used the tablet.
        const [a] = s ? [s] : await tx.select({ x: auditLog.staffId }).from(auditLog).where(and(eq(auditLog.staffId, e.staffId), eq(auditLog.deviceId, deviceId), eq(auditLog.action, 'SIGNIN_OK'))).limit(1);
        onDevice.set(e.staffId, Boolean(a));
      }
      if (!onDevice.get(e.staffId)) {
        refuse('STAFF_NOT_ON_DEVICE');
        continue;
      }
      if (e.deviceSeq <= lastDeviceSeq) {
        // An admin import may bring back an event refused earlier (its cause since fixed) after newer ones from the
        // same tablet: allowed as long as the log has no event under that deviceSeq (§6.4, §8.4).
        const [taken] = ctx.importing ? await tx.select({ id: events.eventId }).from(events).where(and(eq(events.deviceId, deviceId), eq(events.deviceSeq, e.deviceSeq))) : [true];
        if (taken) {
          refuse('DEVICE_SEQ_REGRESSION');
          continue;
        }
      }

      const serverSeq = lastSeq + 1;
      const serverTime = new Date().toISOString(); // audit only; order comes from serverSeq (SEC-12)
      const hash = entryHash(lastHash, serverSeq, serverTime, e);
      await tx.insert(events).values({
        serverSeq,
        eventId: e.eventId,
        deviceId,
        deviceSeq: e.deviceSeq,
        staffId: e.staffId,
        type: e.type,
        body: e,
        bodySha256,
        clientTime: new Date(e.clientTime),
        serverTime: new Date(serverTime),
        prevHash: lastHash,
        hash,
      });
      results.push({ eventId: e.eventId, status: 'appended', serverSeq });
      staffOf.push(who);
      lastSeq = serverSeq;
      lastHash = hash;
      lastDeviceSeq = Math.max(lastDeviceSeq, e.deviceSeq);
    }

    await tx.update(logHead).set({ lastSeq, lastHash }).where(eq(logHead.id, 1));
    await tx.update(devices).set({ lastDeviceSeq, lastSeenAt: new Date() }).where(eq(devices.deviceId, deviceId));
    if (results.length > 0) {
      await tx.insert(auditLog).values(
        results.map((x, i) => ({
          staffId: staffOf[i] ?? null,
          deviceId,
          action: AUDIT[x.status][0],
          eventId: x.eventId,
          outcome: AUDIT[x.status][1],
          code: x.status === 'refused' ? x.code : null,
          requestId: ctx.requestId,
        })),
      );
    }
    return { ok: true, headSeq: lastSeq, headHash: lastHash.toString('hex'), results };
  });
}
