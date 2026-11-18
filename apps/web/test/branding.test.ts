// FR-16: the tablet keeps the ward's branding, so the board still looks right with the server down.
import { afterEach, describe, expect, it } from 'vitest';
import { refreshBranding, loadBranding, NO_BRANDING } from '../src/ui/branding.ts';
import { startWard, tablet, type Tablet, type Ward } from './support.ts';

let ward: Ward;
let t: Tablet;
afterEach(async () => {
  t?.engine.stop();
  await ward?.close();
});

describe('branding on the tablet', () => {
  it('stores what the ward server sends and keeps it offline', async () => {
    ward = await startWard();
    t = await tablet(ward, 'nurse');
    expect(await loadBranding(t.db)).toEqual(NO_BRANDING);
    await ward.owner.pool.query("INSERT INTO ward_settings (id, hospital_name, accent) VALUES (1, 'Demo General Hospital', '#1d4ed8')");
    expect(await refreshBranding(t.db, t.net)).toMatchObject({ hospitalName: 'Demo General Hospital', accent: '#1d4ed8' });
    t.net.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect((await refreshBranding(t.db, t.net)).hospitalName).toBe('Demo General Hospital');
  });
});
