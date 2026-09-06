/**
 * A synthetic canvas to render.
 *
 * Deliberately mixed: loose sketches, bound tiles and wired nodes side by side,
 * every status represented, clusters wired into local subgraphs, and a handful
 * of nodes hot in the passive-mode wash. The point is to see the binding
 * signatures and the LOD ladder under something resembling real density.
 */

import {
  CanvasIndex,
  addNode,
  createDocument,
  createNode,
  type BindingState,
  type CanvasDocument,
  type Edge,
  type NodeKind,
  type NodeStatus,
  type Port,
} from '@picasso/canvas-core';
import { WashLayer } from '@picasso/canvas-render';

/** Deterministic PRNG so the demo and its screenshots are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WIRED_KINDS: NodeKind[] = [
  'DataTile', 'ChartNode', 'TableNode', 'CurveNode', 'SurfaceNode', 'TransformNode',
  'CodeNode', 'MonteCarloNode', 'BacktestNode', 'StrategyNode', 'ScenarioNode',
  'FactorNode', 'ProbabilityCurveNode', 'HypothesisNode', 'ScoringNode',
];
const BOUND_KINDS: NodeKind[] = ['DataTile', 'ChartNode', 'ChainMetricNode', 'TableNode'];
const LOOSE_KINDS: NodeKind[] = ['InkLayer', 'TextPad', 'FrameNode', 'EvidenceNode'];

const STATUSES: NodeStatus[] = ['ready', 'ready', 'ready', 'stale', 'computing', 'error', 'unverified'];

const TICKERS = [
  'NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'MU', 'SOXL', 'SMH', 'INTC', 'ARM',
  'SPX', 'NDX', 'VIX', 'SOFR', 'UST10Y', 'DXY', 'BTC', 'ETH', 'HYG', 'TLT',
];

function ports(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [
      { id: 'in', name: 'input', type: 'series', cardinality: 'many', required: false },
      { id: 'ctx', name: 'context', type: 'scalar', cardinality: 'one', required: false },
    ],
    outputs: [{ id: 'out', name: 'output', type: 'series', cardinality: 'many', required: false }],
  };
}

export interface DemoCanvas {
  doc: CanvasDocument;
  index: CanvasIndex;
  wash: WashLayer;
  /** World bounds of the generated content, for the initial fit. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function buildDemoCanvas(nodeCount = 2_000, seed = 7): DemoCanvas {
  const rand = mulberry32(seed);
  const doc = createDocument('demo');
  const wash = new WashLayer();

  // Lay the canvas out in loose clusters rather than a grid, so pan and zoom
  // have something with structure to move through.
  const clusterCount = Math.max(1, Math.round(nodeCount / 24));
  const clusters: Array<{ x: number; y: number }> = [];
  const perRow = Math.ceil(Math.sqrt(clusterCount));
  for (let i = 0; i < clusterCount; i++) {
    clusters.push({
      x: (i % perRow) * 2_600 + rand() * 500,
      y: Math.floor(i / perRow) * 2_000 + rand() * 400,
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const idsByCluster: string[][] = clusters.map(() => []);

  for (let i = 0; i < nodeCount; i++) {
    const clusterIndex = i % clusters.length;
    const cluster = clusters[clusterIndex];
    if (!cluster) continue;

    const roll = rand();
    const binding: BindingState = roll < 0.18 ? 'loose' : roll < 0.34 ? 'bound' : 'wired';
    const pool = binding === 'loose' ? LOOSE_KINDS : binding === 'bound' ? BOUND_KINDS : WIRED_KINDS;
    const kind = pool[Math.floor(rand() * pool.length)] as NodeKind;

    const w = binding === 'loose' ? 150 + rand() * 120 : 210 + rand() * 90;
    const h = binding === 'loose' ? 90 + rand() * 70 : 130 + rand() * 60;
    const x = cluster.x + (rand() - 0.5) * 1_900;
    const y = cluster.y + (rand() - 0.5) * 1_400;

    const status: NodeStatus =
      binding === 'loose' ? 'idle' : (STATUSES[Math.floor(rand() * STATUSES.length)] as NodeStatus);

    const id = `n${i}`;
    const { inputs, outputs } = ports();
    const node = createNode({
      id,
      kind,
      binding,
      position: { x, y },
      size: { w, h },
      params: { ticker: TICKERS[Math.floor(rand() * TICKERS.length)] as string },
      ...(binding === 'wired' ? { inputs, outputs } : {}),
    });
    node.state = { status };
    if (status === 'ready') node.state.cacheKey = `k${i}`;
    addNode(doc, node);
    idsByCluster[clusterIndex]?.push(id);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);

    // A few nodes are hot in the wash, as if the session had been running.
    if (rand() < 0.04) wash.bump(id, 2 + rand() * 6, -rand() * 15 * 60_000);
  }

  // Wire each cluster into a shallow local subgraph, and draw a few causal and
  // reference edges so every edge class is represented.
  let edgeSeq = 0;
  for (const ids of idsByCluster) {
    const wired = ids.filter((id) => doc.nodes.get(id)?.binding === 'wired');
    for (let i = 1; i < wired.length; i++) {
      if (rand() > 0.55) continue;
      const from = wired[Math.floor(rand() * i)] as string;
      const to = wired[i] as string;
      if (from === to) continue;
      const roll = rand();
      const edge: Edge = {
        id: `e${edgeSeq++}`,
        from: { nodeId: from, portId: 'out' },
        to: { nodeId: to, portId: 'in' },
        class: roll < 0.82 ? 'data' : roll < 0.93 ? 'causal' : 'reference',
      };
      if (edge.class === 'causal') {
        edge.causal = {
          sign: rand() < 0.5 ? -1 : 1,
          elasticity: rand() * 3,
          lagPeriods: Math.floor(rand() * 5),
        };
      }
      doc.edges.set(edge.id, edge);
    }

    // An analyst note pinned to a node: loose -> wired is a reference edge.
    const sticky = ids.find((id) => doc.nodes.get(id)?.binding === 'loose');
    const target = wired[0];
    if (sticky && target) {
      doc.edges.set(`e${edgeSeq}`, {
        id: `e${edgeSeq++}`,
        from: { nodeId: sticky, portId: '' },
        to: { nodeId: target, portId: '' },
        class: 'reference',
      });
    }
  }

  return {
    doc,
    index: new CanvasIndex(doc),
    wash,
    bounds: { minX, minY, maxX, maxY },
  };
}
