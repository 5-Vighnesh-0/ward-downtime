// Hybrid logical clock for the envelope `hlc` field (design.md §3.3). Display and audit only: it never
// orders events or changes reducer outcomes (SEC-12). Pure: the caller passes the wall clock reading.
export interface Hlc {
  wallMs: number;
  counter: number;
}

const MAX_COUNTER = 999_999; // the schema allows 6 digits

/** The next local timestamp: never earlier than `prev`, even if the device clock jumps back. */
export function nextHlc(prev: Hlc | null, wallMs: number): Hlc {
  if (!prev || wallMs > prev.wallMs) return { wallMs, counter: 0 };
  return prev.counter < MAX_COUNTER ? { wallMs: prev.wallMs, counter: prev.counter + 1 } : { wallMs: prev.wallMs + 1, counter: 0 };
}

/** "<wallMs>.<counter>.<deviceShort>", e.g. "1762852443120.7.K3P". */
export const formatHlc = (h: Hlc, deviceShort: string) => `${String(h.wallMs).padStart(13, '0')}.${h.counter}.${deviceShort}`;
