/**
 * Tools, not modes (PRD 3.2.3), on a live canvas.
 *
 * V pointer · P pen · W wire · C causal · T sticky · Shift T TextPad. A stylus
 * inks whatever tool is chosen and hands it back on lift; a finger never
 * switches, and is refused as a palm while the pen is down. Nothing here
 * changes what is drawn when a tool changes: the scene below is built from the
 * document and the viewport, and the tool is not an input to it.
 */

import {
  ToolState,
  addNode,
  CanvasIndex,
  createDocument,
  createNode,
  dragIntent,
  finishWire,
  moveNode,
  nodeRect,
  resolveDrawnArrow,
  screenToWorld,
  wireTargets,
  type DragIntent,
  type Hit,
  type InputDevice,
  type PicassoNode,
  type Port,
  type PortRef,
  type Vec2,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, lightTheme, portAnchor, type Scene } from '@picasso/canvas-render';
import { drawScene } from './draw.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const readout = document.getElementById('readout') as HTMLElement;
const context = canvas.getContext('2d', { alpha: false });
if (!context) throw new Error('Canvas2D unavailable');
const ctx = context;
const theme = lightTheme;
const NOW = 1_000;

const doc = createDocument('tools');
type Freq = 'daily' | 'monthly';
const input = (id: string, frequency: Freq): Port => ({
  id, name: id, type: 'series', cardinality: 'one', required: true, constraints: { frequency: [frequency] },
});
const output = (id: string, frequency: Freq): Port => ({
  id, name: id, type: 'series', cardinality: 'one', required: true, emits: { frequency },
});
const provenance = { datasetSnapshots: {}, asof: '2026-01-02T00:00:00Z', verified: true };
function wired(id: string, kind: PicassoNode['kind'], x: number, y: number, inputs: PicassoNode['inputs'], outputs: PicassoNode['outputs']) {
  const n = createNode({ id, kind, binding: 'wired', position: { x, y }, size: { w: 200, h: 120 }, inputs, outputs, provenance });
  n.state = { status: 'ready' };
  return addNode(doc, n);
}
wired('prices', 'DataTile', 80, 120, [], [output('px', 'daily')]);
wired('daily', 'ChartNode', 480, 60, [input('in', 'daily')], []);
wired('monthly', 'ChartNode', 480, 300, [input('in', 'monthly')], []);
wired('rates', 'CausalNode', 80, 380, [], [output('r', 'daily')]);
const index = new CanvasIndex(doc);

const tools = new ToolState();
let viewport: Viewport = { x: 0, y: 0, scale: 1, width: 0, height: 0 };
const strokes: Vec2[][] = [];
const arrows: Array<{ from: Vec2; to: Vec2; class: string }> = [];
let palms = 0;
let seq = 0;
let lastOutcome = '';
let causalEditorFor: string | null = null;

/** The one drag in progress, keyed by the pointer that started it. */
let drag: { pointerId: number; intent: DragIntent; start: Vec2; last: Vec2; points: Vec2[]; targets: PortRef[] } | null = null;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewport = { ...viewport, width: window.innerWidth, height: window.innerHeight };
}
window.addEventListener('resize', resize);
resize();

/** Where each port sits on screen: inputs on the left edge, outputs on the right. */
function ports(): Array<PortRef & { at: Vec2 }> {
  const out: Array<PortRef & { at: Vec2 }> = [];
  for (const node of doc.nodes.values()) {
    if (node.binding !== 'wired') continue;
    const rect = nodeRect(node);
    node.inputs.forEach((p, i) => out.push({ nodeId: node.id, portId: p.id, side: 'input', at: portAnchor(rect, 'left', i, node.inputs.length) }));
    node.outputs.forEach((p, i) => out.push({ nodeId: node.id, portId: p.id, side: 'output', at: portAnchor(rect, 'right', i, node.outputs.length) }));
  }
  return out;
}

function hitAt(world: Vec2): Hit {
  for (const p of ports()) {
    if (Math.hypot(p.at.x - world.x, p.at.y - world.y) <= 10) return { kind: 'port', nodeId: p.nodeId, portId: p.portId, side: p.side };
  }
  const node = index.hit(doc, world);
  return node ? { kind: 'node', nodeId: node.id } : { kind: 'empty' };
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const editingText = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  tools.key({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, editingText });
});

canvas.addEventListener('pointerdown', (e) => {
  const decision = tools.pointerDown(e.pointerId, e.pointerType as InputDevice);
  if (!decision.accepted) {
    palms += 1;
    return;
  }
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // A synthetic pointer from the test harness has nothing to capture.
  }
  const world = screenToWorld(viewport, { x: e.clientX, y: e.clientY });
  const intent = dragIntent(decision.tool, hitAt(world), tools.textVariant);
  drag = {
    pointerId: e.pointerId,
    intent,
    start: world,
    last: world,
    points: [world],
    targets: intent.kind === 'wire' ? wireTargets(doc, intent.anchor) : [],
  };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.pointerId !== e.pointerId || !tools.isTracked(e.pointerId)) return;
  const world = screenToWorld(viewport, { x: e.clientX, y: e.clientY });
  if (drag.intent.kind === 'move') {
    const node = doc.nodes.get(drag.intent.nodeId);
    if (node) moveNode(doc, index, node.id, { x: node.position.x + world.x - drag.last.x, y: node.position.y + world.y - drag.last.y });
  }
  drag.points.push(world);
  drag.last = world;
});

