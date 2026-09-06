import { describe, expect, it } from 'vitest';
import type { Edge } from '@picasso/canvas-core';
import {
  causalWidth,
  edgeGeometry,
  edgeStyle,
  formatLag,
  portAnchor,
  pulsePhase,
  quadraticBounds,
  sampleQuadratic,
} from '../src/edges.js';
import { lightTheme } from '../src/theme.js';

const rect = { minX: 0, minY: 0, maxX: 100, maxY: 200 };

function edge(over: Partial<Edge> = {}): Edge {
  return {
    id: 'e1',
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
    class: 'data',
    ...over,
  };
}

describe('edge geometry (PRD 3.5)', () => {
  it('spreads ports evenly along a side instead of stacking them', () => {
    const one = portAnchor(rect, 'left', 0, 1);
    expect(one).toEqual({ x: 0, y: 100 });

    const first = portAnchor(rect, 'right', 0, 3);
    const second = portAnchor(rect, 'right', 1, 3);
    const third = portAnchor(rect, 'right', 2, 3);
    expect(first.x).toBe(100);
    expect(first.y).toBeLessThan(second.y);
    expect(second.y).toBeLessThan(third.y);
    expect(second.y - first.y).toBeCloseTo(third.y - second.y, 9);
  });

  it('starts and ends exactly on its endpoints', () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 400, y: 120 });
    expect(sampleQuadratic(g, 0)).toEqual(g.p0);
    expect(sampleQuadratic(g, 1)).toEqual(g.p1);
  });

  it('bows out rather than running straight, so parallel edges stay readable', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 0 };
    const g = edgeGeometry(from, to);
    const mid = sampleQuadratic(g, 0.5);
    // Off the straight line between the endpoints.
    expect(Math.abs(mid.y - 0)).toBeGreaterThan(0);
    expect(g.c.x).toBeGreaterThan(from.x);
  });

  it('caps the bow so a cross-canvas edge does not fly off the plane', () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 100_000, y: 0 });
    expect(g.c.x - 0).toBeLessThanOrEqual(240);
  });

  it('bounds the curve with its control polygon', () => {
    const g = edgeGeometry({ x: 10, y: 10 }, { x: 300, y: 200 });
    const bounds = quadraticBounds(g);
    for (let t = 0; t <= 1; t += 0.05) {
      const p = sampleQuadratic(g, t);
      expect(p.x).toBeGreaterThanOrEqual(bounds.minX - 1e-9);
      expect(p.x).toBeLessThanOrEqual(bounds.maxX + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(bounds.minY - 1e-9);
      expect(p.y).toBeLessThanOrEqual(bounds.maxY + 1e-9);
    }
  });
});

describe('edge styling by class (PRD 3.5)', () => {
  it('draws data edges solid, and pulses them only while the target computes', () => {
    const idle = edgeStyle({ edge: edge(), theme: lightTheme });
    expect(idle.dash).toEqual([]);
    expect(idle.pulse).toBe(false);
    expect(idle.arrowhead).toBe(true);

    const busy = edgeStyle({ edge: edge(), theme: lightTheme, computing: true });
    expect(busy.pulse).toBe(true);
  });

  it('keeps reference edges dotted and faint until hover', () => {
    const resting = edgeStyle({ edge: edge({ class: 'reference' }), theme: lightTheme });
    const hovered = edgeStyle({
      edge: edge({ class: 'reference' }),
      theme: lightTheme,
      hovered: true,
    });
    expect(resting.dash.length).toBeGreaterThan(0);
    expect(resting.opacity).toBeLessThan(0.5);
    expect(hovered.opacity).toBeGreaterThan(resting.opacity);
  });

  it('signs causal edges by color and encodes elasticity in thickness', () => {
    const positive = edgeStyle({
      edge: edge({ class: 'causal', causal: { sign: 1, elasticity: 0.4, lagPeriods: 2 } }),
      theme: lightTheme,
    });
    const negative = edgeStyle({
      edge: edge({ class: 'causal', causal: { sign: -1, elasticity: 2.4, lagPeriods: 0 } }),
      theme: lightTheme,
    });

    expect(positive.color).toBe(lightTheme.causalPositive);
    expect(negative.color).toBe(lightTheme.causalNegative);
    expect(negative.width).toBeGreaterThan(positive.width);
    expect(positive.label).toBe('t+2');
    expect(negative.label).toBe('t');
  });

  it('saturates causal thickness so one wild elasticity does not blot the canvas', () => {
    expect(causalWidth(3)).toBe(causalWidth(300));
    expect(causalWidth(0)).toBeLessThan(causalWidth(1));
    expect(causalWidth(-2)).toBe(causalWidth(2));
  });

  it('labels lags in both directions', () => {
    expect(formatLag(0)).toBe('t');
    expect(formatLag(3)).toBe('t+3');
    expect(formatLag(-1)).toBe('t-1');
  });

  it('draws annotations softly and never labels them', () => {
    const style = edgeStyle({ edge: edge({ class: 'annotation' }), theme: lightTheme });
    expect(style.color).toBe(lightTheme.edgeAnnotation);
    expect(style.label).toBeUndefined();
    expect(style.pulse).toBe(false);
  });
});

describe('flow pulse', () => {
  it('cycles in [0, 1) on wall-clock time, not frames', () => {
    expect(pulsePhase(0)).toBe(0);
    expect(pulsePhase(600, 1200)).toBeCloseTo(0.5, 9);
    expect(pulsePhase(1200, 1200)).toBe(0);
    expect(pulsePhase(-600, 1200)).toBeCloseTo(0.5, 9);
    for (const t of [0, 137, 999, 12345]) {
      const phase = pulsePhase(t);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });
});

describe('edge decoration is LOD-gated', () => {
  const causal = edge({
    class: 'causal',
    causal: { sign: 1, elasticity: 1, lagPeriods: 2 },
  });

  it('drops lag labels and arrowheads at LOD0, where they are unreadable noise', () => {
    const zoomedOut = edgeStyle({ edge: causal, theme: lightTheme, lod: 0 });
    expect(zoomedOut.label).toBeUndefined();
    expect(zoomedOut.arrowhead).toBe(false);
    // The edge itself still draws: sign and thickness survive at any zoom.
    expect(zoomedOut.color).toBe(lightTheme.causalPositive);
    expect(zoomedOut.width).toBeGreaterThan(0);
  });

  it('keeps them from LOD1 up', () => {
    for (const lod of [1, 2, 3] as const) {
      const style = edgeStyle({ edge: causal, theme: lightTheme, lod });
      expect(style.label).toBe('t+2');
      expect(style.arrowhead).toBe(true);
    }
  });

  it('still pulses a computing data edge at LOD0, because that is status not decoration', () => {
    const style = edgeStyle({ edge: edge(), theme: lightTheme, lod: 0, computing: true });
    expect(style.pulse).toBe(true);
  });
});
