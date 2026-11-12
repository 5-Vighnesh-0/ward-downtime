// `pnpm --filter @wdb/server migrate` (DATABASE_URL of the owner role; WDB_APP_PASSWORD_FILE also enables the app role).
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.ts';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export const runMigrations = (db: NodePgDatabase<Record<string, unknown>>) => migrate(db, { migrationsFolder });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  await runMigrations(db);
  // Deploy: let the app role log in with the password from its secret file. %L quotes it as a literal.
  const appPassword = process.env.WDB_APP_PASSWORD_FILE;
  if (appPassword) {
    const { rows } = await pool.query<{ q: string }>('SELECT format($$ALTER ROLE wdb_app LOGIN PASSWORD %L$$, $1::text) AS q', [readFileSync(appPassword, 'utf8').trim()]);
    await pool.query(rows[0]?.q ?? '');
    console.log('wdb_app password set');
  }
  await pool.end();
  console.log('migrations applied');
}
