// Encrypted backups and restore (design.md §11.3; SEC-13, SEC-27).
// The schema is entirely our migrations, so a backup is our tables' rows as gzipped JSON lines, encrypted with
// AES-256-GCM under the `backup_key` secret. Restore = migrations on an empty database, then the rows, then
// verify-chain. Sessions are left out: after a restore everyone signs in again.
//   node src/backup.ts backup --dir /backups [--every-minutes 15]   (app role: read-only on the data)
//   node src/backup.ts restore <file>                               (owner role, empty database)
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import type pg from 'pg';
import { createDb, type Db } from './db.ts';
import { runMigrations } from './migrate.ts';
import { verifyChain } from './verify-chain.ts';

const MAGIC = Buffer.from('WDBB1');
const TABLES = [
  ['staff', 'staff_id'],
  ['devices', 'device_id'],
  ['events', 'server_seq'],
  ['audit_log', 'audit_id'],
  ['exports', 'created_at, export_id'],
] as const;
const PAGE = 5000;

// Buffers (bytea) survive JSON as {"$b": base64}; dates become ISO strings, which Postgres reads back as given.
const replacer = (_k: string, v: unknown) => {
  const b = v as { type?: string; data?: number[] } | null;
  return b && b.type === 'Buffer' && Array.isArray(b.data) ? { $b: Buffer.from(b.data).toString('base64') } : v;
};
const reviver = (_k: string, v: unknown) => (v && typeof v === 'object' && '$b' in v ? Buffer.from((v as { $b: string }).$b, 'base64') : v);

export interface BackupData {
  header: { format: 'wdb-backup/1'; createdAt: string; headSeq: number; headHash: string };
  rows: Record<string, Record<string, unknown>[]>;
}

