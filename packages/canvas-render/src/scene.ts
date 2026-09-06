/**
 * Scene assembly.
 *
 * Turns a document plus a viewport into a draw list, bucketed by level of
 * detail: instanced quads at LOD0, canvas tiles at LOD1, DOM at LOD2 and above
 * (PRD 3.1). Nothing here touches the DOM or a GL context, so the whole
 * pipeline up to the draw call is testable and can run in a worker.
 *
 * The hot path is a spatial query plus a linear pass over what it returned, so
 * cost tracks what is on screen rather than what is on the canvas.
 */

import {
  cullRect,
  lodForScale,
  rectsIntersect,
  visibleWorldRect,
  worldToScreen,
  type CanvasDocument,
  type CanvasIndex,
  type Edge,
  type EdgeID,
  type LOD,
  type NodeID,
  type NodeKind,
  type PicassoNode,
  type Rect,
  type Vec2,
  type Viewport,
} from '@picasso/canvas-core';
import { nodeRect } from '@picasso/canvas-core';
import { nodeStyle, type NodeStyle } from './style.js';
import {
  edgeGeometry,
  edgeStyle,
  portAnchor,
  quadraticBounds,
  type EdgeGeometry,
  type EdgeStyle,
} from './edges.js';
import { haloColor, type Severity, type WashLayer } from './wash.js';
import type { Theme } from './theme.js';

export interface SceneNode {
  id: NodeID;
  kind: NodeKind;
  binding: PicassoNode['binding'];
  lod: LOD;
  worldRect: Rect;
  /** Screen-space rect, ready to draw. */
  screenRect: Rect;
  style: NodeStyle;
  /** One or two characters identifying the kind at LOD0. */
  glyph: string;
  /** Headline text, drawn from LOD1 up. */
  title: string;
  selected: boolean;
  /** Passive-mode heat in [0, 1], absent when cold. */
  wash?: number;
  halo?: { severity: Severity; color: string };
}

export interface SceneEdge {
  id: EdgeID;
  class: Edge['class'];
  world: EdgeGeometry;
  screen: EdgeGeometry;
  style: EdgeStyle;
}

export interface Scene {
  viewport: Viewport;
  /** Global LOD from the zoom level, before per-node overrides. */
  lod: LOD;
  /** LOD0: instanced quads, no DOM, no text. */
  quads: SceneNode[];
  /** LOD1: canvas-drawn tiles with a title and a headline metric. */
  tiles: SceneNode[];
  /** LOD2 and LOD3: interactive nodes that mount React DOM. */
  dom: SceneNode[];
  edges: SceneEdge[];
  stats: SceneStats;
}

export interface SceneStats {
  nodesTotal: number;
  nodesDrawn: number;
  nodesCulled: number;
  edgesTotal: number;
  edgesDrawn: number;
  buildMs: number;
}

export interface BuildSceneInput {
  doc: CanvasDocument;
  index: CanvasIndex;
  viewport: Viewport;
  theme: Theme;
  /** Timestamp used for wash decay and pulse phase. */
  now?: number;
  wash?: WashLayer;
  selection?: ReadonlySet<NodeID>;
  hoveredEdge?: EdgeID;
  /** Overrides the cull margin; the default is the PRD's 1.5 screens. */
  cullMarginScreens?: number;
}

const GLYPHS: Partial<Record<NodeKind, string>> = {
  DataTile: '#',
  ChartNode: '~',
  TableNode: '▤',
  SurfaceNode: '◱',
  CurveNode: '⌒',
  UniverseNode: '∪',
  HeatmapNode: '▩',
  TransformNode: 'ƒ',
  CodeNode: '{}',
  MonteCarloNode: '⁂',
  BacktestNode: '⟲',
  OptimizerNode: '⊹',
  FactorNode: 'β',
  ScenarioNode: '⌥',
  CausalNode: '→',
  ScoringNode: '★',
  StrategyNode: '⋔',
  ChainMetricNode: '⛓',
  ProbabilityCurveNode: '%',
  HypothesisNode: '?',
  QueryNode: '⌕',
  AgentNode: '◉',
  TextPad: '¶',
  InkLayer: '✎',
  EvidenceNode: '❝',
  FrameNode: '▭',
};

export function glyphFor(kind: NodeKind): string {
  return GLYPHS[kind] ?? '·';
}

/** Headline text for a node, falling back to the kind when unlabelled. */
export function titleFor(node: PicassoNode): string {
  const label = node.params['label'] ?? node.params['title'] ?? node.params['ticker'];
  return typeof label === 'string' && label.length > 0 ? label : node.kind;
}

