// Device sync engine (design.md §5.1, §5.5, §5.6, §6.6, §9.6): local outbox, push, pull, SSE, optimistic view.
import { EventSchema, emptyBoard, formatHlc, nextHlc, replay, type AnyEvent, type Board, type EventType } from '@wdb/shared';
import { entryHash, signEvent } from './crypto.ts';
import { ApiError, request, type Net } from './device.ts';
import type { LedgerEntry, Meta, OutboxItem, Session, WdbDb } from './db.ts';

export type Alert = 'SIGNED_OUT' | 'DEVICE_REVOKED' | 'CHAIN_FORK' | 'STORAGE_LOST';

export interface EngineState {
  view: Board; // confirmed board + pending changes (what the ward sees on this device)
  confirmed: Board;
  outbox: readonly OutboxItem[];
  blocked: readonly string[]; // pending eventIds the optimistic view could not apply (never shown as phantom conflicts)
  unsynced: number; // §8.3: queued + sending + refused
  online: boolean;
  alert: Alert | null;
  lastPushAt: number;
}

type Payload<T extends EventType> = Extract<AnyEvent, { type: T }>['payload'];

const PAGE = 1000;
const MAX_BATCH = 100;
const MAX_BATCH_BYTES = 200 * 1024; // under the server's 256 KiB body limit
const SNAPSHOT_EVERY = 500;
const POLL_MS = 15_000;
const SSE_RETRY_AFTER_POLLING_MS = 5 * 60_000;
const STREAM_SILENCE_MS = 45_000; // over 2 server pings (20 s)

/** The ward server answered. A bare 5xx with none of our error codes comes from a proxy in front of a server that is down. */
const reachable = (e: unknown) => e instanceof ApiError && !e.code.startsWith('HTTP_');

/** Full-jitter exponential backoff (§5.6): random(0, min(60 s, 1 s × 2^attempt)). */
export const backoffMs = (attempt: number, random: () => number) => random() * Math.min(60_000, 1000 * 2 ** attempt);

/** Splits an SSE byte stream into frames. Returns complete frames and the unparsed remainder. */
export function parseSse(buffer: string): { frames: { id?: string; event: string; data: string }[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames = parts.flatMap((part) => {
    const f: { id?: string; event: string; data: string } = { event: 'message', data: '' };
    let any = false;
    for (const line of part.split('\n')) {
      if (!line || line.startsWith(':')) continue; // comment (ping)
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'id') f.id = value;
      else if (field === 'event') f.event = value;
      else if (field === 'data') f.data += (f.data ? '\n' : '') + value;
      any = true;
    }
    return any ? [f] : [];
  });
  return { frames, rest };
}

export class SyncEngine {
  readonly #db: WdbDb;
  readonly #net: Net;
  readonly #random: () => number;
  #meta: Meta;
  #key: CryptoKey;
  #session: Session | null;
  #confirmed: Board;
  #outbox: OutboxItem[];
  #state: EngineState;
  #listeners = new Set<(s: EngineState) => void>();
  #pushing: Promise<void> | null = null;
  #pushAgain: Promise<void> | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #applying: Promise<unknown> = Promise.resolve();
  #abort = new AbortController();
  #wake = new AbortController();

  private constructor(db: WdbDb, net: Net, random: () => number, meta: Meta, key: CryptoKey, session: Session | null, confirmed: Board, outbox: OutboxItem[]) {
    this.#db = db;
    this.#net = net;
    this.#random = random;
    this.#meta = meta;
    this.#key = key;
    this.#session = session;
    this.#confirmed = confirmed;
    this.#outbox = outbox;
    this.#state = this.#derive({ online: false, alert: null });
  }

  /** Cold start from IndexedDB: snapshot + the events after it, then the outbox (§4.5). */
  static async open(db: WdbDb, net: Net, random: () => number = Math.random): Promise<SyncEngine> {
    const [meta, key, session, snap] = await Promise.all([db.meta.get('device'), db.keys.get('device'), db.session.get('current'), db.snapshot.get('board')]);
    if (!meta || !key) throw new Error('device not enrolled');
    const rest = await db.events.where('serverSeq').above(snap?.atSeq ?? 0).sortBy('serverSeq');
    const confirmed = replay(rest, snap?.board ?? emptyBoard());
    const outbox = await db.outbox.orderBy('deviceSeq').toArray();
    return new SyncEngine(db, net, random, meta, key.pair.privateKey, session ?? null, confirmed, outbox);
  }

