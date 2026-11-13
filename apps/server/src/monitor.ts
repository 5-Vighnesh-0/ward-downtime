// Health and alerts (design.md §13.2, §13.3; SEC-20). Counts come from audit_log, so they survive restarts;
// only push timing is in memory. Nothing here holds patient data.
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { auditLog, devices, logHead } from './db/schema.ts';
import type { ChainResult } from './chain.ts';
import type { Db } from './db.ts';
import { verifyChain } from './verify-chain.ts';

export type AlertCode = 'AUTH_FAILURES' | 'SIGNATURE_FAILURE' | 'EVENT_FLOOD' | 'CLOCK_SKEW' | 'DEVICE_LAGGING' | 'CHAIN_BREAK' | 'BACKUP_STALE';
export interface Alert {
  code: AlertCode;
  detail: string; // staff ID, device label or count; never a patient label
}

export const SKEW_ALERT_MS = 120_000;
const MIN = 60_000;
const since = (ms: number) => new Date(Date.now() - ms);

export function createMonitor(db: Db, log: FastifyBaseLogger) {
  const pushMs: number[] = []; // last 1000 push batches
  let raised = new Set<string>();
  const startedAt = Date.now();
  let chain: (ChainResult & { checkedAt: string }) | null = null;

  /** SEC-10: walk the whole log. Run at boot and hourly by main.ts; a failure is audited and alerted. */
  async function checkChain(): Promise<ChainResult> {
    const r = await verifyChain(db);
    chain = { ...r, checkedAt: new Date().toISOString() };
    if (r.ok) log.info({ event: 'chain_verify', ok: true, headSeq: r.headSeq });
    else {
      log.error({ event: 'chain_verify', ok: false, firstBadSeq: r.firstBadSeq, reason: r.reason });
      await db.insert(auditLog).values({ action: 'CHAIN_VERIFY_FAIL', outcome: 'error', code: String(r.firstBadSeq), requestId: 'verify' });
    }
    return r;
  }

  async function lastBackupAt(): Promise<Date | null> {
    const [b] = await db.select({ at: auditLog.serverTime }).from(auditLog).where(eq(auditLog.action, 'BACKUP_DONE')).orderBy(desc(auditLog.auditId)).limit(1);
    return b?.at ?? null;
  }

  async function alerts(): Promise<Alert[]> {
    const out: Alert[] = [];
    const fails = await db.execute<{ who: string; n: number }>(sql`
      SELECT 'staff ' || staff_id AS who, count(*)::int AS n FROM audit_log
        WHERE action = 'SIGNIN_FAIL' AND server_time > ${since(5 * MIN)} AND staff_id IS NOT NULL GROUP BY staff_id HAVING count(*) >= 10
      UNION ALL
      SELECT 'device ' || d.label, count(*)::int FROM audit_log a JOIN devices d USING (device_id)
        WHERE a.action = 'SIGNIN_FAIL' AND a.server_time > ${since(5 * MIN)} GROUP BY d.label HAVING count(*) >= 10`);
    for (const r of fails.rows) out.push({ code: 'AUTH_FAILURES', detail: `${r.n} failed sign-ins in 5 min (${r.who})` });

    const [sig] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'EVENT_REFUSED'), eq(auditLog.code, 'SIGNATURE_INVALID'), gt(auditLog.serverTime, since(24 * 60 * MIN))));
    if (sig && sig.n > 0) out.push({ code: 'SIGNATURE_FAILURE', detail: `${sig.n} events with a bad signature in 24 h` });

    const flood = await db.execute<{ label: string; n: number }>(sql`
      SELECT d.label, count(*)::int AS n FROM audit_log a JOIN devices d USING (device_id)
        WHERE a.action = 'EVENT_APPEND' AND a.server_time > ${since(MIN)} GROUP BY d.label HAVING count(*) > 300`);
    for (const r of flood.rows) out.push({ code: 'EVENT_FLOOD', detail: `${r.n} events in 1 min from ${r.label}` });

    const devs = await db.select({ label: devices.label, offset: devices.lastClockOffsetMs, seen: devices.lastSeenAt }).from(devices).where(eq(devices.status, 'active'));
    for (const d of devs) {
      if (d.offset !== null && Math.abs(d.offset) > SKEW_ALERT_MS) out.push({ code: 'CLOCK_SKEW', detail: `${d.label} clock is ${Math.round(d.offset / 1000)} s off` });
      // shortcut: "lagging" = not seen for an hour; the server cannot see a tablet's unsent count. Add a device report if needed.
      if (d.seen && d.seen < since(60 * MIN)) out.push({ code: 'DEVICE_LAGGING', detail: `${d.label} not seen for over an hour` });
    }

    if (chain && !chain.ok) out.push({ code: 'CHAIN_BREAK', detail: `log entry ${chain.firstBadSeq} does not verify (${chain.reason})` });
    // No backup yet is only stale once the server has been up for an hour (a fresh install has had no chance).
    const backup = await lastBackupAt();
    if (backup ? backup < since(60 * MIN) : Date.now() - startedAt > 60 * MIN) {
      out.push({ code: 'BACKUP_STALE', detail: backup ? `newest backup is from ${backup.toISOString()}` : 'no backup since the server started' });
    }

    const now = new Set(out.map((a) => `${a.code} ${a.detail}`));
    for (const a of out) if (!raised.has(`${a.code} ${a.detail}`)) log.error({ event: 'alert', code: a.code, detail: a.detail }, 'alert raised');
    raised = now;
    return out;
  }

  async function health() {
    const [head] = await db.select().from(logHead).where(eq(logHead.id, 1));
    const counts = await db.execute<{ action: string; code: string | null; n: number }>(sql`
      SELECT action, code, count(*)::int AS n FROM audit_log
        WHERE server_time > ${since(24 * 60 * MIN)} AND action IN ('EVENT_APPEND', 'EVENT_DUPLICATE', 'EVENT_REFUSED', 'SIGNIN_FAIL') GROUP BY action, code`);
    const n = (action: string, code?: string) => counts.rows.filter((r) => r.action === action && (code === undefined || r.code === code)).reduce((s, r) => s + r.n, 0);
    const sorted = [...pushMs].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return {
      headSeq: head?.lastSeq ?? 0,
      headHash: head?.lastHash.toString('hex') ?? '',
      devices: await db
        .select({ label: devices.label, status: devices.status, lastSeenAt: devices.lastSeenAt, clockOffsetMs: devices.lastClockOffsetMs, lastDeviceSeq: devices.lastDeviceSeq })
        .from(devices)
        .orderBy(devices.label),
      last24h: { appended: n('EVENT_APPEND'), duplicate: n('EVENT_DUPLICATE'), refused: n('EVENT_REFUSED'), signinFailures: n('SIGNIN_FAIL'), signatureFailures: n('EVENT_REFUSED', 'SIGNATURE_INVALID') },
      pushMs: { count: sorted.length, p50: pct(0.5), p95: pct(0.95) },
      chain,
      backupAgeSeconds: await lastBackupAt().then((b) => (b ? Math.round((Date.now() - b.getTime()) / 1000) : null)),
      alerts: await alerts(),
    };
  }

  return {
    recordPush: (ms: number) => {
      pushMs.push(ms);
      if (pushMs.length > 1000) pushMs.shift();
    },
    alerts,
    health,
    checkChain,
  };
}