function release(e: PointerEvent): void {
  const accepted = tools.isTracked(e.pointerId);
  tools.pointerUp(e.pointerId);
  if (!accepted || !drag || drag.pointerId !== e.pointerId) return;
  const end = screenToWorld(viewport, { x: e.clientX, y: e.clientY });
  const intent = drag.intent;
  const landed = hitAt(end);
  seq += 1;
  switch (intent.kind) {
    case 'ink':
      strokes.push(drag.points);
      lastOutcome = `ink: ${drag.points.length} points`;
      break;
    case 'wire': {
      const outcome = finishWire(doc, intent.anchor, landed, `wire-${seq}`);
      lastOutcome = outcome.kind === 'refused' ? `refused: ${outcome.reason}` : outcome.kind;
      break;
    }
    case 'arrow':
    case 'causal': {
      const source = intent.from ? doc.nodes.get(intent.from) : undefined;
      const target = landed.kind === 'empty' ? undefined : doc.nodes.get(landed.nodeId);
      const causalMode = intent.kind === 'causal';
      if (source && target && source.id !== target.id) {
        const resolution = resolveDrawnArrow(source, target, { causalMode });
        arrows.push({ from: drag.start, to: end, class: resolution.class });
        if (resolution.needsCausalParams) causalEditorFor = `${source.id}->${target.id}`;
        lastOutcome = `${resolution.class} arrow`;
      } else {
        arrows.push({ from: drag.start, to: end, class: causalMode ? 'causal' : 'annotation' });
        lastOutcome = `${causalMode ? 'causal' : 'annotation'} arrow, unattached`;
      }
      break;
    }
    case 'text': {
      const note = createNode({
        id: `note-${seq}`,
        kind: 'TextPad',
        binding: intent.binding,
        position: end,
        size: { w: 160, h: 90 },
        provenance,
      });
      addNode(doc, note);
      index.upsert(note);
      lastOutcome = `${intent.variant} (${intent.binding})`;
      break;
    }
    default:
      lastOutcome = intent.kind;
  }
  drag = null;
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

let lastScene: Scene | null = null;

function frame(): void {
  // The tool is deliberately not an input here.
  const scene = buildScene({ doc, index, viewport, theme, now: NOW });
  lastScene = scene;
  drawScene(ctx, scene, { theme, now: NOW, dpr: 1 });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1c1a17';
  ctx.lineWidth = 2;
  for (const stroke of strokes) {
    ctx.beginPath();
    stroke.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }
  for (const a of arrows) {
    ctx.strokeStyle = a.class === 'causal' ? '#b5532a' : '#6f6a61';
    ctx.setLineDash(a.class === 'annotation' ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(a.from.x, a.from.y);
    ctx.lineTo(a.to.x, a.to.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const lit = new Set((drag?.targets ?? []).map((t) => `${t.nodeId}/${t.portId}/${t.side}`));
  for (const p of ports()) {
    const key = `${p.nodeId}/${p.portId}/${p.side}`;
    // While a wire is dragged, ports that will not take it dim (PRD 3.8).
    ctx.globalAlpha = drag?.intent.kind === 'wire' && !lit.has(key) ? 0.25 : 1;
    ctx.fillStyle = lit.has(key) ? '#2f7d4f' : '#3d5a80';
    ctx.beginPath();
    ctx.arc(p.at.x, p.at.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  readout.textContent = [
    `tool ${tools.active}${tools.active !== tools.selected ? ` (stylus; ${tools.selected} on lift)` : ''}`,
    `text ${tools.textVariant} · palms refused ${palms}`,
    `edges ${doc.edges.size} · strokes ${strokes.length} · arrows ${arrows.length}`,
    lastOutcome ? `last: ${lastOutcome}` : 'V P W C T, Shift T',
  ].join('\n');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** The drawn scene, minus timings: what a tool switch must not change. */
function sceneSignature(): string {
  if (!lastScene) return '';
  const { quads, tiles, dom, edges, lod } = lastScene;
  return JSON.stringify({ quads, tiles, dom, edges, lod });
}

declare global {
  interface Window {
    __tools?: {
      state: () => { active: string; selected: string; text: string; palms: number; drag: DragIntent | null; targets: PortRef[] };
      scene: () => string;
      doc: () => { edges: Array<{ from: string; to: string; class: string }>; nodes: Array<{ id: string; binding: string; x: number; y: number }> };
      outcome: () => string;
      counts: () => { strokes: number; arrows: number; causalEditorFor: string | null };
      portAt: (nodeId: string, portId: string) => Vec2;
    };
  }
}
window.__tools = {
  state: () => ({
    active: tools.active,
    selected: tools.selected,
    text: tools.textVariant,
    palms,
    drag: drag?.intent ?? null,
    targets: drag?.targets ?? [],
  }),
  scene: sceneSignature,
  doc: () => ({
    edges: [...doc.edges.values()].map((e) => ({ from: `${e.from.nodeId}/${e.from.portId}`, to: `${e.to.nodeId}/${e.to.portId}`, class: e.class })),
    nodes: [...doc.nodes.values()].map((n) => ({ id: n.id, binding: n.binding, x: n.position.x, y: n.position.y })),
  }),
  outcome: () => lastOutcome,
  counts: () => ({ strokes: strokes.length, arrows: arrows.length, causalEditorFor }),
  portAt: (nodeId, portId) => {
    const p = ports().find((q) => q.nodeId === nodeId && q.portId === portId);
    if (!p) throw new Error(`no port ${nodeId}/${portId}`);
    return p.at;
  },
};
