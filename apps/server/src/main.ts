// `pnpm --filter @wdb/server start`. TLS is terminated by Caddy in front (SEC-1); this listens on the internal network.
import { buildApp } from './app.ts';
import { createDb } from './db.ts';

const { DATABASE_URL, WDB_ORIGIN, HOST = '127.0.0.1', PORT = '3000' } = process.env;
if (!DATABASE_URL || !WDB_ORIGIN) throw new Error('DATABASE_URL and WDB_ORIGIN are required');

const { db } = createDb(DATABASE_URL);
const app = buildApp(db, { origin: WDB_ORIGIN, ward: process.env.WDB_WARD_NAME ?? null });
await app.listen({ host: HOST, port: Number(PORT) });
console.log(`ward server listening on ${HOST}:${PORT}`);
