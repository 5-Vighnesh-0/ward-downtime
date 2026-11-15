// SIM-01 and SIM-02 (design.md §12.2): seeded simulations of real tablets (sync engine + fake-indexeddb) against
// the real ward server and Postgres. FR-4, FR-5, NFR-Convergence, NFR-Durability.
// The seed picks every operation, partition and crash. Network timing is real, so two runs with one seed make the
// same choices but may interleave differently on the server; the assertions hold for any interleaving.
// WDB_SIM_SEED picks the seed (printed in the test name), WDB_SIM_OPS the SIM-01 operation count. `pnpm test` runs 1,000
// (about a minute for both); the nightly job runs the design's 10,000 with a random seed (about 5 minutes).
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '@wdb/server/src/app.ts';
import { createDb } from '@wdb/server/src/db.ts';
import { canonicalize, emptyBoard, replay, type AnyEvent, type Board, type Role } from '@wdb/shared';
import { readEntries } from '@wdb/server/src/entries.ts';
import { verifyChain } from '@wdb/server/src/verify-chain.ts';
import { checkInvariants } from '../../../packages/shared/test/helpers.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import type { OutboxItem } from '../src/sync/db.ts';
import { APP_URL, OWNER_URL, startWard, tablet, type Tablet, type Ward } from './support.ts';

const SEED = Number(process.env.WDB_SIM_SEED ?? 1);
const OPS = Number(process.env.WDB_SIM_OPS ?? 1000);

/** mulberry32: a small seeded PRNG, enough to drive choices (not for crypto). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

let ward: Ward;
const open: Tablet[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) t.engine.stop();
  await ward?.close();
});

/** Enrolment is limited to 10 per hour per address, so tablets past the tenth enrol through a second server on the same database. */
async function tablets(roles: Role[]): Promise<Tablet[]> {
  const out: Tablet[] = [];
  let extra: Ward | undefined;
  for (const [i, role] of roles.entries()) {
    if (i === 10) {
      const db = createDb(APP_URL);
      const owner = createDb(OWNER_URL);
      const app = buildApp(db.db, { origin: 'https://wdb.test' });
      await app.listen({ host: '127.0.0.1', port: 0 });
      extra = { app, owner, baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, close: async () => (await app.close(), await db.pool.end(), await owner.pool.end()) };
    }
    const t = await tablet(extra ?? ward, role);
    t.net.baseUrl = ward.baseUrl; // the session lives in the database, so it works on the ward server too
    out.push(t);
    open.push(t);
  }
  await extra?.close();
  return out;
}

/** Where two boards differ, entry by entry. Vitest's own diff of two 10,000-entry boards runs for many minutes. */
function differences(a: Board, b: Board): string[] {
  const show = (v: unknown) => (v === undefined ? 'missing' : canonicalize(v));
  const out: string[] = [];
  for (const k of Object.keys({ ...a, ...b }) as (keyof Board)[]) {
    const x = a[k] ?? {};
    const y = b[k] ?? {};
    if (typeof x !== 'object' || typeof y !== 'object') {
      if (x !== y) out.push(`${k}: ${show(x)} vs ${show(y)}`);
      continue;
    }
    const xs = x as Record<string, unknown>;
    const ys = y as Record<string, unknown>;
    for (const id of Object.keys({ ...xs, ...ys })) if (show(xs[id]) !== show(ys[id])) out.push(`${k}.${id}: ${show(xs[id])} vs ${show(ys[id])}`);
  }
  return out.slice(0, 5);
}

const sorted = <T>(r: Record<string, T>) => Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1));
const bedsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ bedId: `B${String(i + 1).padStart(2, '0')}`, label: `Bed ${i + 1}` }));

