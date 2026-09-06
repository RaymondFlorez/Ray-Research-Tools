/**
 * Edge geometry and styling (PRD 3.5).
 *
 * | Class      | Semantics                          | Render                                    |
 * |------------|------------------------------------|-------------------------------------------|
 * | data       | dataflow dependency                | solid bezier, flow pulse while computing  |
 * | reference  | citation or provenance link        | dotted, low opacity until hover           |
 * | causal     | asserted causal claim              | thick, signed color, thickness = elasticity, label = lag |
 * | annotation | a drawing                          | soft, unlabelled                          |
 *
 * Everything is a quadratic bezier so the WebGL layer can draw the whole edge
 * set in one instanced pass.
 */

import type { Edge, LOD, Vec2 } from '@picasso/canvas-core';
import type { Rect } from '@picasso/canvas-core';
import type { Theme } from './theme.js';

export interface EdgeGeometry {
  p0: Vec2;
  /** Single control point: quadratic, not cubic, for one-pass instancing. */
  c: Vec2;
  p1: Vec2;
}

export type PortSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * Where a port sits on a node's edge. Ports are distributed evenly along the
 * side so a node with three inputs does not stack them on one point.
 */
export function portAnchor(rect: Rect, side: PortSide, index: number, count: number): Vec2 {
  const t = (index + 1) / (count + 1);
  switch (side) {
    case 'left':
      return { x: rect.minX, y: rect.minY + (rect.maxY - rect.minY) * t };
    case 'right':
      return { x: rect.maxX, y: rect.minY + (rect.maxY - rect.minY) * t };
    case 'top':
      return { x: rect.minX + (rect.maxX - rect.minX) * t, y: rect.minY };
    case 'bottom':
      return { x: rect.minX + (rect.maxX - rect.minX) * t, y: rect.maxY };
  }
}

/**
 * Bows the curve horizontally by a fraction of the span, so edges between
 * stacked nodes stay readable instead of collapsing onto each other.
 */
export function edgeGeometry(from: Vec2, to: Vec2, bow = 0.35): EdgeGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy);
  const lift = Math.min(span * bow, 240);
  // Control point pushed out along the outgoing direction, then perpendicular a
  // little, which keeps a left-to-right dataflow reading like a dataflow.
  return {
    p0: from,
    c: { x: from.x + lift, y: (from.y + to.y) / 2 - Math.sign(dy || 1) * lift * 0.15 },
    p1: to,
  };
}

export function sampleQuadratic(g: EdgeGeometry, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * g.p0.x + 2 * u * t * g.c.x + t * t * g.p1.x,
    y: u * u * g.p0.y + 2 * u * t * g.c.y + t * t * g.p1.y,
  };
}

/** Conservative bounds (the control polygon), used to cull edges. */
export function quadraticBounds(g: EdgeGeometry): Rect {
  return {
    minX: Math.min(g.p0.x, g.c.x, g.p1.x),
    minY: Math.min(g.p0.y, g.c.y, g.p1.y),
    maxX: Math.max(g.p0.x, g.c.x, g.p1.x),
    maxY: Math.max(g.p0.y, g.c.y, g.p1.y),
  };
}

export interface EdgeStyle {
  color: string;
  width: number;
  /** Dash pattern in world units; empty means solid. */
  dash: number[];
  opacity: number;
  /** Data edges pulse while the target is computing. */
  pulse: boolean;
  /** Causal edges label their lag. */
  label?: string;
  /** Draw an arrowhead: dataflow and causation have direction, drawings may not. */
  arrowhead: boolean;
}

export interface EdgeStyleInput {
  edge: Edge;
  theme: Theme;
  /**
   * Zoom level of detail. Below LOD1 a lag label is a few unreadable pixels and
   * an arrowhead is smaller than the line it caps, so both are dropped: they
   * cost a draw call each and read as noise on a zoomed-out canvas.
   */
  lod?: LOD;
  /** True while the downstream node is computing. */
  computing?: boolean;
  hovered?: boolean;
}

/** Below this level, edge decoration is dropped. */
export const EDGE_DECORATION_LOD_FLOOR: LOD = 1;

/** Elasticity magnitude that maps to the maximum stroke width. */
const ELASTICITY_SATURATION = 3;
const CAUSAL_MIN_WIDTH = 2;
const CAUSAL_MAX_WIDTH = 8;

export function causalWidth(elasticity: number): number {
  const magnitude = Math.min(Math.abs(elasticity), ELASTICITY_SATURATION) / ELASTICITY_SATURATION;
  return CAUSAL_MIN_WIDTH + magnitude * (CAUSAL_MAX_WIDTH - CAUSAL_MIN_WIDTH);
}

export function edgeStyle(input: EdgeStyleInput): EdgeStyle {
  const { edge, theme, computing = false, hovered = false, lod = 2 } = input;
  const decorate = lod >= EDGE_DECORATION_LOD_FLOOR;

  switch (edge.class) {
    case 'data':
      return {
        color: theme.edgeData,
        width: 1.75,
        dash: [],
        opacity: 1,
        pulse: computing,
        arrowhead: decorate,
      };

    case 'reference':
      return {
        color: theme.edgeReference,
        width: 1.25,
        dash: [2, 4],
        // Low opacity until hover, so provenance links do not compete with data.
        opacity: hovered ? 0.95 : 0.35,
        pulse: false,
        arrowhead: false,
      };

    case 'causal': {
      const causal = edge.causal;
      const sign = causal?.sign ?? 1;
      const style: EdgeStyle = {
        color: sign < 0 ? theme.causalNegative : theme.causalPositive,
        width: causalWidth(causal?.elasticity ?? 1),
        dash: [],
        opacity: 1,
        pulse: false,
        arrowhead: decorate,
      };
      if (causal && decorate) style.label = formatLag(causal.lagPeriods);
      return style;
    }

    case 'annotation':
      return {
        color: theme.edgeAnnotation,
        width: 1.5,
        dash: [],
        opacity: hovered ? 0.9 : 0.6,
        pulse: false,
        arrowhead: decorate,
      };
  }
}

export function formatLag(lagPeriods: number): string {
  if (lagPeriods === 0) return 't';
  return lagPeriods > 0 ? `t+${lagPeriods}` : `t${lagPeriods}`;
}

/**
 * Phase of the flow pulse, in [0, 1). Time-based rather than frame-based so the
 * animation runs at the same speed whatever the frame rate.
 */
export function pulsePhase(timeMs: number, periodMs = 1200): number {
  return ((timeMs % periodMs) + periodMs) % periodMs / periodMs;
}
