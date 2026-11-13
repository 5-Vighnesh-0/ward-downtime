// Device sync engine against the real ward server (design.md §5; FR-1, FR-2, FR-4, FR-5, FR-10, SEC-8, SEC-9, SEC-10).
// Also SEC-T-WIPE and SEC-T-REVOKE (client wipe), SEC-T-TAMPER (CHAIN_FORK on the device), SIM-04 (replay after restore).
import { afterEach, describe, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { revokeDevice } from '@wdb/server/src/admin.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { BEDS, eventually, serverLog, startWard, tablet, type Tablet, type Ward } from './support.ts';

let ward: Ward;
const open: Tablet[] = [];

async function setup(opts: { streamBacklog?: number } = {}) {
  ward = await startWard(opts);
  const admin = await tablet(ward, 'admin');
  open.push(admin);
  await admin.engine.record('WARD_CONFIGURED', { beds: BEDS });
  await admin.engine.push();
  return admin;
}
async function another(role: 'nurse' | 'clerk' | 'charge' = 'nurse') {
  const t = await tablet(ward, role);
  open.push(t);
  await t.engine.pull();
  return t;
}

afterEach(async () => {
  for (const t of open.splice(0)) t.engine.stop();
  await ward?.close();
});

describe('local write path and push (§5.1, §5.3)', () => {
  it('admits with a temp ID, shows it at once, then confirms it on the server', async () => {
    await setup();
    const t = await another();
    const item = await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    const prefix = (await t.db.meta.get('device'))?.tempPrefix;
    expect(item.event.payload).toMatchObject({ patientId: `T-${prefix}-0001`, bedId: 'B01' });
    expect(t.engine.state.view.beds.B01).toMatchObject({ status: 'occupied', occupant: `T-${prefix}-0001` });
    await t.engine.push();
    expect(t.engine.state.confirmed.beds.B01).toMatchObject({ status: 'occupied' });
    expect(t.engine.state.outbox).toEqual([]);
    expect(t.engine.state.unsynced).toBe(0);
    expect((await serverLog(ward)).map((r) => r.event_id)).toContain(item.eventId);
  });

  it('keeps working offline, counts unsynced changes, and sends them in order when back (FR-2)', async () => {
    await setup();
    const t = await another();
    t.net.offline = true;
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.admit({ label: 'Mira Holt', bedId: 'B02' });
    await t.engine.push();
    expect(t.engine.state.online).toBe(false);
    expect(t.engine.state.unsynced).toBe(2);
    expect(t.engine.state.view.beds.B02).toMatchObject({ status: 'occupied' });
    expect(t.engine.state.confirmed.beds.B02).toMatchObject({ status: 'empty' });
    t.net.offline = false;
    await t.engine.push();
    expect(t.engine.state.unsynced).toBe(0);
    expect(t.engine.state.confirmed.beds.B02).toMatchObject({ status: 'occupied' });
    const seqs = (await t.db.events.toArray()).map((e) => e.event.deviceSeq).filter((_, i) => i > 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('a 502 from a proxy in front of a stopped server counts as offline', async () => {
    await setup();
    const t = await another();
    await t.engine.pull();
    expect(t.engine.state.online).toBe(true);
    t.net.proxyDown = true;
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.push();
    expect(t.engine.state.online).toBe(false);
    expect(t.engine.state.unsynced).toBe(1);
    t.net.proxyDown = false;
    await t.engine.pull(); // a poll that gets through sends the queue at once
    await t.engine.push(); // waits for that push and its follow-up pull, so nothing is in flight when the test ends
    expect(t.engine.state.outbox).toEqual([]);
  });

  it('a lost reply and three retries still give one log entry (FR-4, acceptance 3)', async () => {
    await setup();
    const t = await another();
    t.net.loseReplies = true;
    const item = await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    for (let i = 0; i < 3; i++) await t.engine.push();
    t.net.loseReplies = false;
    await t.engine.push();
    expect((await serverLog(ward)).filter((r) => r.event_id === item.eventId)).toHaveLength(1);
    expect(t.engine.state.unsynced).toBe(0);
  });

  it('a refused event is kept as Failed and does not block later events (§5.3, ADR-006)', async () => {
    await setup();
    const t = await another('nurse');
    await t.engine.record('WARD_CONFIGURED', { beds: BEDS }); // admin only
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.push();
    expect(t.engine.state.outbox).toEqual([expect.objectContaining({ state: 'refused', code: 'ROLE_FORBIDDEN' })]);
    expect(t.engine.state.unsynced).toBe(1);
    expect(t.engine.state.confirmed.beds.B01).toMatchObject({ status: 'occupied' });
  });

  it('re-admits an unplaced patient under the same ID without using a new temp ID (E13)', async () => {
    await setup();
    const t = await another('charge');
    t.net.blockPush = true;
    const first = await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    const other = await another();
    await other.engine.admit({ label: 'Mira Holt', bedId: 'B01' });
    await other.engine.push();
    t.net.blockPush = false;
    await t.engine.push();
    const conflictId = Object.keys(t.engine.state.confirmed.conflicts)[0] ?? '';
    const seen = t.engine.state.confirmed.conflicts[conflictId]?.candidates.map((c) => c.eventId) ?? [];
    const keep = seen.find((id) => id !== first.eventId) ?? '';
    expect((await t.engine.eventsById(seen)).size).toBe(2);
    await t.engine.record('RESOLVE_CONFLICT', { conflictId, keep, candidatesSeen: seen });
    await t.engine.push();
    const { patientId } = first.event.payload as { patientId: string };
    expect(t.engine.state.confirmed.patients[patientId]?.where).toEqual({ kind: 'unplaced' });
    await t.engine.admit({ patientId, label: 'Rowan Ashby', bedId: 'B02' });
    await t.engine.push();
    expect(t.engine.state.confirmed.beds.B02).toMatchObject({ status: 'occupied', occupant: patientId });
    expect(t.engine.device.nextPatientId.endsWith('-0002')).toBe(true); // the re-admit did not use a temp ID
  });

  it('refuses input the schema would reject before signing it', async () => {
    await setup();
    const t = await another();
    await expect(t.engine.admit({ label: 'x'.repeat(41), bedId: 'B01' })).rejects.toThrow(/invalid ADMIT/);
    expect(t.engine.state.outbox).toEqual([]);
  });
});

describe('two tablets (§6.6, FR-5, NFR-Convergence)', () => {
  it('a pending admit into a bed that was taken meanwhile is held back, then becomes a confirmed conflict on both', async () => {
    await setup();
    const a = await another();
    const b = await another();
    b.net.blockPush = true;
    const mine = await b.engine.admit({ label: 'Mira Holt', bedId: 'B01' });
    await a.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await a.engine.push();
    await b.engine.pull();
    // No phantom conflict: B sees A's confirmed patient and its own change as blocked.
    expect(b.engine.state.view.beds.B01).toMatchObject({ status: 'occupied' });
    expect(b.engine.state.blocked).toEqual([mine.eventId]);
    b.net.blockPush = false;
    await b.engine.push();
    await a.engine.pull();
    expect(b.engine.state.confirmed.beds.B01).toMatchObject({ status: 'conflict' });
    expect(a.engine.state.confirmed).toEqual(b.engine.state.confirmed);
  });
});

describe('pull, chain check and live stream (§5.6, §9.6)', () => {
  it('refuses an entry that does not extend the local chain (CHAIN_FORK)', async () => {
    await setup();
    const t = await another();
    const [last] = await t.db.events.orderBy('serverSeq').reverse().limit(1).toArray();
    if (!last) throw new Error('no entries');
    const forged = { ...last, serverSeq: last.serverSeq + 1, prevHash: '1'.repeat(64) };
    expect(await t.engine.apply([forged])).toBe('fork');
    expect(t.engine.state.alert).toBe('CHAIN_FORK');
    expect(await t.engine.apply([{ ...last, serverSeq: last.serverSeq + 1, prevHash: last.hash }])).toBe('fork'); // refused from now on
  });

  it('refuses an entry whose hash does not match its content', async () => {
    await setup();
    const a = await another();
    const b = await another();
    await a.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await a.engine.push();
    const [entry] = await a.db.events.orderBy('serverSeq').reverse().limit(1).toArray();
    if (!entry || entry.event.type !== 'ADMIT') throw new Error('no admit');
    const tampered = { ...entry, event: { ...entry.event, payload: { ...entry.event.payload, bedId: 'B02' } } };
    expect(await b.engine.apply([tampered])).toBe('fork');
  });

  it('receives other tablets’ changes over SSE without pulling', async () => {
    await setup();
    const a = await another();
    const b = await another();
    void a.engine.connect();
    await b.engine.admit({ label: 'Rowan Ashby', bedId: 'B03' });
    await b.engine.push();
    await eventually(() => a.engine.state.confirmed.beds.B03?.status === 'occupied');
  });

  it('after an outage that switched to polling, the network coming back reopens the live stream at once', async () => {
    await setup();
    const a = await another();
    const b = await another();
    a.engine.stop();
    const live = await SyncEngine.open(a.db, a.net, () => 0); // no backoff, so 3 failures arrive at once
    open.push({ ...a, engine: live });
    a.net.offline = true;
    void live.connect();
    await new Promise((r) => setTimeout(r, 200)); // 3 failed connects → polling every 15 s
    a.net.offline = false;
    live.retryStream(); // what the browser's `online` event does
    await b.engine.admit({ label: 'Rowan Ashby', bedId: 'B03' });
    await b.engine.push();
    await eventually(() => live.state.confirmed.beds.B03?.status === 'occupied', 3000); // well before the next poll
  });

  it('pulls instead when it missed more than the stream backlog (resync)', async () => {
    await setup({ streamBacklog: 2 });
    const a = await tablet(ward);
    open.push(a);
    const b = await another();
    for (const bedId of ['B01', 'B02', 'B03']) await b.engine.admit({ label: 'Test Patient', bedId });
    await b.engine.push();
    a.engine.stop();
    // Longest backoff, so only the resync path (not the polling fallback after 3 failures) can catch up in time.
    const slow = await SyncEngine.open(a.db, a.net, () => 1);
    open.push({ ...a, engine: slow });
    void slow.connect();
    await eventually(() => slow.state.confirmed.beds.B03?.status === 'occupied', 1500);
  });

  it('cold start rebuilds the same board and outbox from IndexedDB', async () => {
    await setup();
    const t = await another();
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.push();
    t.net.offline = true;
    await t.engine.admit({ label: 'Mira Holt', bedId: 'B02' });
    await t.engine.push();
    t.engine.stop();
    const again = await SyncEngine.open(t.db, t.net);
    expect(again.state.confirmed).toEqual(t.engine.state.confirmed);
    expect(again.state.view).toEqual(t.engine.state.view);
    expect(again.state.unsynced).toBe(1);
  });

  it('writes a snapshot every 500 entries and starts from it', async () => {
    await setup();
    const t = await another();
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    const patientId = t.engine.state.outbox[0]?.event.payload;
    if (!patientId || !('patientId' in patientId)) throw new Error('no patient');
    for (let i = 0; i < 500; i++) await t.engine.record('RENAME', { patientId: patientId.patientId, label: `Name ${i}` });
    await t.engine.push();
    const snap = await t.db.snapshot.get('board');
    expect(snap?.atSeq).toBeGreaterThanOrEqual(500);
    const again = await SyncEngine.open(t.db, t.net);
    expect(again.state.confirmed).toEqual(t.engine.state.confirmed);
  }, 30_000);
});

describe('server restored from an old backup (design.md §11.4)', () => {
  it('tablets stop pushing, an admin tablet replays the lost entries, then everything converges', async () => {
    const admin = await setup();
    const t = await another();
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.admit({ label: 'Mira Holt', bedId: 'B02' });
    await t.engine.push();
    await admin.engine.pull();
    const head = (await t.db.meta.get('device'))?.headHash;
    // The server loses everything after the ward setup (entry 1), as a restore from an old backup would.
    await ward.owner.pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only');
    await ward.owner.pool.query('DELETE FROM events WHERE server_seq > 1');
    await ward.owner.pool.query('ALTER TABLE events ENABLE TRIGGER events_append_only');
    await ward.owner.pool.query('UPDATE log_head SET last_seq = 1, last_hash = (SELECT hash FROM events WHERE server_seq = 1)');

    await t.engine.pull(); // a plain pull already notices, before anything is pushed
    expect(t.engine.state.alert).toBe('SERVER_BEHIND');
    await t.engine.admit({ label: 'Ola Brandt', bedId: 'B03' }); // made during the outage
    await t.engine.push();
    expect(t.engine.state.alert).toBe('SERVER_BEHIND');
    expect(t.engine.state.unsynced).toBe(1);
    expect((await serverLog(ward)).length).toBe(1); // nothing pushed onto the restored log

    expect(await admin.engine.replayToServer()).toBe(2);
    expect(admin.engine.state.alert).toBe(null);
    await t.engine.pull();
    expect(t.engine.state.alert).toBe(null);
    await t.engine.push();
    expect(t.engine.state.unsynced).toBe(0);
    expect((await serverLog(ward)).length).toBe(4);
    expect(t.engine.state.confirmed.beds.B03).toMatchObject({ status: 'occupied' });
    const [first] = await ward.owner.pool.query('SELECT encode(hash, \'hex\') AS h FROM events WHERE server_seq = 3').then((r) => r.rows);
    expect(first.h).toBe(head); // the replayed entries are the original ones, hashes and all
  });
});

describe('session and device lifecycle (SEC-8, SEC-14)', () => {
  it('a revoked tablet deletes its local database on next contact', async () => {
    await setup();
    const t = await another();
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.push();
    const meta = await t.db.meta.get('device');
    await revokeDevice(ward.owner.db, meta?.deviceId ?? '');
    await t.engine.admit({ label: 'Mira Holt', bedId: 'B02' });
    await t.engine.push();
    expect(t.engine.state.alert).toBe('DEVICE_REVOKED');
    expect(await Dexie.exists(t.db.name)).toBe(false);
    await expect(t.engine.admit({ label: 'Mira Holt', bedId: 'B03' })).rejects.toThrow();
  });

  it('drops offline sign-in for staff disabled on the server (§9.2.3)', async () => {
    const admin = await setup();
    const t = await another();
    const gone = (await admin.db.session.get('current'))?.staffId ?? '';
    const kept = (await t.db.session.get('current'))?.staffId ?? '';
    await t.db.creds.bulkPut([gone, kept].map((staffId) => ({ staffId, role: 'nurse' as const, exp: '2099-01-01T00:00:00.000Z', salt: '', hash: '', iterations: 1, failCount: 0 })));
    await ward.owner.pool.query('UPDATE staff SET status = $2 WHERE staff_id = $1', [gone, 'disabled']);
    await t.engine.pull();
    expect((await t.db.creds.toArray()).map((c) => c.staffId)).toEqual([kept]);
  });

  it('an ended session keeps the outbox and asks for sign-in', async () => {
    await setup();
    const t = await another();
    await ward.owner.pool.query('UPDATE sessions SET revoked_at = now()');
    await t.engine.admit({ label: 'Rowan Ashby', bedId: 'B01' });
    await t.engine.push();
    expect(t.engine.state.alert).toBe('SIGNED_OUT');
    expect(t.engine.state.unsynced).toBe(1);
    expect(await t.db.outbox.count()).toBe(1);
  });
});
