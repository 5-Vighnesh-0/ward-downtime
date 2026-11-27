// FR-16: the board picks the hospital's colour from its logo, ignoring white, black and grey.
import { describe, expect, it } from 'vitest';
import { dominantColor } from '../src/ui/logoColor.ts';

const pixels = (...runs: [number, [number, number, number, number]][]) =>
  new Uint8ClampedArray(runs.flatMap(([n, px]) => Array.from({ length: n }, () => px).flat()));

describe('dominantColor', () => {
  it('finds the main strong colour and skips white, black, grey and see-through pixels', () => {
    const logo = pixels([500, [255, 255, 255, 255]], [300, [0, 0, 0, 255]], [200, [128, 128, 128, 255]], [400, [255, 0, 0, 0]], [120, [20, 90, 200, 255]], [40, [200, 30, 30, 255]]);
    expect(dominantColor(logo)).toBe('#145ac8');
  });
  it('gives null for a logo with no strong colour', () => {
    expect(dominantColor(pixels([10, [255, 255, 255, 255]], [10, [40, 40, 40, 255]]))).toBeNull();
  });
});
