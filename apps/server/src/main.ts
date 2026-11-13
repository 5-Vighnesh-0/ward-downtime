// `pnpm --filter @wdb/server start`. TLS is terminated by Caddy in front (SEC-1); this listens on the internal network.
import { buildApp } from './app.ts';
import { createDb } from './db.ts';

const { DATABASE_URL, WDB_ORIGIN, HOST = '127.0.0.1', PORT = '3000' } = process.env;
if (!DATABASE_URL || !WDB_ORIGIN) throw new Error('DATABASE_URL and WDB_ORIGIN are required');

const { db, pool } = createDb(DATABASE_URL);
const app = buildApp(db, { origin: WDB_ORIGIN, ward: process.env.WDB_WARD_NAME ?? null, log: { level: process.env.LOG_LEVEL ?? 'info' }, proxyHops: Number(process.env.WDB_PROXY_HOPS ?? 0) });
const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await app.listen({ host: HOST, port: Number(PORT) });
// SEC-10: check the whole hash chain now and every hour; a failure raises CHAIN_BREAK.
const verify = () => app.checkChain().catch((e) => app.log.error({ event: 'chain_verify', error: String(e) }));
void verify();
setInterval(verify, 60 * 60_000).unref();
console.log(`ward server listening on ${HOST}:${PORT}`); // the E2E harness waits for this line
