/**
 * Binding visual signatures (PRD 3.2).
 *
 * | State  | Visual signature                                  |
 * |--------|---------------------------------------------------|
 * | loose  | Soft stroke, no port dots, warm paper tint        |
 * | bound  | Solid border, live dot, no port dots              |
 * | wired  | Sharp border, port dots, status chip              |
 *
 * Guardrail #2 makes this load-bearing rather than decorative: "Binding state is
 * always visible at every LOD. If you cannot tell whether a thing is live, the
 * design is wrong." So the signature is computed per LOD, and
 * `signaturesDistinctAt` is the assertion that the three states never collapse
 * into the same appearance at any zoom.
 */

import type { BindingState, NodeStatus } from '@picasso/canvas-core';
import type { LOD } from '@picasso/canvas-core';
import type { Theme } from './theme.js';

export type StrokeStyle = 'soft' | 'solid' | 'sharp';

export interface NodeStyle {
  fill: string;
  stroke: string;
  strokeStyle: StrokeStyle;
  strokeWidth: number;
  cornerRadius: number;
  /** Wired nodes expose ports; nothing else does. */
  showPortDots: boolean;
  /** Bound objects carry a live dot: data updates, no wiring. */
  showLiveDot: boolean;
  /** Wired nodes carry a status chip. */
  showStatusChip: boolean;
  /** LOD0 draws a status dot instead of a chip; this is its color. */
  statusColor: string;
  /** Opacity multiplier, used to sink frozen cards back a step. */
  opacity: number;
}

const STROKE_WIDTH: Record<StrokeStyle, number> = {
  soft: 1.5,
  solid: 1.5,
  sharp: 2,
};

const CORNER_RADIUS: Record<BindingState, number> = {
  // A soft, hand-drawn feel for thinking; a crisp one for computing.
  loose: 10,
  bound: 6,
  wired: 3,
};

export function statusColor(status: NodeStatus, theme: Theme): string {
  switch (status) {
    case 'idle':
      return theme.idle;
    case 'stale':
      return theme.stale;
    case 'computing':
      return theme.computing;
    case 'ready':
      return theme.ready;
    case 'error':
      return theme.error;
    case 'unverified':
      return theme.unverified;
  }
}

export interface StyleInput {
  binding: BindingState;
  status: NodeStatus;
  lod: LOD;
  theme: Theme;
  /** Frozen cards read as archived rather than live. */
  frozen?: boolean;
  selected?: boolean;
}

export function nodeStyle(input: StyleInput): NodeStyle {
  const { binding, status, lod, theme } = input;
  const strokeStyle: StrokeStyle =
    binding === 'loose' ? 'soft' : binding === 'bound' ? 'solid' : 'sharp';

  // At LOD0 a node is a colored rectangle with a type glyph and a status dot, so
  // the binding has to survive in the fill and the outline alone.
  const fill = binding === 'loose' ? theme.paper : theme.surface;
  const stroke =
    binding === 'wired' ? theme.borderStrong : binding === 'bound' ? theme.border : theme.border;

  return {
    fill,
    stroke,
    strokeStyle,
    strokeWidth: STROKE_WIDTH[strokeStyle] * (input.selected ? 2 : 1),
    cornerRadius: CORNER_RADIUS[binding],
    // Port dots are only meaningful once a port is a target you can hit.
    showPortDots: binding === 'wired' && lod >= 1,
    showLiveDot: binding === 'bound',
    showStatusChip: binding === 'wired' && lod >= 2,
    statusColor: statusColor(status, theme),
    opacity: input.frozen ? 0.72 : 1,
  };
}

/**
 * Guardrail #2 as an executable check: at the given LOD, do the three binding
 * states differ in at least one channel a viewer can actually see?
 */
export function signaturesDistinctAt(lod: LOD, theme: Theme, status: NodeStatus = 'ready'): boolean {
  const states: BindingState[] = ['loose', 'bound', 'wired'];
  const signatures = states.map((binding) => {
    const s = nodeStyle({ binding, status, lod, theme });
    return [
      s.fill,
      s.stroke,
      s.strokeStyle,
      s.cornerRadius,
      s.showPortDots,
      s.showLiveDot,
      s.showStatusChip,
    ].join('|');
  });
  return new Set(signatures).size === states.length;
}