function toScreenRect(vp: Viewport, world: Rect): Rect {
  const topLeft = worldToScreen(vp, { x: world.minX, y: world.minY });
  const bottomRight = worldToScreen(vp, { x: world.maxX, y: world.maxY });
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

function toScreenGeometry(vp: Viewport, g: EdgeGeometry): EdgeGeometry {
  return {
    p0: worldToScreen(vp, g.p0),
    c: worldToScreen(vp, g.c),
    p1: worldToScreen(vp, g.p1),
  };
}

/** Anchor for an edge endpoint, falling back to the node's edge midpoint. */
function anchorFor(
  node: PicassoNode,
  portId: string,
  direction: 'out' | 'in',
): Vec2 {
  const rect = nodeRect(node);
  const ports = direction === 'out' ? node.outputs : node.inputs;
  const index = ports.findIndex((p) => p.id === portId);
  if (index === -1) {
    // A drawn annotation has no port; anchor it to the side midpoint.
    return direction === 'out'
      ? { x: rect.maxX, y: (rect.minY + rect.maxY) / 2 }
      : { x: rect.minX, y: (rect.minY + rect.maxY) / 2 };
  }
  return portAnchor(rect, direction === 'out' ? 'right' : 'left', index, ports.length);
}

export function buildScene(input: BuildSceneInput): Scene {
  const started = performance.now();
  const { doc, index, viewport, theme, now = started } = input;
  const selection = input.selection ?? new Set<NodeID>();

  const globalLod = lodForScale(viewport.scale);
  const cull = cullRect(viewport, input.cullMarginScreens);

  const quads: SceneNode[] = [];
  const tiles: SceneNode[] = [];
  const dom: SceneNode[] = [];

  const visibleIds = index.query(cull);
  const visibleSet = new Set(visibleIds);

  for (const id of visibleIds) {
    const node = doc.nodes.get(id);
    if (!node) continue;

    const world = nodeRect(node);
    const lod = globalLod;
    const style = nodeStyle({
      binding: node.binding,
      status: node.state.status,
      lod,
      theme,
      frozen: node.frozen !== undefined,
      selected: selection.has(id),
    });

    const sceneNode: SceneNode = {
      id,
      kind: node.kind,
      binding: node.binding,
      lod,
      worldRect: world,
      screenRect: toScreenRect(viewport, world),
      style,
      glyph: glyphFor(node.kind),
      title: titleFor(node),
      selected: selection.has(id),
    };

    if (input.wash) {
      const intensity = input.wash.intensityAt(id, now);
      if (intensity > 0) {
        sceneNode.wash = intensity;
        const severity = input.wash.severityOf(id);
        if (severity) sceneNode.halo = { severity, color: haloColor(severity, theme) };
      }
    }

    if (lod === 0) quads.push(sceneNode);
    else if (lod === 1) tiles.push(sceneNode);
    else dom.push(sceneNode);
  }

  const edges: SceneEdge[] = [];
  for (const edge of doc.edges.values()) {
    const from = doc.nodes.get(edge.from.nodeId);
    const to = doc.nodes.get(edge.to.nodeId);
    if (!from || !to) continue;

    const bothOffscreen = !visibleSet.has(from.id) && !visibleSet.has(to.id);
    const world = edgeGeometry(
      anchorFor(from, edge.from.portId, 'out'),
      anchorFor(to, edge.to.portId, 'in'),
    );
    // An edge can cross the viewport with both endpoints outside it.
    if (bothOffscreen && !rectsIntersect(quadraticBounds(world), cull)) continue;

    edges.push({
      id: edge.id,
      class: edge.class,
      world,
      screen: toScreenGeometry(viewport, world),
      style: edgeStyle({
        edge,
        theme,
        lod: globalLod,
        computing: to.state.status === 'computing',
        hovered: input.hoveredEdge === edge.id,
      }),
    });
  }

  const nodesDrawn = quads.length + tiles.length + dom.length;
  return {
    viewport,
    lod: globalLod,
    quads,
    tiles,
    dom,
    edges,
    stats: {
      nodesTotal: doc.nodes.size,
      nodesDrawn,
      nodesCulled: doc.nodes.size - nodesDrawn,
      edgesTotal: doc.edges.size,
      edgesDrawn: edges.length,
      buildMs: performance.now() - started,
    },
  };
}

/** Nodes strictly on screen, for the scheduler's viewport set (PRD 3.4.2). */
export function onScreenNodes(index: CanvasIndex, viewport: Viewport): NodeID[] {
  return index.query(visibleWorldRect(viewport));
}
