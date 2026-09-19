/**
 * Ink on the GPU path, and the measurement Phase 5 exits on.
 *
 * > Ink-to-screen p95 under 12ms — Appendix B, phase 5
 * > Ink stroke to screen: 6ms p50, 12ms p95, 20ms hard ceiling. *This is the
 * > one users feel most.* — PRD 7.1
 *
 * The page does two jobs. Drawn on, it is the ink path as an analyst meets it:
 * pointer events in, capsules out, one instanced draw call over whatever the
 * scene already holds. Driven by `scripts/inkgl-shots.mjs`, it replays a
 * synthetic stylus session and reports the distribution of the per-event path
 * so the exit criterion is a number rather than a claim.
 *
 * What the number covers, because the honest reading depends on it: from the
 * pointer samples being in hand, through tessellation, buffer upload and the
 * draw call, to `gl.finish()` returning. What it does not cover is the browser
 * delivering the event and the compositor putting the frame on the glass —
 * neither is reachable from script, and neither is this code's to fix. So the
 * figure is a floor on ink-to-screen and a ceiling on the part Picasso wrote.
 */

import { type Viewport } from '@picasso/canvas-core';
import { buildScene, lightTheme, type Scene } from '@picasso/canvas-render';
import { GLRenderer, createContext, type FrameStats } from '@picasso/canvas-gl';
import { InkRibbon, StrokeBuilder, type InkPoint, type RibbonStyle } from '@picasso/canvas-ink';
import { buildDemoCanvas } from './fixture.js';

const params = new URLSearchParams(location.search);
const theme = lightTheme;

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

const { doc, index, wash, bounds } = buildDemoCanvas(Number(params.get('nodes') ?? 24));
const renderer = new GLRenderer(gl);

const INK_STYLE: RibbonStyle = { rgba: [0.11, 0.1, 0.09, 1], width: 3.2 };

/**
 * Two ribbons, not one.
 *
 * Committed strokes change only when a pen lifts; the live stroke changes on
 * every event. Keeping them apart means the live path uploads the live stroke
 * alone, and a canvas with four hundred strokes on it does not re-upload all of
 * them to add a millimetre to the four hundred and first. They are drawn in two
 * calls rather than one, which is the trade: one more draw call, bounded, in
 * exchange for an upload that does not grow with the canvas.
 */
const committed = new InkRibbon(4096);
let live = new InkRibbon(1024);
let builder: StrokeBuilder | null = null;
let strokeSeq = 0;

let viewport: Viewport = {
  x: bounds.minX - 40,
  y: bounds.minY - 40,
  scale: 0.5,
  width: 0,
  height: 0,
};
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

function sceneNow(now: number): Scene {
  return buildScene({ doc, index, viewport, theme, now, wash });
}

/**
 * One frame: the scene, then committed ink, then the live stroke.
 *
 * The renderer takes the ink buffer as an argument rather than reading it, so
 * two ribbons are two calls to the same method and nothing in `canvas-gl` has
 * to know that a live stroke is a different kind of thing from a settled one.
 */
function drawOnce(now: number): FrameStats {
  const scene = sceneNow(now);
  const first = renderer.render(scene, theme, committed.view());
  if (live.segments === 0) return first;
  const second = renderer.render(emptyOver(scene), theme, live.view());
  return {
    ...first,
    drawCalls: first.drawCalls + second.drawCalls,
    inkInstances: first.inkInstances + second.inkInstances,
    uploadedBytes: first.uploadedBytes + second.uploadedBytes,
    cpuMs: first.cpuMs + second.cpuMs,
  };
}

/**
 * The same viewport with nothing in it.
 *
 * The second pass draws only the live stroke, and the renderer clears at the
 * top of every frame — so the overlay has to carry an empty scene, or the first
 * pass is wiped off the screen before the ink lands on it.
 */
function emptyOver(scene: Scene): Scene {
  return { ...scene, quads: [], tiles: [], dom: [], edges: [] };
}

