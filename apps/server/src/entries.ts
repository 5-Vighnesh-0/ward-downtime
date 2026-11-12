import { asc, gt } from 'drizzle-orm';
import type { AnyEvent } from '@wdb/shared';
import type { LedgerEntry } from './chain.ts';
import { events } from './db/schema.ts';
import type { Db } from './db.ts';

/** Log entries after `after`, in serverSeq order. */
export async function readEntries(db: Db, after: number, limit: number): Promise<LedgerEntry[]> {
  const rows = await db.select().from(events).where(gt(events.serverSeq, after)).orderBy(asc(events.serverSeq)).limit(limit);
  return rows.map((r) => ({
    serverSeq: r.serverSeq,
    serverTime: r.serverTime.toISOString(), // the exact string that was hashed (ms precision)
    prevHash: r.prevHash.toString('hex'),
    hash: r.hash.toString('hex'),
    event: r.body as AnyEvent, // validated on the way in
  }));
}