export async function takeBackup(pool: pg.Pool, key: Buffer): Promise<{ bytes: Buffer; headSeq: number }> {
  if (key.length !== 32) throw new Error('backup key must be 32 bytes');
  const client = await pool.connect();
  try {
    // One snapshot for every table, so the backup is consistent while tablets keep pushing.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const head = (await client.query('SELECT last_seq, last_hash FROM log_head WHERE id = 1')).rows[0] as { last_seq: string; last_hash: Buffer };
    const header = { format: 'wdb-backup/1', createdAt: new Date().toISOString(), headSeq: Number(head.last_seq), headHash: head.last_hash.toString('hex') };
    const lines = [JSON.stringify(header)];
    for (const [table, order] of TABLES) {
      for (let offset = 0; ; offset += PAGE) {
        const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`);
        for (const r of rows) lines.push(JSON.stringify({ t: table, r }, replacer));
        if (rows.length < PAGE) break;
      }
    }
    await client.query('COMMIT');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([c.update(gzipSync(lines.join('\n'))), c.final()]);
    await pool.query("INSERT INTO audit_log (action, outcome, code, request_id) VALUES ('BACKUP_DONE', 'ok', $1, 'backup')", [String(header.headSeq)]);
    return { bytes: Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]), headSeq: header.headSeq };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Throws on a wrong key or any change to the file (GCM). */
export function openBackup(bytes: Buffer, key: Buffer): BackupData {
  if (!bytes.subarray(0, 5).equals(MAGIC)) throw new Error('not a ward board backup');
  const iv = bytes.subarray(5, 17);
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAuthTag(bytes.subarray(-16));
  const text = gunzipSync(Buffer.concat([d.update(bytes.subarray(17, -16)), d.final()])).toString('utf8');
  const [first = '', ...rest] = text.split('\n');
  const rows: BackupData['rows'] = {};
  for (const line of rest) {
    const { t, r } = JSON.parse(line, reviver) as { t: string; r: Record<string, unknown> };
    (rows[t] ??= []).push(r);
  }
  return { header: JSON.parse(first) as BackupData['header'], rows };
}

/** Into an empty database only. Ends with verify-chain, so a damaged backup is caught before anyone uses it. */
export async function restoreDatabase(pool: pg.Pool, db: Db, data: BackupData): Promise<{ headSeq: number; headHash: string; ms: number }> {
  const t0 = performance.now();
  await runMigrations(db);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const used = (await client.query('SELECT (SELECT count(*) FROM events) + (SELECT count(*) FROM staff) AS n')).rows[0] as { n: string };
    if (Number(used.n) > 0) throw new Error('target database is not empty');
    for (const [table] of TABLES) {
      const rows = data.rows[table] ?? [];
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const cols = Object.keys(batch[0] ?? {});
        if (!cols.every((c) => /^[a-z][a-z0-9_]*$/.test(c))) throw new Error(`unexpected column in backup: ${cols.join(',')}`);
        const values = batch.map((_, r) => `(${cols.map((_c, k) => `$${r * cols.length + k + 1}`).join(',')})`).join(',');
        await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, batch.flatMap((row) => cols.map((c) => row[c])));
      }
    }
    await client.query('UPDATE log_head SET last_seq = $1, last_hash = $2 WHERE id = 1', [data.header.headSeq, Buffer.from(data.header.headHash, 'hex')]);
    await client.query("SELECT setval('audit_log_audit_id_seq', GREATEST((SELECT max(audit_id) FROM audit_log), 1))");
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  const chain = await verifyChain(db);
  if (!chain.ok) throw new Error(`restored log does not verify: ${chain.reason} at ${chain.firstBadSeq}`);
  return { headSeq: chain.headSeq, headHash: chain.headHash, ms: Math.round(performance.now() - t0) };
}

// `wdb-20261112T120000Z-412.backup`: the time sorts as text, the head seq is for people.
export const backupFileName = (at: Date, headSeq: number) => `wdb-${at.toISOString().replace(/[-:]|\.\d{3}/g, '')}-${headSeq}.backup`;
const NAME = /^wdb-(\d{8})T(\d{6})Z-\d+\.backup$/;

/** Which files to keep: the newest 96, the newest of each of the last 30 days and 12 months. Others are untouched. */
export function keep(files: readonly string[], nowMs: number): string[] {
  const ours = files.filter((f) => NAME.test(f)).sort().reverse(); // newest first
  const day = (f: string) => f.slice(4, 12);
  const kept = new Set(ours.slice(0, 96));
  const seen = { day: new Set<string>(), month: new Set<string>() };
  for (const f of ours) {
    const age = nowMs - Date.parse(`${f.slice(4, 8)}-${f.slice(8, 10)}-${f.slice(10, 12)}T00:00:00Z`);
    if (age <= 30 * 86_400_000 && !seen.day.has(day(f))) {
      seen.day.add(day(f));
      kept.add(f);
    }
    if (age <= 365 * 86_400_000 && !seen.month.has(f.slice(4, 10))) {
      seen.month.add(f.slice(4, 10));
      kept.add(f);
    }
  }
  return files.filter((f) => !NAME.test(f) || kept.has(f));
}

async function backupOnce(pool: pg.Pool, key: Buffer, dir: string): Promise<void> {
  const { bytes, headSeq } = await takeBackup(pool, key);
  const name = backupFileName(new Date(), headSeq);
  writeFileSync(join(dir, `${name}.part`), bytes, { flag: 'wx', mode: 0o600 });
  renameSync(join(dir, `${name}.part`), join(dir, name)); // a crash never leaves a half file under a real name
  const all = readdirSync(dir);
  const kept = new Set(keep(all, Date.now()));
  for (const f of all) if (!kept.has(f)) rmSync(join(dir, f));
  console.log(JSON.stringify({ level: 30, time: Date.now(), event: 'backup_done', headSeq, bytes: bytes.length, file: name }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { dir: { type: 'string' }, 'every-minutes': { type: 'string' } } });
  const url = process.env.DATABASE_URL;
  const keyFile = process.env.WDB_BACKUP_KEY_FILE;
  if (!url || !keyFile) throw new Error('DATABASE_URL and WDB_BACKUP_KEY_FILE are required');
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  const { db, pool } = createDb(url);
  if (command === 'backup' && values.dir) {
    const every = Number(values['every-minutes'] ?? 0);
    for (;;) {
      await backupOnce(pool, key, values.dir).catch((e) => console.error(JSON.stringify({ level: 50, time: Date.now(), event: 'backup_failed', error: String(e) })));
      if (!every) break;
      await new Promise((r) => setTimeout(r, every * 60_000));
    }
  } else if (command === 'restore' && positionals[0]) {
    const r = await restoreDatabase(pool, db, openBackup(readFileSync(positionals[0]), key));
    console.log(`restored head ${r.headSeq} ${r.headHash} in ${r.ms} ms; chain verified`);
  } else {
    throw new Error('usage: backup --dir <dir> [--every-minutes 15] | restore <file>');
  }
  await pool.end();
}
