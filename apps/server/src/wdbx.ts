// The `.wdbx` container (design.md §7.3, SEC-15): PBKDF2-SHA256 → AES-256-GCM over a JSON object of named files.
// Same format as the device's WebCrypto version (apps/web/src/sync/crypto.ts); each side's tests open the other's files.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

export type Files = Record<string, string>;
const ITERATIONS = 600_000;
const TAG = 16;

export function sealWdbx(files: Files, passphrase: string): string {
  if (passphrase.length < 12) throw new Error('passphrase must be at least 12 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256'), iv, { authTagLength: TAG });
  const ciphertext = Buffer.concat([c.update(JSON.stringify(files)), c.final(), c.getAuthTag()]);
  const b64 = (b: Buffer) => b.toString('base64url');
  return JSON.stringify({ wdbx: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), alg: 'AES-256-GCM', ciphertext: b64(ciphertext) });
}

/** Admin-only opt-out (§7.3): same container, files in the clear, `alg: "none"`. */
export const plainWdbx = (files: Files) => JSON.stringify({ wdbx: 1, alg: 'none', files });

/** Opens either kind. A wrong passphrase or any edit to the file fails the GCM check and throws. */
export function openWdbx(text: string, passphrase: string): Files {
  const box = JSON.parse(text) as { wdbx?: number; alg?: string; files?: Files; kdf?: string; iterations?: number; salt?: string; iv?: string; ciphertext?: string };
  if (box.wdbx !== 1) throw new Error('not a .wdbx file');
  if (box.alg === 'none' && box.files) return box.files;
  if (box.alg !== 'AES-256-GCM' || box.kdf !== 'PBKDF2-SHA256' || !box.salt || !box.iv || !box.ciphertext) throw new Error('unsupported .wdbx file');
  const iterations = box.iterations ?? 0;
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) throw new Error('unsupported .wdbx iterations');
  const data = Buffer.from(box.ciphertext, 'base64url');
  const key = pbkdf2Sync(passphrase, Buffer.from(box.salt, 'base64url'), iterations, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'), { authTagLength: TAG });
  d.setAuthTag(data.subarray(-TAG));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -TAG)), d.final()]).toString('utf8')) as Files;
}
