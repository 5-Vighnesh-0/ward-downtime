// `pnpm --filter @wdb/server verify-chain` (DATABASE_URL): walks the whole log and checks every hash (SEC-10).
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { GENESIS_HASH, verifyEntries, type ChainResult } from './chain.ts';
import { logHead } from './db/schema.ts';
import { createDb, type Db } from './db.ts';
import { readEntries } from './entries.ts';

const PAGE = 1000;

export async function verifyChain(db: Db): Promise<ChainResult> {
  let at = { seq: 0, hash: GENESIS_HASH.toString('hex') };
  for (;;) {
    const page = await readEntries(db, at.seq, PAGE);
    const r = verifyEntries(page, at);
    if (!r.ok) return r;
    at = { seq: r.headSeq, hash: r.headHash };
    if (page.length < PAGE) break;
  }
  const [head] = await db.select().from(logHead).where(eq(logHead.id, 1));
  if (!head || head.lastSeq !== at.seq || head.lastHash.toString('hex') !== at.hash) {
    return { ok: false, firstBadSeq: at.seq + 1, reason: 'HEAD_MISMATCH' };
  }
  return { ok: true, headSeq: at.seq, headHash: at.hash };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  const r = await verifyChain(db);
  await pool.end();
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
