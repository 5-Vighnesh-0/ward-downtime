// Hash chain (SEC-10, design.md §9.6): hash_n = SHA-256(prev_hash_n || JCS({serverSeq, serverTime, event})).
import { createHash } from 'node:crypto';
import { canonicalize, type AnyEvent } from '@wdb/shared';

export const GENESIS_HASH: Buffer = Buffer.alloc(32);

/** Wire form of one log entry (hashes as lowercase hex). */
export interface LedgerEntry {
  serverSeq: number;
  serverTime: string;
  prevHash: string;
  hash: string;
  event: AnyEvent;
}

export function entryHash(prevHash: Buffer, serverSeq: number, serverTime: string, event: AnyEvent): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(canonicalize({ serverSeq, serverTime, event }))
    .digest();
}

export type ChainResult =
  | { ok: true; headSeq: number; headHash: string }
  | { ok: false; firstBadSeq: number; reason: 'SEQ_GAP' | 'PREV_HASH' | 'HASH' | 'HEAD_MISMATCH' };

/** Checks entries in order, continuing from `start`. Reports the first position that is wrong. */
export function verifyEntries(entries: LedgerEntry[], start = { seq: 0, hash: GENESIS_HASH.toString('hex') }): ChainResult {
  let seq = start.seq;
  let prev = start.hash;
  for (const e of entries) {
    seq += 1;
    if (e.serverSeq !== seq) return { ok: false, firstBadSeq: seq, reason: 'SEQ_GAP' };
    if (e.prevHash !== prev) return { ok: false, firstBadSeq: seq, reason: 'PREV_HASH' };
    const h = entryHash(Buffer.from(prev, 'hex'), e.serverSeq, e.serverTime, e.event).toString('hex');
    if (e.hash !== h) return { ok: false, firstBadSeq: seq, reason: 'HASH' };
    prev = h;
  }
  return { ok: true, headSeq: seq, headHash: prev };
}
