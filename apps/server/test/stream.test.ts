// SSE live push (design.md §5.6): resume by Last-Event-ID, live entries, one stream per device.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, admitOn, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie, type TestDevice } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
let base: string;
let d: TestDevice;
let cookie: string;

afterAll(async () => {
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  await addStaff(pool, 'S-0001', 'clerk');
  d = await addDevice(pool);
  cookie = await sessionCookie(pool, 'S-0001', d.deviceId);
  app = buildApp(db, { origin: ORIGIN, streamBacklog: 3 });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await app.close();
});

const push = (n: number) =>
  app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...CSRF, cookie }, payload: { deviceId: d.deviceId, events: Array.from({ length: n }, (_, i) => admitOn(d, i + 1)) } });

interface Msg {
  id?: string;
  event?: string;
  data?: string;
}

/** Opens the stream and collects SSE messages until `done` says stop (or 5 s pass). */
async function collect(headers: Record<string, string>, done: (m: Msg[]) => boolean, during?: () => Promise<unknown>) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  const res = await fetch(`${base}/api/v1/stream`, { headers, signal: ac.signal });
  const msgs: Msg[] = [];
  if (!res.body) return { res, msgs };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let started = false;
  try {
    while (!done(msgs)) {
      if (!started && during) {
        started = true;
        void during();
      }
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m: Msg = {};
        for (const line of block.split('\n')) {
          const [k, ...v] = line.split(': ');
          if (k === 'id' || k === 'event' || k === 'data') m[k] = v.join(': ');
        }
        if (m.event) msgs.push(m);
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { res, msgs };
}

describe('GET /api/v1/stream', () => {
  it('needs a session', async () => {
    const r = await fetch(`${base}/api/v1/stream`);
    expect(r.status).toBe(401);
  });

  it('replays entries after Last-Event-ID, then pushes new ones live', async () => {
    await push(2);
    const { res, msgs } = await collect(
      { cookie, 'last-event-id': '1' },
      (m) => m.length >= 2,
      () => push(1),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(msgs.map((m) => [m.event, m.id])).toEqual([
      ['appended', '2'],
      ['appended', '3'],
    ]);
    expect(JSON.parse(msgs[1]?.data ?? '{}')).toMatchObject({ serverSeq: 3, event: { deviceId: d.deviceId } });
  });

  it('asks the device to pull instead when the backlog is too long', async () => {
    await push(5); // backlog limit is 3 in this test
    const { msgs } = await collect({ cookie, 'last-event-id': '0' }, (m) => m.length >= 1);
    expect(msgs[0]?.event).toBe('resync');
  });

  it('keeps one stream per device: a new one closes the old', async () => {
    const ac = new AbortController();
    const first = await fetch(`${base}/api/v1/stream`, { headers: { cookie }, signal: ac.signal });
    const reader = first.body?.getReader();
    await collect({ cookie }, () => true);
    let text = '';
    for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) text += new TextDecoder().decode(r.value);
    expect(text).toBe(': open\n\n'); // the old stream ended after its opening comment
    ac.abort();
  });
});