function pointFrom(event: PointerEvent, at: number): InkPoint {
  return {
    x: event.clientX,
    y: event.clientY,
    pressure: event.pressure > 0 ? event.pressure : 0.5,
    t: at,
  };
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  builder = new StrokeBuilder(`s${strokeSeq++}`, { width: INK_STYLE.width });
  live = new InkRibbon(1024);
  const samples = [pointFrom(event, event.timeStamp)];
  builder.append(samples);
  live.append(builder.current.id, samples, INK_STYLE);
});

canvas.addEventListener('pointermove', (event) => {
  if (!builder) return;
  // The coalesced batch, not the event's own coordinates: on a 240Hz stylus at
  // 60Hz frames, taking only the event throws three samples in four away.
  const raw = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
  const samples = raw.map((e) => pointFrom(e as PointerEvent, e.timeStamp));
  builder.append(samples);
  live.append(builder.current.id, samples, INK_STYLE);
});

canvas.addEventListener('pointerup', (event) => {
  canvas.releasePointerCapture(event.pointerId);
  if (!builder) return;
  // On lift the stroke simplifies, so the committed ribbon is tessellated from
  // the simplified points rather than from the raw capture — the live ribbon is
  // discarded rather than moved across.
  const stroke = builder.commit();
  committed.append(stroke.id, pointsOf(stroke.runs), INK_STYLE);
  committed.end(stroke.id);
  live = new InkRibbon(1024);
  builder = null;
});

function pointsOf(runs: ReadonlyArray<{ points: InkPoint[] }>): InkPoint[] {
  const out: InkPoint[] = [];
  for (const run of runs) out.push(...run.points);
  return out;
}

const frameTimes: number[] = [];
let lastStats: FrameStats | null = null;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

function frame(now: number): void {
  const started = performance.now();
  const stats = drawOnce(now);
  gl.finish();
  frameTimes.push(performance.now() - started);
  if (frameTimes.length > 240) frameTimes.shift();
  lastStats = stats;

  hud.textContent = [
    `ink ${stats.inkInstances} capsules · ${committed.segments} committed · ${live.segments} live`,
    `draw calls ${stats.drawCalls} · uploaded ${(stats.uploadedBytes / 1024).toFixed(1)}KB`,
    `frame p50 ${percentile(frameTimes, 0.5).toFixed(2)}ms · p95 ${percentile(frameTimes, 0.95).toFixed(2)}ms`,
    'budget: 6ms p50 / 12ms p95 / 20ms ceiling',
  ].join('\n');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// The harness surface
// ---------------------------------------------------------------------------

export interface SessionReport {
  events: number;
  samples: number;
  capsules: number;
  drawCalls: number;
  /** Tessellation alone: the append into the ribbon. */
  tessellate: { p50: number; p95: number; max: number };
  /** Append, upload, draw, and `gl.finish()`. */
  toScreen: { p50: number; p95: number; p99: number; max: number; worstAt: number };
  /** The first event's cost, which pays for buffer growth and a cold pipeline. */
  firstEventMs: number;
  /**
   * Mean per-event cost early in the stroke and late in it.
   *
   * The ratio is the architectural claim: appending is O(1) in the samples
   * appended, not in the stroke's length. A renderer that re-tessellates passes
   * every correctness check and fails here.
   */
  growth: { earlyMs: number; lateMs: number; ratio: number };
}

/**
 * Replay a stylus session and report the distribution.
 *
 * The stroke is a long, slow spiral rather than a scribble: it keeps the pen on
 * screen, covers a realistic area, and grows monotonically, which is what makes
 * a per-event cost that scales with stroke length show up. A session that draws
 * twenty short strokes would hide exactly the failure this is looking for.
 */
function runSession(events: number, perEvent: number): SessionReport {
  committed.clear();
  live = new InkRibbon(events * perEvent + 16);
  const id = 'harness';
  const tess: number[] = [];
  const screen: number[] = [];
  let drawCalls = 0;

  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const radius = Math.min(cx, cy) * 0.8;

  for (let e = 0; e < events; e += 1) {
    const samples: InkPoint[] = [];
    for (let s = 0; s < perEvent; s += 1) {
      const k = e * perEvent + s;
      const turns = (k / (events * perEvent)) * Math.PI * 14;
      const r = radius * (0.12 + 0.88 * (k / (events * perEvent)));
      samples.push({
        x: cx + Math.cos(turns) * r,
        y: cy + Math.sin(turns) * r,
        pressure: 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(k * 0.03)),
        t: e * 16.6 + s * 4.16,
      });
    }

    const t0 = performance.now();
    live.append(id, samples, INK_STYLE);
    const t1 = performance.now();
    const stats = renderer.render(sceneNow(t1), theme, live.view());
    gl.finish();
    const t2 = performance.now();

    tess.push(t1 - t0);
    screen.push(t2 - t0);
    drawCalls = stats.drawCalls;
  }

  const summary = (xs: number[]) => ({
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    max: Math.max(...xs),
  });

  const worst = Math.max(...screen);
  // The first fifty events are pipeline warm-up and buffer growth, not stroke
  // length, so the "early" window starts after them.
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const earlyMs = mean(screen.slice(50, 150));
  const lateMs = mean(screen.slice(Math.max(0, screen.length - 100)));

  return {
    events,
    samples: events * perEvent,
    capsules: live.segments,
    drawCalls,
    tessellate: summary(tess),
    toScreen: {
      ...summary(screen),
      p99: percentile(screen, 0.99),
      worstAt: screen.indexOf(worst),
    },
    firstEventMs: screen[0] ?? 0,
    growth: { earlyMs, lateMs, ratio: earlyMs === 0 ? 1 : lateMs / earlyMs },
  };
}

