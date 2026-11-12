// `pnpm --filter @wdb/server migrate` (DATABASE_URL of the owner role).
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.ts';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export const runMigrations = (db: NodePgDatabase<Record<string, unknown>>) => migrate(db, { migrationsFolder });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  await runMigrations(db);
  await pool.end();
  console.log('migrations applied');
}
