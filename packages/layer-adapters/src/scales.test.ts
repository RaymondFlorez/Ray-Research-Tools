import { describe, expect, it } from 'vitest';
import { clamp01, getColorScale, makeColorAccessor, normalize } from './scales';

describe('normalize / clamp01', () => {
  it('maps a value into [0,1] against a domain', () => {
    expect(normalize(5, [0, 10])).toBe(0.5);
    expect(normalize(-5, [0, 10])).toBe(0);
    expect(normalize(50, [0, 10])).toBe(1);
  });

  it('handles a degenerate domain without dividing by zero', () => {
    expect(normalize(5, [5, 5])).toBe(0);
  });

  it('clamps NaN to 0', () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

describe('getColorScale', () => {
  it('returns endpoint colors at t=0 and t=1', () => {
    const viridis = getColorScale('viridis');
    expect(viridis(0)).toEqual([68, 1, 84]);
    expect(viridis(1)).toEqual([253, 231, 37]);
  });

  it('interpolates between control points', () => {
    const blues = getColorScale('blues');
    const mid = blues(0.5);
    expect(mid).toHaveLength(3);
    mid.forEach((c) => expect(c).toBeGreaterThanOrEqual(0));
  });

  it('falls back to viridis for an unknown scale', () => {
    expect(getColorScale('nope')(0)).toEqual(getColorScale('viridis')(0));
  });
});

describe('makeColorAccessor', () => {
  it('produces an RGBA from a datum field mapped through a scale', () => {
    const accessor = makeColorAccessor('depth', 'viridis', [0, 100]);
    expect(accessor({ depth: 0 })).toEqual([68, 1, 84, 255]);
    expect(accessor({ depth: 100 })).toEqual([253, 231, 37, 255]);
  });
});
