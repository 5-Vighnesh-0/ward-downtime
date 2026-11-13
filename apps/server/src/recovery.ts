// Recovery export and audit export (design.md §7.2, §7.3, §9.7; FR-11, FR-14, SEC-15).
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildRecoveryExport, canonicalize, csvRow, EventSchema } from '@wdb/shared';
import { entryHash } from './chain.ts';
import { auditLog, devices, events, exports, logHead } from './db/schema.ts';
import { publicKeyFromRaw, verifySignature } from './signature.ts';
import type { Db } from './db.ts';
import { readEntries } from './entries.ts';
import { plainWdbx, sealWdbx } from './wdbx.ts';

const PAGE = 5000;

export interface ExportFile {
  filename: string;
  body: string;
  sha256: string;
  upToSeq: number;
}

/** passphrase null = unencrypted (admin opt-out; the route enforces who may). */
export async function createRecoveryExport(db: Db, o: { staffId: string; passphrase: string | null; ward: string | null }): Promise<ExportFile> {
  const entries = [];
  for (let after = 0; ; ) {
    const page = await readEntries(db, after, PAGE);
    entries.push(...page);
    if (page.length < PAGE) break;
    after = page.at(-1)?.serverSeq ?? after;
  }
  const labels = Object.fromEntries((await db.select({ id: devices.deviceId, label: devices.label }).from(devices)).map((d) => [d.id, d.label]));
  const { json, csv, upToSeq } = buildRecoveryExport(entries, { generatedAt: new Date().toISOString(), ward: o.ward, source: 'server', deviceLabels: labels });
  const files = { 'recovery.json': json, 'recovery.csv': csv };
  const body = o.passphrase === null ? plainWdbx(files) : sealWdbx(files, o.passphrase);
  const sha = createHash('sha256').update(body).digest();
  await db.insert(exports).values({ exportId: randomUUID(), createdBy: o.staffId, upToSeq, formats: ['json', 'csv'], encrypted: o.passphrase !== null, sha256: sha });
  return { filename: `recovery-${upToSeq}.wdbx`, body, sha256: sha.toString('hex'), upToSeq };
}

/** The whole audit log as CSV inside an encrypted `.wdbx` (FR-14). It never holds patient labels. */
export async function createAuditExport(db: Db, passphrase: string): Promise<ExportFile> {
  const cols = ['auditId', 'serverTime', 'staffId', 'deviceId', 'action', 'eventId', 'outcome', 'code', 'requestId'] as const;
  let csv = csvRow([...cols]);
  for (let after = 0; ; ) {
    const page = await db.select().from(auditLog).where(gt(auditLog.auditId, after)).orderBy(asc(auditLog.auditId)).limit(PAGE);
    for (const r of page) csv += csvRow(cols.map((c) => (c === 'serverTime' ? r.serverTime.toISOString() : r[c])));
    if (page.length < PAGE) break;
    after = page.at(-1)?.auditId ?? after;
  }
  const body = sealWdbx({ 'audit.csv': csv }, passphrase);
  return { filename: `audit-${new Date().toISOString().slice(0, 10)}.wdbx`, body, sha256: createHash('sha256').update(body).digest('hex'), upToSeq: 0 };
}

export type ReplayResult = { ok: true; headSeq: number; headHash: string; replayed: number } | { ok: false; code: 'CHAIN_MISMATCH' | 'UNKNOWN_DEVICE'; atSeq: number };

/**
 * §11.4: a server restored from an old backup gets back the entries it lost, from the tablet with the longest log.
 * Each entry must extend the head (seq and prevHash), hash to its stored hash, pass the schema and carry a valid
 * signature from its device. It is then inserted verbatim (same serverSeq, serverTime and hash). All or nothing.
 */
export async function replayEntries(db: Db, raw: readonly unknown[]): Promise<ReplayResult> {
  return db.transaction(async (tx) => {
    const [head] = await tx.select().from(logHead).where(eq(logHead.id, 1)).for('update');
    if (!head) throw new Error('log_head row missing; run migrations');
    let seq = head.lastSeq;
    let prev = head.lastHash;
    let replayed = 0;
    const keys = new Map<string, KeyObject | null>();
    const fail = (code: 'CHAIN_MISMATCH' | 'UNKNOWN_DEVICE', atSeq: number) => {
      // Throwing rolls the whole replay back.
      throw Object.assign(new Error(code), { replay: { ok: false, code, atSeq } satisfies ReplayResult });
    };
    for (const r of raw) {
      const e = Entry.safeParse(r);
      if (!e.success) return fail('CHAIN_MISMATCH', seq + 1);
      const { serverSeq, serverTime, hash, event } = e.data;
      if (serverSeq <= seq) continue; // the server already has it
      // Hashing over the server's own head also checks the seq and prevHash: a gap or a foreign chain never matches.
      if (entryHash(prev, serverSeq, serverTime, event).toString('hex') !== hash) return fail('CHAIN_MISMATCH', serverSeq);
      if (!keys.has(event.deviceId)) {
        const [dev] = await tx.select({ key: devices.publicKey }).from(devices).where(eq(devices.deviceId, event.deviceId));
        keys.set(event.deviceId, dev ? publicKeyFromRaw(dev.key) : null);
      }
      const key = keys.get(event.deviceId);
      if (!key) return fail('UNKNOWN_DEVICE', serverSeq);
      if (!verifySignature(event, key)) return fail('CHAIN_MISMATCH', serverSeq);
      const h = Buffer.from(hash, 'hex');
      await tx.insert(events).values({
        serverSeq,
        eventId: event.eventId,
        deviceId: event.deviceId,
        deviceSeq: event.deviceSeq,
        staffId: event.staffId,
        type: event.type,
        body: event,
        bodySha256: createHash('sha256').update(canonicalize(event)).digest(),
        clientTime: new Date(event.clientTime),
        serverTime: new Date(serverTime),
        prevHash: prev,
        hash: h,
      });
      await tx.update(devices).set({ lastDeviceSeq: sql`GREATEST(${devices.lastDeviceSeq}, ${event.deviceSeq})` }).where(eq(devices.deviceId, event.deviceId));
      seq = serverSeq;
      prev = h;
      replayed += 1;
    }
    await tx.update(logHead).set({ lastSeq: seq, lastHash: prev }).where(eq(logHead.id, 1));
    return { ok: true as const, headSeq: seq, headHash: prev.toString('hex'), replayed };
  }).catch((e: { replay?: ReplayResult }) => {
    if (e.replay) return e.replay;
    throw e;
  });
}

const Entry = z.strictObject({
  serverSeq: z.int().min(1),
  serverTime: z.iso.datetime(),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  event: EventSchema,
});
