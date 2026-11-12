// Rebuilds the test schema from the real migrations once per run, then lets wdb_app log in.
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../src/migrate.ts';
import { OWNER_URL } from './support.ts';

export default async function setup(): Promise<void> {
  const owner = new pg.Pool({ connectionString: OWNER_URL });
  try {
    await owner.query('SELECT 1');
  } catch (e) {
    await owner.end();
    throw new Error(`Test database not reachable on 127.0.0.1:55432. Start it with: docker compose up -d db-test (${String(e)})`);
  }
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await runMigrations(drizzle(owner));
  await owner.query('ALTER ROLE wdb_app LOGIN');
  await owner.end();
}
