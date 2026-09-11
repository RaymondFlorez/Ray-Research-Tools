/**
 * Demo shell: input, the frame loop, and a HUD reporting the frame budget.
 *
 * Everything on screen comes from the canvas-core document and the
 * canvas-render draw list. The shell owns only the viewport and the input
 * handling, which is the split the shipping client keeps too.
 */

import {
  LodTracker,
  panBy,
  screenToWorld,
  stepMomentum,
  zoomAt,
  type NodeID,
  type Vec2,
  type Viewport,
} from '@picasso/canvas-core';
import {
  DomMountManager,
  buildScene,
  darkTheme,
  lightTheme,
  onScreenNodes,
  type Scene,
} from '@picasso/canvas-render';
import { buildDemoCanvas } from './fixture.js';
import { drawScene } from './draw.js';

const params = new URLSearchParams(location.search);
const nodeCount = Number(params.get('nodes') ?? 2_000);
const startScale = Number(params.get('scale') ?? 0.75);
const theme = params.get('theme') === 'dark' ? darkTheme : lightTheme;
/** Screenshot mode: fixed clock so a capture is byte-stable. */
const frozenNow = params.has('now') ? Number(params.get('now')) : undefined;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const ctx = mustGetContext(canvas);

function mustGetContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas2D unavailable');
  return context;
}

const { doc, index, wash, bounds } = buildDemoCanvas(nodeCount);
const mounts = new DomMountManager();
const selection = new Set<NodeID>();

let viewport: Viewport = {
  x: bounds.minX - 80,
  y: bounds.minY - 80,
  scale: startScale,
  width: 0,
  height: 0,
};
let lodTracker = new LodTracker(viewport.scale, 0);
let dpr = 1;

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewport = { ...viewport, width: w, height: h };
}
window.addEventListener('resize', resize);
resize();

// Pan: drag anywhere. Zoom: wheel, cursor-anchored.
let dragging = false;
let last: Vec2 | null = null;
let velocity: Vec2 | null = null;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  velocity = null;
  last = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !last) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  viewport = panBy(viewport, dx, dy);
  velocity = { x: dx, y: dy };
  last = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  last = null;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    viewport = zoomAt(viewport, { x: e.clientX, y: e.clientY }, factor);
  },
  { passive: false },
);

// Click selects the topmost node under the cursor.
canvas.addEventListener('click', (e) => {
  const world = screenToWorld(viewport, { x: e.clientX, y: e.clientY });
  const hit = index.hit(doc, world);
  selection.clear();
  if (hit) selection.add(hit.id);
});

window.addEventListener('keydown', (e) => {
  const jumps: Record<string, number> = { '0': 0.08, '1': 0.3, '2': 0.75, '3': 2.5 };
  const target = jumps[e.key];
  if (target !== undefined) {
    viewport = zoomAt(
      viewport,
      { x: viewport.width / 2, y: viewport.height / 2 },
      target / viewport.scale,
    );
  }
});

const frameTimes: number[] = [];
let lastScene: Scene | null = null;

function frame(timestamp: number): void {
  const started = performance.now();

  if (!dragging && velocity) {
    velocity = stepMomentum(velocity);
    if (velocity) viewport = panBy(viewport, velocity.x, velocity.y);
  }

  const now = frozenNow ?? timestamp;
  const scene = buildScene({
    doc,
    index,
    viewport,
    theme,
    now,
    wash,
    selection,
  });
  lastScene = scene;

  const lod = lodTracker.update(viewport.scale, now);
  const onScreen = new Set(onScreenNodes(index, viewport));
  mounts.update(
    [...scene.quads, ...scene.tiles, ...scene.dom].map((n) => ({
      id: n.id,
      lod: n.lod,
      visible: onScreen.has(n.id),
    })),
    now,
  );

  drawScene(ctx, scene, { theme, now, dpr });

  const elapsed = performance.now() - started;
  frameTimes.push(elapsed);
  if (frameTimes.length > 60) frameTimes.shift();
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  hud.textContent = [
    `nodes ${scene.stats.nodesTotal} · drawn ${scene.stats.nodesDrawn} · culled ${scene.stats.nodesCulled}`,
    `edges ${scene.stats.edgesTotal} · drawn ${scene.stats.edgesDrawn}`,
    `zoom ${viewport.scale.toFixed(3)} · LOD${lod} (committed) · scene ${scene.stats.buildMs.toFixed(2)}ms`,
    `frame p50 ${p50.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms · would-mount ${mounts.mounted.size}`,
  ].join('\n');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed so the screenshot harness can assert on what was actually drawn.
declare global {
  interface Window {
    __picasso?: {
      stats: () => Scene['stats'] | null;
      lod: () => number;
      mounted: () => number;
      setViewport: (next: Partial<Viewport>) => void;
    };
  }
}
window.__picasso = {
  stats: () => lastScene?.stats ?? null,
  lod: () => lodTracker.value,
  mounted: () => mounts.mounted.size,
  setViewport: (next) => {
    viewport = { ...viewport, ...next };
    lodTracker = new LodTracker(viewport.scale, 0);
  },
};
