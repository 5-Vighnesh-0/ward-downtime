// WebCrypto pieces of the device (design.md §9.2, §9.6): Ed25519 signing and hash-chain checks.
import { canonicalize, signingInput, type AnyEvent } from '@wdb/shared';
import type { LedgerEntry } from './db.ts';

const utf8 = new TextEncoder();

export function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** The private key is created non-extractable: it can sign, but script can never read it out. */
export const newDeviceKey = () => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;

export const rawPublicKey = async (pair: CryptoKeyPair) => toBase64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));

const sign = async (key: CryptoKey, text: string) => toBase64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, utf8.encode(text))));

/** Signs the whole event except `sig` (SEC-9); the server verifies the same canonical bytes. */
export async function signEvent<E extends AnyEvent>(unsigned: Omit<E, 'sig'>, key: CryptoKey): Promise<E> {
  const e = { ...unsigned, sig: '' } as E;
  return { ...e, sig: await sign(key, signingInput(e)) };
}

/** X-WDB-Device-Sig for calls made before sign-in: `<deviceId>.<unixSeconds>.<sig over "METHOD path unixSeconds">`. */
export async function deviceSigHeader(deviceId: string, key: CryptoKey, method: string, path: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `${deviceId}.${t}.${await sign(key, `${method} ${path} ${t}`)}`;
}

/** hash = SHA-256(prevHash bytes || JCS({serverSeq, serverTime, event})), same as the server's chain.ts. */
export async function entryHash(prevHash: string, e: Pick<LedgerEntry, 'serverSeq' | 'serverTime' | 'event'>): Promise<string> {
  const body = utf8.encode(canonicalize({ serverSeq: e.serverSeq, serverTime: e.serverTime, event: e.event }));
  const prev = fromHex(prevHash);
  const buf = new Uint8Array(prev.length + body.length);
  buf.set(prev);
  buf.set(body, prev.length);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

/** The `.wdbx` container (design.md §7.3): PBKDF2-SHA256 → AES-256-GCM over a JSON object of named files. */
export async function sealWdbx(files: Record<string, string>, passphrase: string): Promise<string> {
  if (passphrase.length < 12) throw new Error('passphrase must be at least 12 characters');
  const iterations = 600_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(JSON.stringify(files))));
  return JSON.stringify({ wdbx: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toBase64url(salt), iv: toBase64url(iv), alg: 'AES-256-GCM', ciphertext: toBase64url(ciphertext) });
}

/** Opens a `.wdbx` (encrypted, or the admin's unencrypted kind). A wrong passphrase or an edited file throws. */
export async function openWdbx(text: string, passphrase: string): Promise<Record<string, string>> {
  const box = JSON.parse(text) as { wdbx?: number; alg?: string; files?: Record<string, string>; kdf?: string; iterations?: number; salt?: string; iv?: string; ciphertext?: string };
  if (box.wdbx !== 1) throw new Error('This is not a ward board file.');
  if (box.alg === 'none' && box.files) return box.files;
  const iterations = box.iterations ?? 0;
  if (box.alg !== 'AES-256-GCM' || box.kdf !== 'PBKDF2-SHA256' || !box.salt || !box.iv || !box.ciphertext || iterations < 100_000 || iterations > 10_000_000) {
    throw new Error('This file uses a format this app cannot open.');
  }
  const base = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64url(box.salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(box.iv) }, key, fromBase64url(box.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
  } catch {
    throw new Error('Wrong passphrase, or the file was changed.');
  }
}

/** Saves text as a file with a Blob URL: no network (on iOS this opens the share sheet). */
export function downloadText(filename: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
