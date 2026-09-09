/**
 * The WebGL2 path, on the same scene the Canvas2D painter draws.
 *
 * Same document, same index, same `buildScene` — only the painter changes. That
 * is the point of keeping the renderer a draw list: the two paths are
 * comparable because nothing above them knows which one is running.
 */

import {
  LodTracker,
  panBy,
  stepMomentum,
  zoomAt,
  type Vec2,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, darkTheme, lightTheme } from '@picasso/canvas-render';
import { GLRenderer, createContext, type FrameStats } from '@picasso/canvas-gl';
import { buildDemoCanvas } from './fixture.js';

const params = new URLSearchParams(location.search);
const nodeCount = Number(params.get('nodes') ?? 5_000);
const startScale = Number(params.get('scale') ?? 0.06);
const theme = params.get('theme') === 'dark' ? darkTheme : lightTheme;

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

const gl = mustGetContext();

function mustGetContext(): WebGL2RenderingContext {
  const context = createContext(canvas);
  if (!context) {
    hud.textContent = 'WebGL2 unavailable';
    throw new Error('WebGL2 unavailable');
  }
  return context;
}

const { doc, index, wash, bounds } = buildDemoCanvas(nodeCount);
const renderer = new GLRenderer(gl);

let viewport: Viewport = {
  x: bounds.minX - 60,
  y: bounds.minY - 60,
  scale: startScale,
  width: 0,
  height: 0,
};
const lodTracker = new LodTracker(viewport.scale, 0);
let dpr = 1;

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  viewport = { ...viewport, width, height };
}
window.addEventListener('resize', resize);
resize();

let dragging = false;
let last: Vec2 | null = null;
let velocity: Vec2 | null = null;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  velocity = null;
  last = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging || !last) return;
  const dx = event.clientX - last.x;
  const dy = event.clientY - last.y;
  viewport = panBy(viewport, dx, dy);
  velocity = { x: dx, y: dy };
  last = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
  dragging = false;
  last = null;
  canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    viewport = zoomAt(viewport, { x: event.clientX, y: event.clientY }, Math.exp(-event.deltaY * 0.0015));
  },
  { passive: false },
);

/**
 * The device pixel ratio lives in the GL viewport, not in the scene: the scene
 * works in CSS pixels and the drawing buffer is scaled, so the shader's
 * `u_resolution` is the CSS size and the buffer is simply larger.
 */
function drawOnce(now: number): FrameStats {
  const scene = buildScene({ doc, index, viewport, theme, now, wash });
  return renderer.render(scene, theme);
}

const frameTimes: number[] = [];
let lastStats: FrameStats | null = null;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

function frame(now: number): void {
  if (!dragging && velocity) {
    velocity = stepMomentum(velocity);
    if (velocity) viewport = panBy(viewport, velocity.x, velocity.y);
  }

  const started = performance.now();
  const stats = drawOnce(now);
  // Flushing makes the measurement include the driver's work rather than
  // stopping at the queue, which on a software rasterizer is most of it.
  gl.finish();
  const elapsed = performance.now() - started;

  lastStats = stats;
  frameTimes.push(elapsed);
  if (frameTimes.length > 240) frameTimes.shift();

  const lod = lodTracker.update(viewport.scale, now);
  hud.textContent = [
    `${stats.nodeInstances} node instances · ${stats.edgeInstances} edge instances`,
    `draw calls ${stats.drawCalls} · uploaded ${(stats.uploadedBytes / 1024).toFixed(0)}KB`,
    `zoom ${viewport.scale.toFixed(3)} · LOD${lod} · pack ${stats.packMs.toFixed(2)}ms`,
    `frame p50 ${percentile(frameTimes, 0.5).toFixed(2)}ms · p95 ${percentile(frameTimes, 0.95).toFixed(2)}ms`,
  ].join('\n');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

declare global {
  interface Window {
    __gl?: {
      stats: () => FrameStats | null;
      timings: () => { p50: number; p95: number; samples: number };
      reset: () => void;
      /** Renders and reads one pixel back, to prove the shaders drew something. */
      probe: (x: number, y: number) => [number, number, number, number];
      /** Screen centre and expected fill of a drawn node, for that probe. */
      sampleNode: () => { x: number; y: number; fill: string } | null;
      setViewport: (next: Partial<Viewport>) => void;
    };
  }
}
window.__gl = {
  stats: () => lastStats,
  timings: () => ({
    p50: percentile(frameTimes, 0.5),
    p95: percentile(frameTimes, 0.95),
    samples: frameTimes.length,
  }),
  reset: () => {
    frameTimes.length = 0;
  },
  sampleNode: () => {
    const scene = buildScene({ doc, index, viewport, theme, now: performance.now(), wash });
    const node = [...scene.dom, ...scene.tiles, ...scene.quads].find((n) => {
      const r = n.screenRect;
      // The scene includes the cull margin, which is off-screen and therefore
      // outside the drawing buffer: a probe there reads nothing at all.
      // Require a margin from the edges too, so the probe lands on fill rather
      // than on the antialiased border.
      const inset = 12;
      return (
        n.wash === undefined &&
        r.minX > inset &&
        r.minY > inset &&
        r.maxX < viewport.width - inset &&
        r.maxY < viewport.height - inset &&
        r.maxX - r.minX > inset * 4 &&
        r.maxY - r.minY > inset * 4
      );
    });
    if (!node) return null;
    const r = node.screenRect;
    return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2, fill: node.style.fill };
  },
  probe: (x, y) => {
    // Draw, then read back in the same task: without preserveDrawingBuffer the
    // contents are only guaranteed until the frame is presented.
    drawOnce(performance.now());
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.round(x * dpr),
      // readPixels has its origin at the bottom left.
      Math.round((viewport.height - y) * dpr),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    return [pixel[0] as number, pixel[1] as number, pixel[2] as number, pixel[3] as number];
  },
  setViewport: (next) => {
    viewport = { ...viewport, ...next };
  },
};
