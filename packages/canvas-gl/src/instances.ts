/**
 * Instance buffer packing.
 *
 * The whole point of the WebGL path is that node count stops costing draw
 * calls: every node in the scene becomes one instance in a single buffer, and
 * the frame issues one `drawArraysInstanced` for all of them. Ten thousand
 * nodes and ten nodes are the same number of draw calls.
 *
 * This module is the CPU half of that, and it is deliberately free of any GL
 * object so it can be tested and, later, moved to a worker: a `Scene` in, two
 * `Float32Array`s out.
 */

import type { Scene, SceneEdge, SceneNode } from '@picasso/canvas-render';

/** Floats per node instance. Must match the attribute layout in the shader. */
export const NODE_STRIDE = 20;
/** Floats per edge instance. */
export const EDGE_STRIDE = 12;

export interface InstanceBuffer {
  data: Float32Array;
  count: number;
  /** Floats per instance, for the attribute pointers. */
  stride: number;
}

export type RGBA = readonly [number, number, number, number];

const colorCache = new Map<string, RGBA>();

/**
 * Parses a CSS color into premultiplication-ready floats.
 *
 * Only the forms the theme actually uses are supported — #rgb, #rrggbb,
 * #rrggbbaa, and rgba() — and anything else falls back to opaque magenta
 * rather than throwing, because a wrong color in one frame is recoverable and
 * a thrown exception in the render loop is not.
 */
export function parseColor(color: string): RGBA {
  const cached = colorCache.get(color);
  if (cached) return cached;

  const parsed = parseUncached(color);
  colorCache.set(color, parsed);
  return parsed;
}

const FALLBACK: RGBA = [1, 0, 1, 1];

function parseUncached(color: string): RGBA {
  const value = color.trim();

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const parts = [...hex].map((c) => parseInt(c + c, 16) / 255);
      if (parts.some(Number.isNaN)) return FALLBACK;
      return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] ?? 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const parts: number[] = [];
      for (let i = 0; i < hex.length; i += 2) {
        parts.push(parseInt(hex.slice(i, i + 2), 16) / 255);
      }
      if (parts.some(Number.isNaN)) return FALLBACK;
      return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] ?? 1];
    }
    return FALLBACK;
  }

  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba) {
    const parts = (rgba[1] as string).split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return FALLBACK;
    return [
      (parts[0] as number) / 255,
      (parts[1] as number) / 255,
      (parts[2] as number) / 255,
      parts[3] === undefined || Number.isNaN(parts[3]) ? 1 : parts[3],
    ];
  }

  return FALLBACK;
}

function writeColor(target: Float32Array, offset: number, color: RGBA, alpha = 1): void {
  target[offset] = color[0];
  target[offset + 1] = color[1];
  target[offset + 2] = color[2];
  target[offset + 3] = color[3] * alpha;
}

/**
 * Packs every node the scene wants drawn, at any LOD, into one buffer.
 *
 * LOD is not a reason to use a different pipeline: an LOD0 quad and an LOD2
 * node body are the same rounded rectangle with different flags, so they share
 * one batch and the fragment shader decides what to draw. Splitting them would
 * trade a uniform for a second draw call and a second state change.
 */
export function packNodes(nodes: readonly SceneNode[], into?: Float32Array): InstanceBuffer {
  const data = into && into.length >= nodes.length * NODE_STRIDE
    ? into
    : new Float32Array(Math.max(1, nodes.length) * NODE_STRIDE);

  let offset = 0;
  for (const node of nodes) {
    const { screenRect: r, style } = node;
    data[offset] = r.minX;
    data[offset + 1] = r.minY;
    data[offset + 2] = r.maxX - r.minX;
    data[offset + 3] = r.maxY - r.minY;

    writeColor(data, offset + 4, parseColor(style.fill), style.opacity);
    writeColor(data, offset + 8, parseColor(style.stroke), style.opacity);
    writeColor(data, offset + 12, parseColor(style.statusColor), style.opacity);

    data[offset + 16] = style.cornerRadius;
    data[offset + 17] = style.strokeWidth;
    // A soft stroke is drawn as a lighter, wider edge rather than a dash
    // pattern: dashes cost either a texture lookup or geometry, and at LOD0 a
    // dashed border is smaller than one pixel anyway.
    data[offset + 18] = style.strokeStyle === 'soft' ? 1 : 0;
    data[offset + 19] = node.wash ?? 0;

    offset += NODE_STRIDE;
  }

  return { data, count: nodes.length, stride: NODE_STRIDE };
}

/** Packs edges as quadratic control points; the vertex shader walks the curve. */
export function packEdges(edges: readonly SceneEdge[], into?: Float32Array): InstanceBuffer {
  const data = into && into.length >= edges.length * EDGE_STRIDE
    ? into
    : new Float32Array(Math.max(1, edges.length) * EDGE_STRIDE);

  let offset = 0;
  for (const edge of edges) {
    const { p0, c, p1 } = edge.screen;
    data[offset] = p0.x;
    data[offset + 1] = p0.y;
    data[offset + 2] = c.x;
    data[offset + 3] = c.y;
    data[offset + 4] = p1.x;
    data[offset + 5] = p1.y;

    writeColor(data, offset + 6, parseColor(edge.style.color), edge.style.opacity);

    data[offset + 10] = edge.style.width;
    data[offset + 11] = edge.style.dash.length > 0 ? 1 : 0;

    offset += EDGE_STRIDE;
  }

  return { data, count: edges.length, stride: EDGE_STRIDE };
}

/** Everything a frame needs, packed. */
export interface PackedScene {
  nodes: InstanceBuffer;
  edges: InstanceBuffer;
  /** How long packing took, so the CPU half can be watched separately. */
  packMs: number;
}

export interface PackOptions {
  /** Reused buffers, so a steady-state frame allocates nothing. */
  nodeBuffer?: Float32Array;
  edgeBuffer?: Float32Array;
}

export function packScene(scene: Scene, options: PackOptions = {}): PackedScene {
  const started = performance.now();
  // One batch for every node on screen, whatever its LOD.
  const all = scene.quads.length + scene.tiles.length + scene.dom.length;
  const nodes: SceneNode[] = new Array(all);
  let i = 0;
  for (const node of scene.quads) nodes[i++] = node;
  for (const node of scene.tiles) nodes[i++] = node;
  for (const node of scene.dom) nodes[i++] = node;

  const packedNodes = packNodes(nodes, options.nodeBuffer);
  const packedEdges = packEdges(scene.edges, options.edgeBuffer);
  return { nodes: packedNodes, edges: packedEdges, packMs: performance.now() - started };
}

/**
 * Grows a reusable buffer to fit `count` instances, with headroom.
 *
 * Headroom is the point: a canvas that gains a node per frame would otherwise
 * reallocate every frame, which is exactly the per-frame garbage the reused
 * buffer exists to avoid. Growth is to 1.5x the requirement, or double the
 * current buffer, whichever is larger.
 */
export function ensureCapacity(
  buffer: Float32Array | undefined,
  count: number,
  stride: number,
): Float32Array {
  const needed = Math.max(1, count) * stride;
  if (buffer && buffer.length >= needed) return buffer;

  const withHeadroom = Math.ceil((needed * 1.5) / stride) * stride;
  const size = Math.max(withHeadroom, 64 * stride, (buffer?.length ?? 0) * 2);
  return new Float32Array(size);
}
