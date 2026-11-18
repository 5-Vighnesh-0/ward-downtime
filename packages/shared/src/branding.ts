// Hospital branding (spec 2026-11-18 §1.4, FR-16): accent contrast and display-only bays. Never part of the event log.
import { z } from 'zod';

const HEX = /^#[0-9a-fA-F]{6}$/;
const printable = /^[^\u0000-\u001f\u007f]+$/;
const bedId = z.string().regex(/^B[0-9]{2}$/); // same format as schema.ts

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgbOf = (hex: string): number[] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = rgbOf(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of `#rrggbb` against white. */
export const contrastOnWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05);
export const MIN_CONTRAST = 4.5;

/** Darkens in 5% steps until the colour reads at 4.5:1 on white. Ends at black (21:1) at worst, so it always stops. */
export function darkenToContrast(hex: string): string {
  let rgb = rgbOf(hex);
  let out = hexOf(rgb);
  while (contrastOnWhite(out) < MIN_CONTRAST) {
    rgb = rgb.map((c) => Math.floor(c * 0.95));
    out = hexOf(rgb);
  }
  return out;
}

export const Accent = z
  .string()
  .regex(HEX)
  .transform((h) => h.toLowerCase())
  .refine((h) => contrastOnWhite(h) >= MIN_CONTRAST, 'Colour too light to read on white');

export const Bays = z
  .array(z.strictObject({ name: z.string().min(1).max(30).regex(printable), beds: z.array(bedId).min(1).max(60) }))
  .max(20)
  .refine((bays) => {
    const all = bays.flatMap((b) => b.beds);
    return new Set(all).size === all.length;
  }, 'A bed can be in one bay only');
export type Bays = z.infer<typeof Bays>;

export const BrandingUpdate = z.strictObject({
  hospitalName: z.string().trim().min(1).max(60).regex(printable).nullable(),
  accent: Accent.nullable(),
  bays: Bays.nullable(),
});
export type BrandingUpdate = z.infer<typeof BrandingUpdate>;

/** What `GET /api/v1/branding` returns. `logo` is a `data:` URL, so the CSP's `img-src 'self' data:` covers it. */
export interface Branding {
  hospitalName: string | null;
  accent: string | null;
  logo: string | null;
  bays: Bays | null;
  ward: string | null;
}
