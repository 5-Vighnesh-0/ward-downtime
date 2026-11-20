// Picks the hospital's colour from its logo, on this tablet only (spec 2026-11-18 §1.4, FR-16). No internet.

/** Most common strong colour in RGBA pixels, averaged within its bucket; null when there is none. */
export function dominantColor(rgba: Uint8ClampedArray): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const a = rgba[i + 3] ?? 0;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (a < 128 || lo > 230 || hi < 25 || hi - lo < 30) continue; // see-through, near white, near black, grey
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const s = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    buckets.set(key, { n: s.n + 1, r: s.r + r, g: s.g + g, b: s.b + b });
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const s of buckets.values()) if (!best || s.n > best.n) best = s;
  if (!best) return null;
  const n = best.n;
  return `#${[best.r, best.g, best.b].map((c) => Math.round(c / n).toString(16).padStart(2, '0')).join('')}`;
}

/** Draws the logo small and reads its pixels. Browser only (createImageBitmap, OffscreenCanvas). */
export async function colourFromFile(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(bmp, 0, 0, 64, 64);
  return dominantColor(g.getImageData(0, 0, 64, 64).data);
}
