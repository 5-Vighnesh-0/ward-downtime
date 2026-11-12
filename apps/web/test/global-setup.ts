// The web tests run the real server against their own database, so they never race the server's own tests.
import { createDb } from '@wdb/server/src/db.ts';
import { runMigrations } from '@wdb/server/src/migrate.ts';
import { ADMIN_URL, OWNER_URL } from './support.ts';

export default async function setup(): Promise<void> {
  const { pool: admin } = createDb(ADMIN_URL);
  try {
    await admin.query('DROP DATABASE IF EXISTS wdb_web_test WITH (FORCE)');
    await admin.query('CREATE DATABASE wdb_web_test');
  } catch (e) {
    throw new Error(`Test database not reachable on 127.0.0.1:55432. Start it with: docker compose up -d db-test (${String(e)})`);
  } finally {
    await admin.end();
  }
  const owner = createDb(OWNER_URL);
  await runMigrations(owner.db);
  await owner.pool.query('ALTER ROLE wdb_app LOGIN');
  await owner.pool.end();
}