/** One change the UI would allow on this tablet's current view, or nothing. */
function change(t: Tablet, role: Role, r: () => number): Promise<OutboxItem> | undefined {
  const v = t.engine.state.view;
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
  const empty = sorted(v.beds).filter(([, b]) => b.status === 'empty').map(([k]) => k);
  const placed = sorted(v.patients).flatMap(([id, p]) => (p.where.kind === 'bed' ? [{ id, bedId: p.where.bedId }] : []));
  const unplaced = sorted(v.patients).filter(([, p]) => p.where.kind === 'unplaced').map(([k]) => k);
  const n = Math.floor(r() * 10);
  if (role === 'admin' && n === 0) return t.engine.record('WARD_CONFIGURED', { beds: bedsOf(6 + Math.floor(r() * 7)) });
  if ((role === 'charge' || role === 'admin') && n <= 3) {
    const c = pick(sorted(v.conflicts).filter(([, x]) => x.status === 'open'));
    if (c) {
      const ids = c[1].candidates.map((x) => x.eventId);
      return t.engine.record('RESOLVE_CONFLICT', { conflictId: c[0], keep: pick([...ids, 'NONE']) ?? 'NONE', candidatesSeen: ids });
    }
  }
  const bed = pick(empty);
  const p = pick(placed);
  switch (n) {
    case 0:
    case 1:
    case 2: {
      if (!bed) return undefined;
      const again = r() < 0.3 ? pick(unplaced) : undefined;
      return t.engine.admit({ label: `Patient ${Math.floor(r() * 1000)}`, bedId: bed, ...(again ? { patientId: again } : {}) });
    }
    case 3:
    case 4:
      return p ? t.engine.record('DISCHARGE', { patientId: p.id, bedId: p.bedId }) : undefined;
    case 5:
      return p && bed ? t.engine.record('TRANSFER', { patientId: p.id, fromBedId: p.bedId, toBedId: bed }) : undefined;
    case 6:
      return p ? t.engine.record('RENAME', { patientId: p.id, label: `Patient ${Math.floor(r() * 1000)}` }) : undefined;
    case 7: {
      const b = pick(Object.keys(v.beds).sort());
      return b ? t.engine.record('TASK_CREATED', { bedId: b, title: 'Check obs' }) : undefined;
    }
    case 8: {
      const task = pick(sorted(v.tasks).map(([k]) => k)); // done or not: double completions must converge too
      return task ? t.engine.record('TASK_COMPLETED', { taskId: task }) : undefined;
    }
    default: {
      const b = pick(Object.keys(v.beds).sort());
      return b && role !== 'clerk' ? t.engine.record('HANDOFF_NOTE_ADDED', { bedId: b, text: 'Settled overnight' }) : undefined;
    }
  }
}

async function serverEntries() {
  const all = [];
  for (let after = 0; ; ) {
    const page = await readEntries(ward.owner.db, after, 1000);
    if (!page.length) return all;
    all.push(...page);
    after = page.at(-1)?.serverSeq ?? after;
  }
}

