/**
 * The pricing core, running in a browser, driving a node on the canvas.
 *
 * This is where the layers meet: a `StrategyNode` from `@picasso/canvas-core`
 * holds the book, `@picasso/canvas-pricing` reprices it through the same Rust
 * the server runs, and the surface is drawn from the cells that came back out
 * of WASM linear memory.
 *
 * The badge under the title is the guard's, not this file's. When it says the
 * approximation held, that is a measurement; when it says a region was
 * escalated, cells drawn with a dot are the ones repriced on the lattice.
 */

import {
  GridPricer,
  Pricer,
  atTheMoney,
  createStrategyNode,
  evaluateStrategy,
  instantiatePricing,
  pnlSurface,
  readBook,
  type GridResult,
  type Leg,
  type Market,
} from '@picasso/canvas-pricing';
import {
  contour,
  frontDepth,
  heatmapCells,
  heatmapPick,
  heatmapPoint,
  orbit,
  project,
  surfaceColor,
  surfaceMesh,
  surfacePick,
  worldPoint,
  zDomain,
  type Camera,
  type Picked,
  type SurfaceGrid,
} from '@picasso/canvas-render';

const WASM_URL = '/crates/pricing-core/target/wasm32-unknown-unknown/release/pricing_core.wasm';

const market: Market = { spot: 100, rate: 0.045, dividend: 0.017 };

/** Books an analyst would actually have on a canvas. */
const STRATEGIES: Record<string, { label: string; legs: Leg[] }> = {
  spread: {
    label: 'call spread, 100/110',
    legs: [
      leg({ strike: 100, kind: 'call', quantity: 20, vol: 0.28 }),
      leg({ strike: 110, kind: 'call', quantity: -20, vol: 0.26 }),
    ],
  },
  reversal: {
    label: 'risk reversal, long 110c / short 90p',
    legs: [
      leg({ strike: 110, kind: 'call', quantity: 20, vol: 0.26, style: 'american' }),
      leg({ strike: 90, kind: 'put', quantity: -20, vol: 0.31, style: 'american' }),
    ],
  },
  butterfly: {
    label: 'butterfly, 90/100/110',
    legs: [
      leg({ strike: 90, kind: 'call', quantity: 20, vol: 0.31 }),
      leg({ strike: 100, kind: 'call', quantity: -40, vol: 0.28 }),
      leg({ strike: 110, kind: 'call', quantity: 20, vol: 0.26 }),
    ],
  },
  book: {
    label: '40-leg book, mixed exercise',
    legs: Array.from({ length: 40 }, (_, i) =>
      leg({
        strike: 80 + (i % 20) * 2.5,
        time: 0.08 + (i % 5) * 0.24,
        kind: i % 2 === 0 ? 'call' : 'put',
        // Both parities American, not just the even ones: with q below r an
        // American *call* has no early-exercise value and the fast path
        // returns the European price exactly, so a book of American calls
        // measures the guard against nothing.
        style: i % 4 < 2 ? 'american' : 'european',
        quantity: i % 3 === 0 ? -5 : 5,
        vol: 0.22 + (i % 7) * 0.02,
      }),
    ),
  },
};

function leg(partial: Partial<Leg> & Pick<Leg, 'strike' | 'kind' | 'quantity'>): Leg {
  return {
    time: 0.5,
    style: 'european',
    multiplier: 100,
    vol: 0.28,
    ...partial,
  };
}

const canvas = document.getElementById('surface') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const hud = document.getElementById('hud') as HTMLElement;
const badge = document.getElementById('badge') as HTMLElement;
const picker = document.getElementById('strategy') as HTMLSelectElement;
const decay = document.getElementById('decay') as HTMLInputElement;
const view = document.getElementById('view') as HTMLSelectElement;
const readout = document.getElementById('readout') as HTMLElement;

const exports = await instantiatePricing(fetch(WASM_URL));
const grid = new GridPricer(exports);
const scalar = new Pricer(exports);

for (const [key, { label }] of Object.entries(STRATEGIES)) {
  picker.append(new Option(label, key));
}

// `?book=reversal` opens on a named strategy, the same way the canvas demo takes
// `?nodes` and `?scale`. Useful for linking straight at a particular surface.
const requested = new URLSearchParams(location.search).get('book');
if (requested !== null && requested in STRATEGIES) picker.value = requested;

