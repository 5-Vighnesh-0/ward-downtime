// Device enrollment and staff sign-in against the ward server (design.md §9.2, §9.4.1).
import type { Role } from '@wdb/shared';
import { deviceSigHeader, newDeviceKey, rawPublicKey } from './crypto.ts';
import { GENESIS_HASH, type Meta, type WdbDb } from './db.ts';

export interface Net {
  baseUrl: string; // '' in the browser: same origin
  fetch: typeof fetch;
  now: () => number;
  clockOffsetMs?: number; // last X-WDB-Clock-Offset-Ms from the server (SEC-28), display only
}

export const browserNet = (): Net => ({ baseUrl: '', fetch: (input, init) => fetch(input, init), now: () => Date.now() });

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string, retryAfterMs: number | null = null) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Every call carries the CSRF header and the device clock for skew measurement (§5.2, §5.8). */
export async function request(net: Net, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const res = await net.fetch(net.baseUrl + path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-wdb-request': '1',
      'x-wdb-client-time': new Date(net.now()).toISOString(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? null : JSON.stringify(body),
    // A reply lost on a half-open connection would otherwise wait forever; the outbox retries safely (FR-4).
    signal: AbortSignal.timeout(30_000),
  });
  const offset = Number(res.headers.get('x-wdb-clock-offset-ms') ?? NaN);
  if (Number.isFinite(offset)) net.clockOffsetMs = offset;
  if (res.ok) return res;
  const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  const retry = Number(res.headers.get('retry-after'));
  throw new ApiError(res.status, err?.error?.code ?? `HTTP_${res.status}`, Number.isFinite(retry) && retry > 0 ? retry * 1000 : null);
}

async function deviceKey(db: WdbDb): Promise<{ meta: Meta; pair: CryptoKeyPair }> {
  const [meta, key] = await Promise.all([db.meta.get('device'), db.keys.get('device')]);
  if (!meta || !key) throw new Error('device not enrolled');
  return { meta, pair: key.pair };
}

/** First launch: make the key and ID, then ask the server to enroll. Returns the fingerprint to read to the admin. */
export async function enroll(db: WdbDb, net: Net, label: string): Promise<string> {
  if (!(await db.meta.get('device'))) {
    const pair = await newDeviceKey();
    const meta: Meta = {
      deviceId: crypto.randomUUID(),
      label,
      tempPrefix: '',
      tempCounter: 0,
      lastDeviceSeq: 0,
      lastServerSeq: 0,
      headHash: GENESIS_HASH,
      hlcWallMs: 0,
      hlcCounter: 0,
      persistGranted: false,
      lastPushAt: 0,
    };
    await db.transaction('rw', db.meta, db.keys, async () => {
      await db.keys.put({ id: 'device', pair });
      await db.meta.put({ id: 'device', ...meta });
    });
  }
  const { meta, pair } = await deviceKey(db);
  const res = await request(net, 'POST', '/api/v1/devices', { deviceId: meta.deviceId, publicKey: await rawPublicKey(pair), label: meta.label });
  const { fingerprint } = (await res.json()) as { fingerprint: string };
  await db.meta.update('device', { fingerprint });
  return fingerprint;
}

/** Polls approval. On approval the server's temp-ID prefix is stored (§7.1). */
export async function enrollmentStatus(db: WdbDb, net: Net): Promise<'pending' | 'active' | 'revoked'> {
  const { meta, pair } = await deviceKey(db);
  const path = `/api/v1/devices/${meta.deviceId}/status`;
  const sig = await deviceSigHeader(meta.deviceId, pair.privateKey, 'GET', path, net.now());
  const s = (await (await request(net, 'GET', path, undefined, { 'x-wdb-device-sig': sig })).json()) as { status: 'pending' | 'active' | 'revoked'; tempPrefix: string | null };
  if (s.status === 'active' && s.tempPrefix) await db.meta.update('device', { tempPrefix: s.tempPrefix });
  return s.status;
}

/** Online PIN sign-in, device-signed. The session cookie is HttpOnly; only who is signed in is stored here. */
export async function signIn(db: WdbDb, net: Net, staffId: string, pin: string): Promise<{ staffId: string; role: Role; expiresAt: string }> {
  const { meta, pair } = await deviceKey(db);
  const sig = await deviceSigHeader(meta.deviceId, pair.privateKey, 'POST', '/api/v1/sessions', net.now());
  const res = await request(net, 'POST', '/api/v1/sessions', { staffId, pin }, { 'x-wdb-device-sig': sig });
  const s = (await res.json()) as { staffId: string; role: Role; expiresAt: string };
  await db.session.put({ id: 'current', staffId: s.staffId, role: s.role, expiresAt: s.expiresAt });
  return s;
}
