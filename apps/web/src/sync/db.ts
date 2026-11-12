// Device-local stores (design.md §4.5). The board is always derived from `events` + `outbox`, never stored as truth.
import { Dexie, type EntityTable } from 'dexie';
import type { AnyEvent, Board, Role } from '@wdb/shared';

/** One confirmed log entry, exactly as the server sent it (hashes as lowercase hex). */
export interface LedgerEntry {
  serverSeq: number;
  serverTime: string;
  prevHash: string;
  hash: string;
  event: AnyEvent;
}

// 'acked': the server confirmed it, but the ledger entry has not been pulled yet, so it still counts in the view.
export type OutboxState = 'queued' | 'sending' | 'acked' | 'refused';

export interface OutboxItem {
  deviceSeq: number;
  eventId: string;
  state: OutboxState;
  event: AnyEvent;
  serverSeq?: number;
  code?: string; // refusal code from the server
}

export interface Snapshot {
  id: 'board';
  atSeq: number;
  headHash: string;
  board: Board;
}

export interface Meta {
  deviceId: string;
  label: string;
  tempPrefix: string; // '' until approved
  tempCounter: number;
  lastDeviceSeq: number;
  lastServerSeq: number;
  headHash: string;
  hlcWallMs: number;
  hlcCounter: number;
  persistGranted: boolean;
  lastPushAt: number; // device clock, display only
  fingerprint?: string; // shown on the enroll screen until the admin approves
}

export interface Session {
  staffId: string;
  role: Role;
  expiresAt: string;
}

/** Offline sign-in (design.md §9.4.3): a PBKDF2 verifier of the PIN, valid until `exp`. */
export interface Cred {
  staffId: string;
  role: Role;
  exp: string;
  salt: string; // base64url
  hash: string; // base64url
  iterations: number;
  failCount: number;
}

export interface KeyRecord {
  id: 'device';
  pair: CryptoKeyPair;
}

export type WdbDb = Dexie & {
  events: EntityTable<LedgerEntry, 'serverSeq'>;
  outbox: EntityTable<OutboxItem, 'deviceSeq'>;
  snapshot: EntityTable<Snapshot, 'id'>;
  meta: EntityTable<Meta & { id: 'device' }, 'id'>;
  keys: EntityTable<KeyRecord, 'id'>;
  session: EntityTable<Session & { id: 'current' }, 'id'>;
  creds: EntityTable<Cred, 'staffId'>;
};

export function openDb(name = 'wdb'): WdbDb {
  const db = new Dexie(name) as WdbDb;
  db.version(1).stores({
    events: 'serverSeq, &event.eventId',
    outbox: 'deviceSeq, &eventId, state',
    snapshot: 'id',
    meta: 'id',
    keys: 'id',
    session: 'id',
    creds: 'staffId',
  });
  return db;
}

export const GENESIS_HASH = '0'.repeat(64);