let latest: GridResult | undefined;
/** The P&L surface drawn: each cell's mark less today's. */
let surface: SurfaceGrid | undefined;
let todayMark = 0;
let camera: Camera = { azimuth: -0.6, elevation: 0.55, distance: 4, rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
let plot = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
let hovered: Picked | undefined;

function compute(): void {
  const chosen = STRATEGIES[picker.value] ?? (STRATEGIES.spread as { label: string; legs: Leg[] });
  const node = createStrategyNode({
    id: 'strategy',
    legs: chosen.legs,
    market,
    grid: { spotSteps: 25, spotRange: 0.25, volSteps: 15, volRange: 0.1, decayDays: Number(decay.value) },
  });

  const evaluation = evaluateStrategy(node, grid);
  if (!evaluation.ok) {
    badge.textContent = evaluation.message;
    return;
  }
  latest = evaluation.result;
  // Today's mark, from the engine, with no decay: the P&L is measured from it,
  // so decay shows up as the loss it is. The grid's own centre is today's mark
  // only when no decay was applied.
  todayMark = Number(decay.value) === 0
    ? atTheMoney(latest).value
    : atTheMoney(grid.reprice(chosen.legs, market, { spotSteps: 25, spotRange: 0.25, volSteps: 15, volRange: 0.1 })).value;
  surface = pnlSurface(latest, todayMark);

  const centre = atTheMoney(latest);
  const book = readBook(node);
  badge.textContent = latest.guard.badge;
  badge.dataset.outcome = latest.guard.outcome;

  // An implied vol, to show the scalar path is the same module: back out the
  // vol of the first leg from its own price and check it comes home.
  const first = book.legs[0] as Leg;
  const mark = scalar.price({
    spot: market.spot, strike: first.strike, time: first.time,
    rate: market.rate, dividend: market.dividend, vol: first.vol, kind: first.kind,
  });
  const implied = scalar.impliedVol(
    { spot: market.spot, strike: first.strike, time: first.time,
      rate: market.rate, dividend: market.dividend, kind: first.kind },
    mark,
  );

  hud.textContent = [
    `${book.legs.length} legs  ·  ${latest.cells.length} cells  ·  ` +
      `${latest.guard.repricings.toLocaleString()} repricings`,
    `wasm call            ${latest.elapsedMs.toFixed(2)}ms  / 90ms budget`,
    `mark today           ${fmt(todayMark)}`,
    `P&L at spot          ${fmt(centre.value - todayMark)}`,
    `delta / gamma        ${fmt(centre.delta)} / ${fmt(centre.gamma)}`,
    `vega / theta         ${fmt(centre.vega)} / ${fmt(centre.theta)}`,
    `front leg iv         ${implied.ok ? implied.vol.toFixed(4) : implied.display}`,
    `node status          ${node.state.status}`,
  ].join('\n');

  draw(latest);
}

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(10);
}

const rgb = (c: [number, number, number], shade = 1) =>
  `rgb(${Math.round(c[0] * shade)}, ${Math.round(c[1] * shade)}, ${Math.round(c[2] * shade)})`;

function draw(result: GridResult): void {
  if (!surface) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const pad = { left: 64, right: 16, top: 16, bottom: 40 };
  plot = { minX: pad.left, minY: pad.top, maxX: width - pad.right, maxY: height - pad.bottom };
  camera = { ...camera, rect: plot };
  const domain = zDomain(surface);
  // Around zero P&L rather than the middle of the range: the analyst reads this
  // to find where the book stops making money, and a ramp whose neutral point
  // floats with the data hides exactly that line.
  if (view.value === '3d') draw3d(surface, domain);
  else drawHeatmap(result, surface, domain);
}