/** Every tablet back on the network: send everything and pull to the head (retries cover 429s and backoff). */
async function heal(ts: Tablet[]): Promise<number> {
  for (const t of ts) Object.assign(t.net, { offline: false, blockPush: false });
  const end = Date.now() + 120_000;
  for (;;) {
    await Promise.all(ts.map((t) => t.engine.push()));
    await Promise.all(ts.map((t) => t.engine.pull()));
    const head = (await ward.owner.pool.query('SELECT last_seq FROM log_head')).rows[0].last_seq as number;
    if (ts.every((t) => t.engine.state.outbox.length === 0 && t.engine.state.confirmed.atSeq === Number(head))) return Number(head);
    if (Date.now() > end) {
      const stuck = ts.map((t, i) => ({ i, at: t.engine.state.confirmed.atSeq, alert: t.engine.state.alert, outbox: t.engine.state.outbox.map((o) => `${o.state}:${o.code ?? ''}`) }));
      throw new Error(`tablets did not converge after healing (head ${head}): ${JSON.stringify(stuck.filter((x) => x.at !== Number(head) || x.outbox.length))}`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

describe(`SIM-01: random partitions across 20 tablets (seed ${SEED})`, () => {
  it(`${OPS} operations, then heal: every tablet holds the board a full replay of the server log gives`, { timeout: 900_000 }, async () => {
    const r = rng(SEED);
    ward = await startWard();
    const roles: Role[] = ['admin', 'charge', 'charge', ...Array<Role>(15).fill('nurse'), 'clerk', 'clerk'];
    const ts = await tablets(roles);
    await ts[0]?.engine.record('WARD_CONFIGURED', { beds: bedsOf(10) });
    await heal(ts);

    const made = new Set<string>();
    const ROUND = 400; // pushes and pulls happen between rounds, which keeps every tablet under the server's rate limits
    for (let done = 0; done < OPS; ) {
      // A new partition each round: a random share of tablets loses the network. The rest queue changes and send
      // them together at the end of the round, so their pushes race on the server.
      const cut = r() * 0.7;
      for (const t of ts) Object.assign(t.net, { offline: r() < cut, blockPush: true });
      for (let i = 0; i < ROUND && done < OPS; i++, done++) {
        const d = Math.floor(r() * ts.length);
        const t = ts[d] as Tablet;
        const item = await change(t, roles[d] as Role, r);
        if (item) made.add(item.eventId);
      }
      const online = ts.filter((t) => !t.net.offline);
      for (const t of online) t.net.blockPush = false;
      await Promise.all(online.map((t) => t.engine.push()));
      await Promise.all(online.map((t) => t.engine.pull()));
    }
    const head = await heal(ts);

    const log = await serverEntries();
    expect(log).toHaveLength(head);
    const full: Board = replay(log, emptyBoard());
    for (const t of ts) {
      expect(t.engine.state.alert).toBeNull();
      expect(differences(t.engine.state.confirmed, full)).toEqual([]);
    }
    // Zero silent losses: every change any tablet made is in the log exactly once, and each has an outcome.
    const ids = log.map((e) => e.event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of made) expect(full.outcomes[id]).toBeDefined();
    expect(log.length).toBe(made.size + 1); // + the first WARD_CONFIGURED
    // PB-03 after every entry, and the hash chain checks out.
    let b = emptyBoard();
    let widest = 0;
    for (const entry of log) {
      b = replay([entry], b);
      const errs = checkInvariants(b);
      if (errs.length) throw new Error(`seq ${entry.serverSeq}: ${errs.join('; ')}`);
      for (const c of Object.values(b.conflicts)) widest = Math.max(widest, c.candidates.length);
    }
    expect(widest).toBeLessThanOrEqual(50); // RESOLVE_CONFLICT takes up to 50 candidatesSeen
    expect(await verifyChain(ward.owner.db)).toMatchObject({ ok: true, headSeq: head });
    // The run really produced concurrency.
    expect(Object.keys(full.conflicts).length).toBeGreaterThan(0);
    expect(Object.values(full.conflicts).some((c) => c.status !== 'open')).toBe(true);
  });
});

describe(`SIM-02: tablet crashes between signing and the outbox write (seed ${SEED})`, () => {
  it('a crash skips a deviceSeq and temp ID but never reuses them; changes that were saved survive and send once', { timeout: 300_000 }, async () => {
    const r = rng(SEED);
    ward = await startWard();
    const [admin, t] = await tablets(['admin', 'nurse']);
    if (!admin || !t) throw new Error('no tablets');
    await admin.engine.record('WARD_CONFIGURED', { beds: bedsOf(6) });
    await heal([admin]);
    await t.engine.pull();

    // The crash point: the event is signed, then the process dies before the outbox row is written.
    const put = t.db.outbox.put.bind(t.db.outbox);
    let crashNext = false;
    const lost: AnyEvent[] = [];
    t.db.outbox.put = ((item: OutboxItem) => {
      if (!crashNext || t.engine.state.outbox.some((i) => i.eventId === item.eventId)) return put(item); // state updates of saved rows
      crashNext = false;
      lost.push(item.event);
      return Promise.reject(new Error('simulated crash'));
    }) as typeof t.db.outbox.put;
    const restart = async () => {
      t.engine.stop(); // memory is gone; IndexedDB stays
      t.engine = await SyncEngine.open(t.db, t.net);
    };

    const saved: AnyEvent[] = [];
    let restartsAfterSave = 0;
    for (let i = 0; i < 200; i++) {
      t.net.offline = r() < 0.4;
      crashNext = r() < 0.2;
      const v = t.engine.state.view;
      const empty = sorted(v.beds).find(([, b]) => b.status === 'empty')?.[0];
      const occupied = sorted(v.beds).flatMap(([bedId, b]) => (b.status === 'occupied' ? [{ bedId, patientId: b.occupant }] : []));
      const p = occupied[Math.floor(r() * occupied.length)];
      const op = empty && (r() < 0.6 || !p) ? t.engine.admit({ label: `Patient ${i}`, bedId: empty }) : p ? t.engine.record('DISCHARGE', p) : undefined;
      if (!op) continue;
      const crashing = crashNext;
      try {
        saved.push((await op).event);
        expect(crashing).toBe(false);
      } catch (e) {
        expect(crashing).toBe(true);
        expect(String(e)).toContain('simulated crash');
        await restart();
        continue;
      }
      // Also crash after a save, before the push gets through: the change must come back from IndexedDB.
      if (t.net.offline && r() < 0.3) {
        await restart();
        restartsAfterSave++;
      }
      if (r() < 0.2) {
        t.net.offline = false;
        await t.engine.push();
      }
    }
    await heal([t]);

    expect(lost.length).toBeGreaterThan(10);
    expect(restartsAfterSave).toBeGreaterThan(5);
    expect(t.engine.state.alert).toBeNull(); // never STORAGE_LOST: no DEVICE_SEQ_REGRESSION from the server
    const mine = (await serverEntries()).map((e) => e.event).filter((e) => e.deviceId === t.engine.device.deviceId);
    // Saved changes reach the server once each, in deviceSeq order; lost ones never do.
    expect(mine.map((e) => e.eventId)).toEqual(saved.map((e) => e.eventId));
    const seqs = mine.map((e) => e.deviceSeq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    // Each attempt used its own deviceSeq and temp ID: the lost ones are gaps, never handed out again.
    const lostSeqs = new Set(lost.map((e) => e.deviceSeq));
    expect(seqs.filter((s) => lostSeqs.has(s))).toEqual([]);
    expect(Math.max(...seqs, ...lostSeqs)).toBe(saved.length + lost.length);
    const tempIds = (es: AnyEvent[]) => es.flatMap((e) => (e.type === 'ADMIT' ? [e.payload.patientId] : []));
    const lostIds = new Set(tempIds(lost));
    expect(tempIds(mine).filter((id) => lostIds.has(id))).toEqual([]);
  });
});