declare global {
  interface Window {
    __inkgl?: {
      stats: () => FrameStats | null;
      /** Replays a synthetic stylus session and reports the distribution. */
      session: (events?: number, perEvent?: number) => SessionReport;
      /** Draws one known stroke and reports points on it and beside it. */
      strokeProbe: () => {
        on: { x: number; y: number };
        off: { x: number; y: number };
        geometry: { width: number; radius: number; pad: number; corner: number };
      };
      probe: (x: number, y: number) => [number, number, number, number];
      clear: () => void;
    };
  }
}

window.__inkgl = {
  stats: () => lastStats,
  session: (events = 600, perEvent = 4) => runSession(events, perEvent),
  strokeProbe: () => {
    committed.clear();
    live = new InkRibbon(64);

    // A fat nib on purpose. The instance quad is the segment's bounding box
    // padded by half the width plus two, so a thin stroke's quad hugs the
    // capsule and a probe outside the capsule is outside the quad too — which
    // would pass whatever the fragment shader does. At 60px the quad reaches
    // 32px past the end and the capsule only 30, leaving a corner that is
    // inside the instance and outside the ink. That corner is the whole test:
    // a shader that fills its quad paints it, and a shader that solves the
    // distance does not.
    const WIDTH = 60;
    const RADIUS = WIDTH / 2;
    const PAD = RADIUS + 2;
    const CORNER = 24; // inside PAD, and sqrt(2)*24 = 33.9 outside RADIUS

    const y = Math.round(viewport.height * 0.5);
    const x0 = Math.round(viewport.width * 0.3);
    const x1 = Math.round(viewport.width * 0.7);
    const points: InkPoint[] = [];
    for (let i = 0; i <= 40; i += 1) {
      points.push({ x: x0 + ((x1 - x0) * i) / 40, y, pressure: 1, t: i });
    }
    committed.append('probe', points, { rgba: [0, 0, 0, 1], width: WIDTH });
    committed.end('probe');

    return {
      on: { x: Math.round((x0 + x1) / 2), y },
      off: { x: x0 - CORNER, y: y - CORNER },
      geometry: { width: WIDTH, radius: RADIUS, pad: PAD, corner: CORNER },
    };
  },
  probe: (x, y) => {
    drawOnce(performance.now());
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.round(x * dpr),
      Math.round((viewport.height - y) * dpr),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    return [pixel[0] as number, pixel[1] as number, pixel[2] as number, pixel[3] as number];
  },
  clear: () => {
    committed.clear();
    live = new InkRibbon(1024);
    builder = null;
  },
};