function drawHeatmap(result: GridResult, grid: SurfaceGrid, domain: { min: number; max: number }): void {
  const cells = heatmapCells(grid, plot);
  for (const cell of cells) {
    const r = cell.rect;
    ctx.fillStyle = rgb(surfaceColor(cell.value, domain, 'diverging'));
    ctx.fillRect(r.minX, r.minY, r.maxX - r.minX + 0.5, r.maxY - r.minY + 0.5);
    if (result.cell(cell.i, cell.j).exact) {
      // The guard escalated this cell. Marked, because "which numbers did you
      // actually compute exactly" is a question an analyst will ask.
      ctx.fillStyle = 'rgba(28,26,23,0.55)';
      ctx.beginPath();
      ctx.arc((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Break-even.
  ctx.strokeStyle = '#1c1a17';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [a, b] of contour(grid)) {
    const p = heatmapPoint(grid, plot, a.i, a.j);
    const q = heatmapPoint(grid, plot, b.i, b.j);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();

  const cw = (plot.maxX - plot.minX) / result.spotCount;
  const ch = (plot.maxY - plot.minY) / result.volCount;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#6f6a61';
  ctx.textAlign = 'center';
  for (let si = 0; si < result.spotCount; si += 4) {
    ctx.fillText((result.spotAxis[si] as number).toFixed(0), plot.minX + (si + 0.5) * cw, plot.maxY + 16);
  }
  ctx.fillText('spot', (plot.minX + plot.maxX) / 2, plot.maxY + 32);
  ctx.textAlign = 'right';
  for (let vi = 0; vi < result.volCount; vi += 2) {
    const shift = (result.volAxis[vi] as number) * 100;
    ctx.fillText(`${shift > 0 ? '+' : ''}${shift.toFixed(0)}`, plot.minX - 8, plot.maxY - (vi + 0.5) * ch + 3);
  }
  // The unshocked column, so the eye has somewhere to start.
  const centreCol = (result.spotCount - 1) >> 1;
  ctx.strokeStyle = 'rgba(28,26,23,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.minX + centreCol * cw, plot.minY, cw, plot.maxY - plot.minY);
  if (hovered) {
    const p = heatmapPoint(grid, plot, hovered.i, hovered.j);
    ctx.strokeStyle = '#1c1a17';
    ctx.strokeRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
  }
}

function draw3d(grid: SurfaceGrid, domain: { min: number; max: number }): void {
  const mesh = surfaceMesh(grid, camera);
  ctx.lineJoin = 'round';
  for (const t of mesh) {
    const colour = rgb(surfaceColor(t.value, domain, 'diverging'), t.shade);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour; // closes the hairline seams between triangles
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(t.points[0].x, t.points[0].y);
    ctx.lineTo(t.points[1].x, t.points[1].y);
    ctx.lineTo(t.points[2].x, t.points[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // Break-even, where a ridge does not cover it.
  ctx.strokeStyle = '#1c1a17';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [a, b] of contour(grid)) {
    const p = project(camera, worldPoint(grid, domain, a.i, a.j, 0));
    const q = project(camera, worldPoint(grid, domain, b.i, b.j, 0));
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const front = frontDepth(mesh, mid);
    if (front !== undefined && front < (p.depth + q.depth) / 2 - 0.01) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  if (hovered) {
    const p = project(camera, worldPoint(grid, domain, hovered.i, hovered.j, hovered.value));
    ctx.fillStyle = '#1c1a17';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#6f6a61';
  ctx.textAlign = 'left';
  ctx.fillText('drag to turn · spot runs left to right at the front, vol shift front to back', plot.minX, plot.maxY + 32);
}

/** The grid point under a screen point, in whichever view is showing. */
function pickAt(x: number, y: number): Picked | undefined {
  if (!surface) return undefined;
  return view.value === '3d' ? surfacePick(surface, surfaceMesh(surface, camera), { x, y }) : heatmapPick(surface, plot, { x, y });
}

let dragFrom: { x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', (e) => {
  if (view.value !== '3d') return;
  dragFrom = { x: e.clientX, y: e.clientY };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // nothing to capture for a synthetic pointer
  }
});
canvas.addEventListener('pointermove', (e) => {
  const box = canvas.getBoundingClientRect();
  if (dragFrom) {
    camera = orbit(camera, e.clientX - dragFrom.x, e.clientY - dragFrom.y);
    dragFrom = { x: e.clientX, y: e.clientY };
  } else {
    hovered = pickAt(e.clientX - box.left, e.clientY - box.top);
    readout.textContent = hovered
      ? `spot ${hovered.x.toFixed(1)} · vol ${hovered.y >= 0 ? '+' : ''}${(hovered.y * 100).toFixed(0)}pts · P&L ${hovered.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'hover the surface for a cell';
  }
  if (latest) draw(latest);
});
canvas.addEventListener('pointerup', () => {
  dragFrom = undefined;
});

picker.addEventListener('change', compute);
decay.addEventListener('input', compute);
view.addEventListener('change', () => { if (latest) draw(latest); });
window.addEventListener('resize', () => { if (latest) draw(latest); });
compute();

// The harness reads these rather than scraping the DOM.
Object.assign(window as unknown as Record<string, unknown>, {
  __payoff: () => latest,
  __recompute: compute,
  __surface: () => ({
    view: view.value,
    camera: { azimuth: camera.azimuth, elevation: camera.elevation },
    todayMark,
    centrePnl: surface ? (surface.z[7 * 25 + 12] as number) : Number.NaN,
    breakEvenSegments: surface ? contour(surface).length : 0,
    pick: (x: number, y: number) => pickAt(x, y),
    /** Screen position of grid point (i, j) in the current view. */
    at: (i: number, j: number) => {
      if (!surface) return undefined;
      if (view.value !== '3d') return heatmapPoint(surface, plot, i, j);
      const p = project(camera, worldPoint(surface, zDomain(surface), i, j, surface.z[j * 25 + i] as number));
      return { x: p.x, y: p.y };
    },
  }),
});
