import { readFileSync } from 'node:fs';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './db/schema.ts';

export type Db = NodePgDatabase<typeof schema>;

/** In Docker the password comes from a secret file (PGPASSWORD_FILE), never from the URL or the image (§11.1). */
export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  // Via PGPASSWORD: a `password` option would be overwritten by the URL parser's `password: undefined`.
  const file = process.env.PGPASSWORD_FILE;
  if (file) process.env.PGPASSWORD = readFileSync(file, 'utf8').trim();
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
