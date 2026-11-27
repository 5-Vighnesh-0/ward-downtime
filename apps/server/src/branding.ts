// Hospital branding (spec 2026-11-18 §1.4; FR-16, SEC-32): logo checks and the one ward_settings row.
import { eq } from 'drizzle-orm';
import type { Bays, Branding } from '@wdb/shared';
import { auditLog, wardSettings } from './db/schema.ts';
import type { Db } from './db.ts';

export const MAX_LOGO_BYTES = 204_800;
const MAX_SIDE = 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG start-of-frame markers carry the size; C4, C8 and CC share the range but are not frames.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Type and size from the file's own bytes, never its name or the request header. Null for anything but PNG or JPEG. */
export function inspectImage(b: Buffer): { type: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG) && b.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    if (b[i + 1] === 0xff) {
      i++; // fill bytes may precede a marker (ITU-T T.81 B.1.1.2)
      continue;
    }
    if (i + 9 > b.length) return null;
    const marker = b[i + 1] ?? 0;
    if (isSof(marker)) return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** Why a logo is refused, or null when it is fine. */
export function logoProblem(b: Buffer): string | null {
  if (b.length > MAX_LOGO_BYTES) return 'Logo over 200 KB';
  const img = inspectImage(b);
  if (!img) return 'Logo must be a PNG or JPEG file';
  if (img.width < 1 || img.height < 1 || img.width > MAX_SIDE || img.height > MAX_SIDE) return 'Logo must be at most 1024 × 1024 pixels';
  return null;
}

export async function readBranding(db: Db, ward: string | null): Promise<Branding> {
  const [r] = await db.select().from(wardSettings).where(eq(wardSettings.id, 1));
  return {
    hospitalName: r?.hospitalName ?? null,
    accent: r?.accent ?? null,
    logo: r?.logo && r.logoType ? `data:${r.logoType};base64,${r.logo.toString('base64')}` : null,
    bays: (r?.bays as Bays | null | undefined) ?? null,
    ward,
  };
}

/** Creates or updates the single row (only the given columns change) and its BRANDING_CHANGED audit row, together or not at all. */
export async function saveBranding(
  db: Db,
  staffId: string,
  set: Partial<typeof wardSettings.$inferInsert>,
  audit: { deviceId: string | null; code: 'settings' | 'logo'; requestId: string },
): Promise<void> {
  const row = { ...set, updatedAt: new Date(), updatedBy: staffId };
  await db.transaction(async (tx) => {
    await tx
      .insert(wardSettings)
      .values({ id: 1, ...row })
      .onConflictDoUpdate({ target: wardSettings.id, set: row });
    await tx.insert(auditLog).values({ ...audit, staffId, action: 'BRANDING_CHANGED', outcome: 'ok' });
  });
}
