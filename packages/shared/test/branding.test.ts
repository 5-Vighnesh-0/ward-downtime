// Spec 2026-11-18 §1.4 (FR-16): the accent is always readable on white; bays never share a bed.
import { describe, expect, it } from 'vitest';
import { Bays, BrandingUpdate, contrastOnWhite, darkenToContrast, MIN_CONTRAST } from '../src/index.ts';
import { fc } from './prop/fc.ts';

describe('accent colour', () => {
  it('measures contrast like WCAG 2', () => {
    expect(contrastOnWhite('#000000')).toBeCloseTo(21, 1);
    expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastOnWhite('#0e7490')).toBeGreaterThan(MIN_CONTRAST); // today's teal
  });

  it('keeps a colour that is already dark enough, in lower case', () => {
    expect(darkenToContrast('#0E7490')).toBe('#0e7490');
  });

  it('always ends readable on white, whatever colour goes in', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const out = darkenToContrast(`#${n.toString(16).padStart(6, '0')}`);
        expect(out).toMatch(/^#[0-9a-f]{6}$/);
        expect(contrastOnWhite(out)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }),
    );
  });

  it('refuses a light accent and accepts a dark one', () => {
    expect(BrandingUpdate.safeParse({ hospitalName: null, accent: '#ffff00', bays: null }).success).toBe(false);
    expect(BrandingUpdate.safeParse({ hospitalName: 'Demo General Hospital', accent: '#0e7490', bays: null }).success).toBe(true);
    expect(BrandingUpdate.safeParse({ hospitalName: 'x', accent: 'teal', bays: null }).success).toBe(false);
  });
});

describe('bays', () => {
  it('accepts bays and refuses a bed in two bays, bad bed IDs and empty bays', () => {
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['B01', 'B02'] }, { name: 'Bay B', beds: ['B03'] }]).success).toBe(true);
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['B01'] }, { name: 'Bay B', beds: ['B01'] }]).success).toBe(false);
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['bed 1'] }]).success).toBe(false);
    expect(Bays.safeParse([{ name: 'Bay A', beds: [] }]).success).toBe(false);
  });
});
