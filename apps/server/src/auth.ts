// Auth building blocks (design.md §9.2, §9.4): PIN hashing, device fingerprints and request signatures.
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

// N=2^15, r=8 needs 32 MiB, which is exactly Node's default maxmem, so raise it.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (pin: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pin, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPin(pin: string): Promise<{ hash: Buffer; salt: Buffer }> {
  const salt = randomBytes(16);
  return { hash: await scryptAsync(pin, salt), salt };
}

export async function checkPin(pin: string, hash: Buffer, salt: Buffer): Promise<boolean> {
  const h = await scryptAsync(pin, salt);
  return h.length === hash.length && timingSafeEqual(h, hash);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 12 Crockford base32 characters of SHA-256(public key): what the tablet shows and the admin compares. */
export function fingerprint(publicKey: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of createHash('sha256').update(publicKey).digest()) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

// Crockford base32 without the vowels A and E, so temp IDs never spell words.
const PREFIX_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ';
export const newTempPrefix = () => Array.from({ length: 3 }, () => PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)]).join('');

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest();

export interface DeviceSig {
  deviceId: string;
  unixSeconds: number;
  sig: Buffer;
}

const SIG_HEADER = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9]{1,12})\.([A-Za-z0-9_-]{86})$/i;
const MAX_SKEW_S = 300;

/** Parses X-WDB-Device-Sig: `<deviceId>.<unixSeconds>.<base64url Ed25519 sig over "METHOD path unixSeconds">`. */
export function parseDeviceSig(header: string): DeviceSig | null {
  const m = SIG_HEADER.exec(header);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { deviceId: m[1].toLowerCase(), unixSeconds: Number(m[2]), sig: Buffer.from(m[3], 'base64url') };
}

/** The only place a client time is checked: freshness of the signature, never ordering (SEC-12). */
export function verifyDeviceSig(p: DeviceSig, method: string, path: string, key: KeyObject, nowSeconds: number): boolean {
  if (Math.abs(nowSeconds - p.unixSeconds) > MAX_SKEW_S) return false;
  return verify(null, Buffer.from(`${method} ${path} ${p.unixSeconds}`), key, p.sig);
}
