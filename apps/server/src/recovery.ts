// Recovery export and audit export (design.md §7.2, §7.3, §9.7; FR-11, FR-14, SEC-15).
import { createHash, randomUUID } from 'node:crypto';
import { asc, gt } from 'drizzle-orm';
import { buildRecoveryExport, csvRow } from '@wdb/shared';
import { auditLog, devices, exports } from './db/schema.ts';
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
