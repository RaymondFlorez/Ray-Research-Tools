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
  readBook,
  type Cell,
  type GridResult,
  type Leg,
  type Market,
} from '@picasso/canvas-pricing';

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
    `value at spot        ${fmt(centre.value)}`,
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

/**
 * Diverging fill around zero P&L.
 *
 * Around zero rather than around the midpoint of the range: an analyst reads
 * this surface to find where the book stops making money, and a ramp whose
 * neutral point floats with the data hides exactly that line.
 */
function fill(value: number, scale: number): string {
  const t = Math.max(-1, Math.min(1, value / scale));
  if (t >= 0) return `rgb(${Math.round(247 - 70 * t)}, ${Math.round(249 - 40 * t)}, ${Math.round(244 - 120 * t)})`;
  return `rgb(${Math.round(247 + 8 * -t)}, ${Math.round(249 - 90 * -t)}, ${Math.round(244 - 100 * -t)})`;
}

function draw(result: GridResult): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 64, right: 16, top: 16, bottom: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const cw = plotW / result.spotCount;
  const ch = plotH / result.volCount;

  const scale = Math.max(...result.cells.map((c) => Math.abs(c.value))) || 1;

  for (let si = 0; si < result.spotCount; si += 1) {
    for (let vi = 0; vi < result.volCount; vi += 1) {
      const cell: Cell = result.cell(si, vi);
      const x = pad.left + si * cw;
      // Vol increases upward, which is how a surface is read.
      const y = pad.top + (result.volCount - 1 - vi) * ch;
      ctx.fillStyle = fill(cell.value, scale);
      ctx.fillRect(x, y, cw + 0.5, ch + 0.5);

      if (cell.exact) {
        // The guard escalated this cell. Marked, because "which numbers did
        // you actually compute exactly" is a question an analyst will ask.
        ctx.fillStyle = 'rgba(28,26,23,0.55)';
        ctx.beginPath();
        ctx.arc(x + cw / 2, y + ch / 2, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#6f6a61';

  ctx.textAlign = 'center';
  for (let si = 0; si < result.spotCount; si += 4) {
    ctx.fillText((result.spotAxis[si] as number).toFixed(0), pad.left + (si + 0.5) * cw, height - 24);
  }
  ctx.fillText('spot', pad.left + plotW / 2, height - 8);

  ctx.textAlign = 'right';
  for (let vi = 0; vi < result.volCount; vi += 2) {
    const shift = (result.volAxis[vi] as number) * 100;
    const y = pad.top + (result.volCount - 1 - vi + 0.5) * ch + 3;
    ctx.fillText(`${shift > 0 ? '+' : ''}${shift.toFixed(0)}`, pad.left - 8, y);
  }

  // The unshocked column, so the eye has somewhere to start.
  const centreCol = (result.spotCount - 1) >> 1;
  ctx.strokeStyle = 'rgba(28,26,23,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left + centreCol * cw, pad.top, cw, plotH);
}

picker.addEventListener('change', compute);
decay.addEventListener('input', compute);
window.addEventListener('resize', () => { if (latest) draw(latest); });
compute();

// The harness reads these rather than scraping the DOM.
Object.assign(window as unknown as Record<string, unknown>, {
  __payoff: () => latest,
  __recompute: compute,
});
