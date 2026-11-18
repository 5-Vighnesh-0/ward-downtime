// Hospital branding on the tablet (spec 2026-11-18 §1.4, FR-16): fetched from the ward server, kept for offline use.
import type { Branding } from '@wdb/shared';
import type { WdbDb } from '../sync/db.ts';
import { request, type Net } from '../sync/device.ts';

export const NO_BRANDING: Branding = { hospitalName: null, accent: null, logo: null, bays: null, ward: null };

export async function loadBranding(db: WdbDb): Promise<Branding> {
  return (await db.meta.get('device'))?.branding ?? NO_BRANDING;
}

/** Fetches and stores the branding; with the server unreachable it returns the stored copy. */
export async function refreshBranding(db: WdbDb, net: Net): Promise<Branding> {
  try {
    const b = (await (await request(net, 'GET', '/api/v1/branding')).json()) as Branding;
    await db.meta.update('device', { branding: b });
    return b;
  } catch {
    return loadBranding(db);
  }
}

/** Sets the accent for the whole app through CSSOM, which the CSP's style-src 'self' allows. */
export function applyAccent(accent: string | null): void {
  const root = document.documentElement.style;
  if (accent) root.setProperty('--color-accent', accent);
  else root.removeProperty('--color-accent');
}
