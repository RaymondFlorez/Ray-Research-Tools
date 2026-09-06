import { describe, expect, it } from 'vitest';
import {
  WASH_HALF_LIFE_MS,
  WashLayer,
  decay,
  haloColor,
  severityFor,
  washIntensity,
} from '../src/wash.js';
import { lightTheme } from '../src/theme.js';

describe('live wash (PRD 3.6)', () => {
  it('stays cold below the per-node z threshold', () => {
    expect(washIntensity(1.2, 2)).toBe(0);
    expect(washIntensity(2.1, 2)).toBeGreaterThan(0);
    expect(washIntensity(9, 2)).toBe(1);
  });

  it('halves intensity every 20 minutes', () => {
    expect(decay(1, 0)).toBe(1);
    expect(decay(1, WASH_HALF_LIFE_MS)).toBeCloseTo(0.5, 9);
    expect(decay(1, WASH_HALF_LIFE_MS * 2)).toBeCloseTo(0.25, 9);
    expect(decay(0.8, WASH_HALF_LIFE_MS)).toBeCloseTo(0.4, 9);
  });

  it('grades severity by how far past the threshold the move went', () => {
    expect(severityFor(2.1, 2)).toBe('low');
    expect(severityFor(3.5, 2)).toBe('medium');
    expect(severityFor(6, 2)).toBe('high');
    expect(severityFor(-6, 2)).toBe('high');
    expect(haloColor('high', lightTheme)).toBe(lightTheme.haloHigh);
  });
});

describe('WashLayer', () => {
  it('shows recent motion, not cumulative motion', () => {
    const layer = new WashLayer();
    layer.bump('a', 6, 0);
    const immediately = layer.intensityAt('a', 0);
    expect(immediately).toBe(1);

    const later = layer.intensityAt('a', WASH_HALF_LIFE_MS);
    expect(later).toBeCloseTo(0.5, 9);
    expect(layer.intensityAt('a', WASH_HALF_LIFE_MS * 6)).toBeLessThan(0.02);
  });

  it('takes the max rather than summing, so a busy series does not pin at full heat', () => {
    const layer = new WashLayer();
    layer.bump('a', 3, 0);
    const first = layer.intensityAt('a', 0);
    // A smaller move a moment later must not add on top of the first.
    layer.bump('a', 2.2, 1_000);
    expect(layer.intensityAt('a', 1_000)).toBeLessThanOrEqual(first);
    expect(layer.intensityAt('a', 1_000)).toBeGreaterThan(0);
  });

  it('reheats on a bigger move', () => {
    const layer = new WashLayer();
    layer.bump('a', 2.5, 0);
    const cooled = layer.intensityAt('a', WASH_HALF_LIFE_MS);
    layer.bump('a', 8, WASH_HALF_LIFE_MS);
    expect(layer.intensityAt('a', WASH_HALF_LIFE_MS)).toBeGreaterThan(cooled);
  });

  it('ignores a move that never crossed the threshold', () => {
    const layer = new WashLayer();
    expect(layer.bump('a', 0.5, 0)).toBe(0);
    expect(layer.size).toBe(0);
  });

  it('lists what is still worth painting, hottest first, and prunes the rest', () => {
    const layer = new WashLayer();
    layer.bump('cold', 2.2, 0);
    layer.bump('hot', 8, 0);

    const active = layer.active(0);
    expect(active.map((a) => a.nodeId)).toEqual(['hot', 'cold']);
    expect(active[0]?.severity).toBe('high');

    expect(layer.active(WASH_HALF_LIFE_MS * 8)).toEqual([]);
    expect(layer.prune(WASH_HALF_LIFE_MS * 8)).toBe(2);
    expect(layer.size).toBe(0);
  });
});