  get state(): EngineState {
    return this.#state;
  }

  get device(): { deviceId: string; label: string; tempPrefix: string; nextPatientId: string } {
    const m = this.#meta;
    return { deviceId: m.deviceId, label: m.label, tempPrefix: m.tempPrefix, nextPatientId: `T-${m.tempPrefix}-${String(m.tempCounter + 1).padStart(4, '0')}` };
  }

  get session(): Session | null {
    return this.#session;
  }

  /** The newest confirmed events this tablet made (for My changes). */
  async myConfirmed(limit: number): Promise<AnyEvent[]> {
    const id = this.#meta.deviceId;
    const rows = await this.#db.events.orderBy('serverSeq').reverse().filter((e) => e.event.deviceId === id).limit(limit).toArray();
    return rows.map((r) => r.event);
  }

  /** Ends the server session if reachable; the outbox stays and sends at the next sign-in. */
  async signOut(): Promise<void> {
    this.#session = null;
    await this.#db.session.delete('current');
    await request(this.#net, 'DELETE', '/api/v1/sessions/current').catch(() => undefined);
    this.#publish();
  }

  subscribe(fn: (s: EngineState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Admit with a new temporary patient ID `T-<prefix>-<n>` (§7.1), or re-admit an unplaced patient by ID (E13). */
  admit(payload: Omit<Payload<'ADMIT'>, 'patientId'> & { patientId?: string }): Promise<OutboxItem> {
    const { patientId } = payload;
    if (patientId) return this.#record('ADMIT', () => ({ ...payload, patientId }), false);
    return this.#record('ADMIT', (m) => ({ ...payload, patientId: `T-${m.tempPrefix}-${String(m.tempCounter).padStart(4, '0')}` }), true);
  }

  /** Confirmed events by eventId, for showing who placed each conflict candidate. */
  async eventsById(ids: readonly string[]): Promise<Map<string, AnyEvent>> {
    const rows = await this.#db.events.where('event.eventId').anyOf([...ids]).toArray();
    return new Map(rows.map((r) => [r.event.eventId, r.event]));
  }

  record<T extends Exclude<EventType, 'ADMIT'>>(type: T, payload: Payload<T>): Promise<OutboxItem> {
    return this.#record(type, () => payload);
  }

  /** Called after an online sign-in stored the session. */
  async resume(): Promise<void> {
    this.#session = (await this.#db.session.get('current')) ?? null;
    this.#set(this.#state.alert === 'SIGNED_OUT' ? { alert: null } : {});
    void this.push();
  }

  // --- §5.1 local write path -------------------------------------------------------------------

  async #record<T extends EventType>(type: T, build: (m: Meta) => Payload<T>, newTempId = false): Promise<OutboxItem> {
    const session = this.#session;
    if (!session) throw new Error('sign in first');
    if (!this.#meta.tempPrefix) throw new Error('device not approved yet');
    if (this.#state.alert === 'DEVICE_REVOKED') throw new Error('device revoked');
    const now = this.#net.now();
    // Reserve the sequence number, temp ID and clock in one transaction, so a crash can skip but never reuse them.
    // Signing happens after: WebCrypto promises would end an IndexedDB transaction early.
    const m = await this.#db.transaction('rw', this.#db.meta, async () => {
      const cur = await this.#db.meta.get('device');
      if (!cur) throw new Error('device not enrolled');
      const h = nextHlc({ wallMs: cur.hlcWallMs, counter: cur.hlcCounter }, now);
      const next = { ...cur, lastDeviceSeq: cur.lastDeviceSeq + 1, tempCounter: cur.tempCounter + (newTempId ? 1 : 0), hlcWallMs: h.wallMs, hlcCounter: h.counter };
      await this.#db.meta.put(next);
      return next;
    });
    this.#meta = { ...this.#meta, lastDeviceSeq: m.lastDeviceSeq, tempCounter: m.tempCounter, hlcWallMs: m.hlcWallMs, hlcCounter: m.hlcCounter };
    const unsigned = {
      v: 1 as const,
      eventId: crypto.randomUUID(),
      type,
      deviceId: m.deviceId,
      deviceSeq: m.lastDeviceSeq,
      staffId: session.staffId,
      basedOn: this.#meta.lastServerSeq,
      hlc: formatHlc({ wallMs: m.hlcWallMs, counter: m.hlcCounter }, m.tempPrefix),
      clientTime: new Date(now).toISOString(),
      payload: build(m),
    };
    const check = EventSchema.safeParse({ ...unsigned, sig: 'A'.repeat(86) });
    if (!check.success) throw new Error(`invalid ${type}: ${check.error.issues[0]?.message ?? 'schema'}`);
    const event = await signEvent<AnyEvent>(unsigned as Omit<AnyEvent, 'sig'>, this.#key);
    const item: OutboxItem = { deviceSeq: event.deviceSeq, eventId: event.eventId, state: 'queued', event };
    await this.#db.outbox.put(item);
    this.#outbox = [...this.#outbox, item];
    this.#publish();
    void this.push();
    return item;
  }

  // --- push (§5.3, §5.6) ------------------------------------------------------------------------

  /** Sends queued events in deviceSeq order, one batch at a time. Safe to call any time. */
  push(): Promise<void> {
    // While a push runs, callers get one follow-up push that starts after it, so what they queued is covered.
    if (this.#pushing) return (this.#pushAgain ??= this.#pushing.then(() => ((this.#pushAgain = null), this.push())));
    this.#pushing = this.#pushLoop().finally(() => (this.#pushing = null));
    return this.#pushing;
  }

  async #pushLoop(): Promise<void> {
    let appended = false;
    for (;;) {
      if (!this.#session || this.#state.alert === 'DEVICE_REVOKED' || this.#state.alert === 'SIGNED_OUT') break;
      const batch: OutboxItem[] = [];
      let bytes = 0;
      for (const item of this.#outbox) {
        if (item.state !== 'queued' && item.state !== 'sending') continue;
        bytes += JSON.stringify(item.event).length;
        if (batch.length === MAX_BATCH || (batch.length > 0 && bytes > MAX_BATCH_BYTES)) break;
        batch.push(item);
      }
      if (!batch.length) break;
      await this.#setItems(batch.map((i) => ({ ...i, state: 'sending' })));
      let res: { results: ({ eventId: string; status: 'appended' | 'duplicate'; serverSeq: number } | { eventId: string; status: 'refused'; code: string })[] };
      try {
        res = await (await request(this.#net, 'POST', '/api/v1/events', { deviceId: this.#meta.deviceId, events: batch.map((i) => i.event) })).json();
      } catch (e) {
        await this.#setItems(batch.map((i) => ({ ...i, state: 'queued' })));
        await this.#onFailure(e);
        return;
      }
      this.#attempt = 0;
      const updates = res.results.flatMap((r): OutboxItem[] => {
        const item = this.#outbox.find((i) => i.eventId === r.eventId);
        if (!item) return []; // already confirmed by SSE
        if (r.status === 'refused') return [{ ...item, state: 'refused', code: r.code }];
        appended = true;
        return [{ ...item, state: 'acked', serverSeq: r.serverSeq }];
      });
      if (res.results.some((r) => r.status === 'refused' && r.code === 'DEVICE_SEQ_REGRESSION')) this.#set({ alert: 'STORAGE_LOST' });
      await this.#setItems(updates);
      this.#meta = { ...this.#meta, lastPushAt: this.#net.now() };
      await this.#db.meta.update('device', { lastPushAt: this.#meta.lastPushAt });
      this.#set({ online: true });
    }
    if (appended) await this.pull(); // fetch the ledger entries for what was just acknowledged
  }

  async #onFailure(e: unknown): Promise<void> {
    if (e instanceof ApiError && e.code === 'DEVICE_REVOKED') return this.#wipe();
    if (e instanceof ApiError && e.code === 'NO_SESSION') {
      this.#session = null;
      await this.#db.session.delete('current');
      this.#set({ alert: 'SIGNED_OUT' });
      return;
    }
    this.#set({ online: reachable(e) });
    clearTimeout(this.#retryTimer);
    const delay = e instanceof ApiError && e.retryAfterMs !== null ? e.retryAfterMs : backoffMs(this.#attempt++, this.#random);
    if (!this.#abort.signal.aborted) this.#retryTimer = setTimeout(() => void this.push(), delay);
  }

  /** SEC-8, SEC-14: a revoked device deletes everything it holds. */
  async #wipe(): Promise<void> {
    this.stop();
    this.#session = null;
    this.#outbox = [];
    this.#confirmed = emptyBoard();
    this.#db.close();
    await this.#db.delete();
    this.#set({ alert: 'DEVICE_REVOKED', online: false });
  }

  // --- pull and apply (§5.6, §9.6) --------------------------------------------------------------

  /** Pulls every entry after the local head, page by page. */
  async pull(): Promise<void> {
    if (!this.#session || this.#state.alert === 'CHAIN_FORK') return;
    for (;;) {
      let page: { entries: LedgerEntry[]; disabledStaff?: string[] };
      try {
        page = await (await request(this.#net, 'GET', `/api/v1/events?after=${this.#meta.lastServerSeq}&limit=${PAGE}`)).json();
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'DEVICE_REVOKED' || e.code === 'NO_SESSION')) await this.#onFailure(e);
        else this.#set({ online: reachable(e) });
        return;
      }
      const wasOffline = !this.#state.online;
      this.#set({ online: true });
      if (wasOffline) void this.push(); // back in contact: send what queued up, without waiting for the backoff timer
      // §9.2.3: staff disabled on the server lose offline sign-in on this device.
      if (page.disabledStaff?.length) await this.#db.creds.bulkDelete(page.disabledStaff);
      const result = await this.apply(page.entries);
      if (result !== 'ok' || page.entries.length < PAGE) return;
    }
  }

  /** Applies entries that extend the local chain. Serialized, so SSE and pull can overlap safely. */
  apply(entries: readonly LedgerEntry[]): Promise<'ok' | 'gap' | 'fork'> {
    const run = this.#applying.then(() => this.#applyNow(entries));
    this.#applying = run.catch(() => undefined);
    return run;
  }

  async #applyNow(entries: readonly LedgerEntry[]): Promise<'ok' | 'gap' | 'fork'> {
    if (this.#state.alert === 'CHAIN_FORK') return 'fork';
    let seq = this.#meta.lastServerSeq;
    let head = this.#meta.headHash;
    const ok: LedgerEntry[] = [];
    let result: 'ok' | 'gap' | 'fork' = 'ok';
    for (const e of entries) {
      if (e.serverSeq <= seq) continue; // already have it
      if (e.serverSeq !== seq + 1) {
        result = 'gap';
        break;
      }
      // Hashing over our own head also checks prevHash: a server whose log does not extend ours
      // (restored from an old backup, or tampered) is refused.
      if ((await entryHash(head, e)) !== e.hash || !EventSchema.safeParse(e.event).success) {
        result = 'fork';
        break;
      }
      ok.push(e);
      seq = e.serverSeq;
      head = e.hash;
    }
    if (ok.length) {
      const ids = ok.map((e) => e.event.eventId);
      const before = this.#confirmed.atSeq;
      this.#confirmed = replay(ok, this.#confirmed);
      const snapshot = Math.floor(seq / SNAPSHOT_EVERY) > Math.floor(before / SNAPSHOT_EVERY);
      await this.#db.transaction('rw', [this.#db.events, this.#db.meta, this.#db.outbox, this.#db.snapshot], async () => {
        await this.#db.events.bulkPut(ok);
        await this.#db.meta.update('device', { lastServerSeq: seq, headHash: head });
        await this.#db.outbox.where('eventId').anyOf(ids).delete();
        if (snapshot) await this.#db.snapshot.put({ id: 'board', atSeq: seq, headHash: head, board: this.#confirmed });
      });
      this.#meta = { ...this.#meta, lastServerSeq: seq, headHash: head };
      const done = new Set(ids);
      this.#outbox = this.#outbox.filter((i) => !done.has(i.eventId));
    }
    if (result === 'fork') this.#set({ alert: 'CHAIN_FORK' });
    else this.#publish();
    return result;
  }

  // --- live stream (§5.6) -----------------------------------------------------------------------

  /** Keeps an SSE stream open; falls back to polling after 3 failures in 60 s, retrying SSE every 5 min. */
  async connect(): Promise<void> {
    const signal = this.#abort.signal;
    let failures: number[] = [];
    while (!signal.aborted && this.#state.alert !== 'DEVICE_REVOKED') {
      if (!this.#session) {
        await this.#sleep(1000);
        continue;
      }
      try {
        const res = await this.#net.fetch(`${this.#net.baseUrl}/api/v1/stream`, {
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream', 'last-event-id': String(this.#meta.lastServerSeq) },
          signal,
        });
        if (res.status === 401 || res.status === 403) {
          const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? '';
          await this.#onFailure(new ApiError(res.status, code));
        } else if (!res.ok) {
          this.#set({ online: false });
        } else if (res.body) {
          this.#set({ online: true });
          void this.push(); // §5.6: push immediately when the stream opens
          await this.#read(res.body);
        }
      } catch {
        if (signal.aborted) return;
        this.#set({ online: false });
      }
      const now = this.#net.now();
      failures = [...failures.filter((t) => now - t < 60_000), now];
      if (this.#wake.signal.aborted) {
        // The network came back (retryStream): reconnect now instead of backing off or polling.
        this.#wake = new AbortController();
        failures = [];
      } else if (failures.length >= 3) {
        const until = now + SSE_RETRY_AFTER_POLLING_MS;
        while (!signal.aborted && !this.#wake.signal.aborted && this.#net.now() < until) {
          await this.pull();
          await this.#sleep(POLL_MS);
        }
        failures = [];
      } else {
        await this.#sleep(backoffMs(failures.length, this.#random));
      }
    }
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const text = new TextDecoder();
    let buffer = '';
    // The server pings every 20 s. Silence for longer means a dead connection (server gone behind a proxy,
    // or a half-open Wi-Fi link) that would otherwise hang here forever; cancel it so connect() retries.
    let heard = this.#net.now();
    const watchdog = setInterval(() => {
      if (this.#net.now() - heard > STREAM_SILENCE_MS) void reader.cancel();
    }, 5000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        heard = this.#net.now();
        const { frames, rest } = parseSse(buffer + text.decode(value, { stream: true }));
        buffer = rest;
        for (const f of frames) {
          if (f.event === 'resync') {
            await this.pull();
            return;
          }
          if (f.event !== 'appended') continue;
          if ((await this.apply([JSON.parse(f.data) as LedgerEntry])) === 'gap') await this.pull();
        }
      }
    } finally {
      clearInterval(watchdog);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const done = () => (clearTimeout(t), resolve());
      this.#abort.signal.addEventListener('abort', done, { once: true });
      this.#wake.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** The network is back (browser `online` event): end any backoff or polling wait and reopen the stream. */
  retryStream(): void {
    this.#wake.abort();
  }

  stop(): void {
    this.#abort.abort();
    clearTimeout(this.#retryTimer);
  }

  // --- view (§5.5, §6.6) ------------------------------------------------------------------------

  async #setItems(items: OutboxItem[]): Promise<void> {
    if (!items.length) return;
    const ids = new Set(this.#outbox.map((i) => i.eventId));
    const live = items.filter((i) => ids.has(i.eventId));
    // Only update rows that still exist: an SSE entry may have confirmed and removed them meanwhile.
    await this.#db.transaction('rw', this.#db.outbox, async () => {
      for (const i of live) if (await this.#db.outbox.get(i.deviceSeq)) await this.#db.outbox.put(i);
    });
    const byId = new Map(live.map((i) => [i.eventId, i]));
    this.#outbox = this.#outbox.map((i) => byId.get(i.eventId) ?? i);
    this.#publish();
  }

  #set(patch: Partial<Pick<EngineState, 'online' | 'alert'>>): void {
    this.#state = this.#derive({ online: patch.online ?? this.#state.online, alert: patch.alert === undefined ? this.#state.alert : patch.alert });
    for (const fn of this.#listeners) fn(this.#state);
  }

  #publish(): void {
    this.#set({});
  }

  #derive(s: Pick<EngineState, 'online' | 'alert'>): EngineState {
    // Pending events go on top of the confirmed board in deviceSeq order, with provisional sequence numbers.
    // One that would not apply (for example the bed was taken meanwhile) is left out of the view instead of
    // showing a conflict the server has not ordered yet (§6.6: no phantom conflicts).
    let view = this.#confirmed;
    let seq = view.atSeq;
    const blocked: string[] = [];
    for (const item of this.#outbox) {
      if (item.state === 'refused') continue;
      const next = replay([{ serverSeq: ++seq, event: item.event }], view);
      if (next.outcomes[item.eventId]?.kind === 'applied') view = next;
      else blocked.push(item.eventId);
    }
    return {
      view,
      confirmed: this.#confirmed,
      outbox: this.#outbox,
      blocked,
      unsynced: this.#outbox.filter((i) => i.state !== 'acked').length,
      online: s.online,
      alert: s.alert,
      lastPushAt: this.#meta.lastPushAt,
    };
  }
}
