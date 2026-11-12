// RFC 8785 JSON Canonicalization Scheme. Device and server must produce identical bytes for
// signatures (SEC-9) and the hash chain (SEC-10). ES JSON.stringify already matches RFC 8785 for
// strings and finite numbers, and the default sort compares UTF-16 code units as RFC 8785 requires.
import type { AnyEvent } from './schema.ts';

export function canonicalize(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
      .join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported ${typeof v}`);
}

/** The exact string a device signs: the whole event except `sig`. */
export function signingInput(e: AnyEvent): string {
  return canonicalize(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'sig')));
}
