// Ed25519 device signatures over the canonical signing input (SEC-9).
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { signingInput, type AnyEvent } from '@wdb/shared';

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

export function verifySignature(e: AnyEvent, key: KeyObject): boolean {
  return verify(null, Buffer.from(signingInput(e)), key, Buffer.from(e.sig, 'base64url'));
}
