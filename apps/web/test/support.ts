// Real ward server on a random port, plus tablets made of a Dexie database (fake-indexeddb) and a sync engine.
import type { AddressInfo } from 'node:net';
import { addStaffMember, approveDevice } from '@wdb/server/src/admin.ts';
import { buildApp } from '@wdb/server/src/app.ts';
import { createDb } from '@wdb/server/src/db.ts';
import type { Role } from '@wdb/shared';
import { openDb, type WdbDb } from '../src/sync/db.ts';
import { enroll, enrollmentStatus, signIn, type Net } from '../src/sync/device.ts';
import { SyncEngine } from '../src/sync/engine.ts';

// Throwaway test database from compose.yaml (trust auth, localhost only).
export const ADMIN_URL = 'postgres://wdb_owner@127.0.0.1:55432/wdb_test';
export const OWNER_URL = 'postgres://wdb_owner@127.0.0.1:55432/wdb_web_test';
export const APP_URL = 'postgres://wdb_app@127.0.0.1:55432/wdb_web_test';
export const PIN = '482913';

export interface Ward {
  app: ReturnType<typeof buildApp>;
  baseUrl: string;
  owner: ReturnType<typeof createDb>;
  close: () => Promise<void>;
}

export async function startWard(opts: { streamBacklog?: number } = {}): Promise<Ward> {
  const owner = createDb(OWNER_URL);
  await owner.pool.query(`TRUNCATE events, audit_log, sessions, devices, staff RESTART IDENTITY CASCADE`);
  await owner.pool.query(`UPDATE log_head SET last_seq = 0, last_hash = decode(repeat('00', 32), 'hex')`);
  const appDb = createDb(APP_URL);
  const app = buildApp(appDb.db, { origin: 'https://wdb.test', streamPingMs: 1000, ...opts });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    app,
    baseUrl,
    owner,
    close: async () => {
      await app.close();
      await appDb.pool.end();
      await owner.pool.end();
    },
  };
}

/** A tablet's network: keeps its own session cookie (as a browser would), and can be cut off. */
export interface TestNet extends Net {
  offline: boolean;
  blockPush: boolean; // pushes fail but pulls work
  loseReplies: boolean; // the server gets the request but the reply is lost (FR-4 retry safety)
  proxyDown: boolean; // a reverse proxy answers 502 because the ward server is down
}

function testNet(baseUrl: string): TestNet {
  let cookie = '';
  const net: TestNet = {
    baseUrl,
    now: () => Date.now(),
    offline: false,
    blockPush: false,
    loseReplies: false,
    proxyDown: false,
    fetch: async (input, init = {}) => {
      if (net.proxyDown) return new Response('Bad Gateway', { status: 502 });
      const isPush = init.method === 'POST' && String(input).endsWith('/api/v1/events');
      if (net.offline || (isPush && net.blockPush)) throw new TypeError('fetch failed');
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      const res = await fetch(input, { ...init, headers });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0] ?? '';
      if (isPush && net.loseReplies) throw new TypeError('fetch failed');
      return res;
    },
  };
  return net;
}

export interface Tablet {
  db: WdbDb;
  net: TestNet;
  engine: SyncEngine;
}

let tablets = 0;
let staffSeq = 0;

/** Enroll → admin approves → staff signs in → engine opened (design.md §9.2, §9.4.1). */
export async function tablet(ward: Ward, role: Role = 'nurse'): Promise<Tablet> {
  const db = openDb(`wdb-test-${++tablets}`);
  const net = testNet(ward.baseUrl);
  await enroll(db, net, `Tablet ${tablets}`);
  const meta = await db.meta.get('device');
  await approveDevice(ward.owner.db, meta?.deviceId ?? '');
  await enrollmentStatus(db, net);
  const staffId = `S-${String(++staffSeq).padStart(4, '0')}`;
  await addStaffMember(ward.owner.db, { staffId, role, displayName: `Test ${staffId}`, pin: PIN });
  await signIn(db, net, staffId, PIN);
  return { db, net, engine: await SyncEngine.open(db, net) };
}

export const BEDS = Array.from({ length: 4 }, (_, i) => ({ bedId: `B0${i + 1}`, label: `Bed ${i + 1}` }));

/** Waits until `check` passes (for SSE delivery). */
export async function eventually(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const serverLog = async (ward: Ward) =>
  (await ward.owner.pool.query('SELECT server_seq, event_id FROM events ORDER BY server_seq')).rows as { server_seq: number; event_id: string }[];
