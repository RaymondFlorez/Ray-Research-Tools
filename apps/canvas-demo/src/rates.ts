/**
 * The rate branch, end to end (PRD 5.3, and the walkthrough at 7.4).
 *
 * "pricing-core rebuilds the curve, applies Maya's bear-flattener, maps to each
 * underlying via empirical beta-to-rates (the node shows R-squared per name;
 * NVDA's is 0.31 over the trailing two years, AVGO's is 0.11, and the node says
 * so plainly rather than pretending both are reliable), maps to vol via the
 * historical shock-to-vol relationship, then reprices all 40 legs across a
 * 25x15 spot-vol grid."
 *
 * That paragraph is this page. Every number on it is computed here, in the
 * browser, through the same Rust the server runs — the curve bootstrap, the
 * shock, the regressions, and forty legs of options.
 *
 * The two names are deliberately unequal. One relationship is worth using and
 * the other is barely there, and the page has to make that visible rather than
 * drawing two equally confident lines.
 */

import {
  BondAnalytics,
  CurveEngine,
  GridPricer,
  fitSensitivity,
  instantiatePricing,
  transmit,
  weakMappings,
  type Curve,
  type CurveShock,
  type Instrument,
  type Leg,
  type Market,
  type Sensitivity,
} from '@picasso/canvas-pricing';

const WASM_URL = new URL(
  '../../../crates/pricing-core/target/wasm32-unknown-unknown/release/pricing_core.wasm',
  import.meta.url,
).href;

/** A USD curve: cash at the front, futures through the first year, swaps beyond. */
const QUOTES: Instrument[] = [
  { kind: 'deposit', maturity: 0.0833, rate: 0.0533 },
  { kind: 'deposit', maturity: 0.25, rate: 0.0528 },
  { kind: 'deposit', maturity: 0.5, rate: 0.0515 },
  { kind: 'future', start: 0.5, end: 0.75, rate: 0.0496, convexityBps: 0.4 },
  { kind: 'future', start: 0.75, end: 1.0, rate: 0.0471, convexityBps: 0.7 },
  { kind: 'swap', maturity: 2, rate: 0.0428 },
  { kind: 'swap', maturity: 3, rate: 0.0401 },
  { kind: 'swap', maturity: 5, rate: 0.0388 },
  { kind: 'swap', maturity: 7, rate: 0.0387 },
  { kind: 'swap', maturity: 10, rate: 0.0392 },
  { kind: 'swap', maturity: 20, rate: 0.0407 },
  { kind: 'swap', maturity: 30, rate: 0.0396 },
];

interface Name {
  ticker: string;
  spot: number;
  dividend: number;
  /** Percent spot move per 100bp, before noise. */
  beta: number;
  /** Vol points per 100bp. */
  volBeta: number;
  /** Width of the residual, which is what sets the R-squared. */
  noise: number;
  legs: Leg[];
}

/**
 * Two names, one of which the regression can explain and one of which it
 * cannot. The asymmetry is the point of the page.
 */
const NAMES: Name[] = [
  { ticker: 'NVDA', spot: 178, dividend: 0.0004, beta: -4.0, volBeta: -1.6, noise: 0.0072, legs: book(178, 20) },
  { ticker: 'AVGO', spot: 242, dividend: 0.0102, beta: -2.5, volBeta: -0.7, noise: 0.0085, legs: book(242, 20) },
];

/** A spread-heavy book of `count` legs around a spot. */
function book(spot: number, count: number): Leg[] {
  return Array.from({ length: count }, (_, i) => ({
    strike: Math.round(spot * (0.85 + (i % 8) * 0.045)),
    time: 0.12 + (i % 4) * 0.3,
    kind: i % 2 === 0 ? ('call' as const) : ('put' as const),
    style: i % 3 === 0 ? ('american' as const) : ('european' as const),
    quantity: i % 3 === 0 ? -8 : 6,
    multiplier: 100,
    vol: 0.31 + (i % 5) * 0.018,
  }));
}

/**
 * Two years of daily observations, generated from a fixed seed.
 *
 * Synthetic, and labelled as such on the page. What it is standing in for is a
 * real regression against real history; what it demonstrates for now is that
 * the estimator recovers a beta it was given, and reports honestly how much of
 * the variance it actually explains.
 */
function history(name: Name): { rateChangesBps: number[]; returns: number[]; volChanges: number[] } {
  let seed = 20240805;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  const rateChangesBps: number[] = [];
  const returns: number[] = [];
  const volChanges: number[] = [];
  for (let day = 0; day < 504; day += 1) {
    const move = random() * 12;
    rateChangesBps.push(move);
    returns.push((name.beta / 100 / 100) * move + random() * name.noise);
    volChanges.push((name.volBeta / 100 / 100) * move + random() * name.noise * 0.6);
  }
  return { rateChangesBps, returns, volChanges };
}

const canvas = document.getElementById('chart') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const shapePicker = document.getElementById('shape') as HTMLSelectElement;
const bpsSlider = document.getElementById('bps') as HTMLInputElement;
const pivotSlider = document.getElementById('pivot') as HTMLInputElement;
const bpsLabel = document.getElementById('bps-value') as HTMLElement;
const pivotLabel = document.getElementById('pivot-value') as HTMLElement;
const curveBadge = document.getElementById('curve-badge') as HTMLElement;
const chain = document.getElementById('chain') as HTMLElement;
const assumptionList = document.getElementById('assumptions') as HTMLElement;
const totals = document.getElementById('totals') as HTMLElement;

const exports = await instantiatePricing(fetch(WASM_URL));
const curves = new CurveEngine(exports);
const grid = new GridPricer(exports);
const bonds = new BondAnalytics(exports, curves);

const sensitivities = new Map<string, Sensitivity>();
for (const name of NAMES) {
  const fitted = fitSensitivity({ underlier: name.ticker, ...history(name), window: ['2024-09-06', '2026-09-06'] });
  if (fitted) sensitivities.set(name.ticker, fitted);
}

const GRID = { spotSteps: 25, spotRange: 0.2, volSteps: 15, volRange: 0.1, quality: 'draft' as const };
const PRICING_TENOR = 1;

interface Snapshot {
  base: Curve;
  shocked: Curve;
  shock: CurveShock;
  rateMoveBps: number;
  elapsedMs: number;
  rows: Array<{
    ticker: string;
    spotMovePct: number;
    volShift: number;
    before: number;
    after: number;
    deltaBefore: number;
    deltaAfter: number;
  }>;
  assumptions: string[];
  weak: string[];
  dv01: number;
}

let latest: Snapshot | undefined;

function compute(): void {
  const shock: CurveShock = {
    shape: shapePicker.value as CurveShock['shape'],
    bps: Number(bpsSlider.value),
    pivot: Number(pivotSlider.value),
  };
  bpsLabel.textContent = `${shock.bps}bp`;
  pivotLabel.textContent = `${shock.pivot}y`;

  const started = performance.now();
  const base = curves.bootstrap(QUOTES);
  const shocked = curves.shocked(QUOTES, shock);
  const worst = base.worstResidualBps();
  curveBadge.textContent =
    worst < 1e-6
      ? `bootstrapped — reprices all ${QUOTES.length} quotes`
      : `bootstrapped — worst quote off by ${worst.toFixed(2)}bp`;

  const rows: Snapshot['rows'] = [];
  const assumptions: string[] = [];
  let rateMoveBps = 0;

  for (const name of NAMES) {
    const market: Market = { spot: name.spot, rate: base.zero(PRICING_TENOR), dividend: name.dividend };
    const sensitivity = sensitivities.get(name.ticker);
    const moved = transmit(market, base, shocked, sensitivity, { pricingTenor: PRICING_TENOR });
    rateMoveBps = moved.rateMoveBps;
    assumptions.push(...moved.assumptions);

    const before = grid.reprice(name.legs, market, GRID);
    const shiftedLegs = name.legs.map((leg) => ({
      ...leg,
      vol: Math.max(0.01, leg.vol + moved.volShift),
    }));
    const after = grid.reprice(shiftedLegs, moved.market, GRID);
    const centre = (g: typeof before) => g.cell((g.spotCount - 1) >> 1, (g.volCount - 1) >> 1);

    rows.push({
      ticker: name.ticker,
      spotMovePct: moved.spotMovePct,
      volShift: moved.volShift,
      before: centre(before).value,
      after: centre(after).value,
      deltaBefore: centre(before).delta,
      deltaAfter: centre(after).delta,
    });
  }

  // A ten-year par bond's DV01 off the same curve, so the rates leg of the book
  // has a number too.
  const tenYear = Array.from({ length: 20 }, (_, i): [number, number] => [
    0.5 * (i + 1),
    i === 19 ? 103.92 : 1.96,
  ]);
  const metrics = bonds.yieldMetrics(tenYear, 100, 2);

  latest = {
    base,
    shocked,
    shock,
    rateMoveBps,
    elapsedMs: performance.now() - started,
    rows,
    assumptions,
    weak: weakMappings([...sensitivities.values()]),
    dv01: metrics?.dv01 ?? 0,
  };

  render(latest);
}

function fmt(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function render(snapshot: Snapshot): void {
  const totalBefore = snapshot.rows.reduce((sum, r) => sum + r.before, 0);
  const totalAfter = snapshot.rows.reduce((sum, r) => sum + r.after, 0);
  const pnl = totalAfter - totalBefore;

  chain.textContent = [
    `curve            ${snapshot.rateMoveBps >= 0 ? '+' : ''}${snapshot.rateMoveBps.toFixed(1)}bp at ${PRICING_TENOR}y`,
    ...snapshot.rows.flatMap((r) => [
      `${r.ticker} spot       ${(r.spotMovePct * 100).toFixed(2)}%`,
      `${r.ticker} vol        ${(r.volShift * 100).toFixed(2)} pts`,
    ]),
    `10y bond DV01    ${snapshot.dv01.toFixed(4)} per 100`,
    `reprice          ${snapshot.elapsedMs.toFixed(0)}ms  ·  40 legs  ·  2 grids`,
  ].join('\n');

  assumptionList.replaceChildren(
    ...snapshot.assumptions.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      if (line.includes('treat as an assumption')) li.dataset.weak = 'true';
      return li;
    }),
  );

  totals.replaceChildren(
    ...snapshot.rows.map((r) => row(r.ticker, r.before, r.after)),
    row('book', totalBefore, totalAfter, true),
  );

  const verdict = document.createElement('div');
  verdict.className = 'verdict';
  verdict.dataset.sign = pnl >= 0 ? 'up' : 'down';
  verdict.textContent = `${pnl >= 0 ? '+' : '−'}$${fmt(Math.abs(pnl))} on a ${
    snapshot.shock.bps
  }bp ${snapshot.shock.shape}`;
  totals.append(verdict);

  draw(snapshot);
}

function row(label: string, before: number, after: number, strong = false): HTMLElement {
  const el = document.createElement('div');
  el.className = 'row';
  if (strong) el.dataset.strong = 'true';
  el.innerHTML =
    `<span>${label}</span><span>$${fmt(before)}</span>` +
    `<span>$${fmt(after)}</span><span class="${after - before >= 0 ? 'up' : 'down'}">` +
    `${after - before >= 0 ? '+' : '−'}$${fmt(Math.abs(after - before))}</span>`;
  return el;
}

/** The curve, before and after, on a log-tenor axis. */
function draw(snapshot: Snapshot): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 56, right: 20, top: 24, bottom: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const tenors = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
  const samples: number[] = [];
  for (let i = 0; i <= 120; i += 1) {
    samples.push(0.25 * Math.exp((Math.log(30 / 0.25) * i) / 120));
  }
  // Both series are read before either is drawn: each read re-installs its own
  // curve in the module, so interleaving them would pay a bootstrap per point.
  const baseRates = samples.map((t) => snapshot.base.zero(t));
  const shockedRates = samples.map((t) => snapshot.shocked.zero(t));

  const all = [...baseRates, ...shockedRates];
  const lo = Math.min(...all) - 0.0015;
  const hi = Math.max(...all) + 0.0015;
  const x = (t: number) => pad.left + (Math.log(t / 0.25) / Math.log(30 / 0.25)) * plotW;
  const y = (rate: number) => pad.top + plotH - ((rate - lo) / (hi - lo)) * plotH;

  // Gridlines at whole tenors and at 25bp rate steps.
  ctx.strokeStyle = '#e6e3dc';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#8d8880';
  ctx.textAlign = 'center';
  for (const t of tenors) {
    ctx.beginPath();
    ctx.moveTo(x(t), pad.top);
    ctx.lineTo(x(t), pad.top + plotH);
    ctx.stroke();
    ctx.fillText(t < 1 ? `${t * 12}m` : `${t}y`, x(t), height - 26);
  }
  ctx.textAlign = 'right';
  const step = 0.0025;
  for (let r = Math.ceil(lo / step) * step; r <= hi; r += step) {
    ctx.beginPath();
    ctx.moveTo(pad.left, y(r));
    ctx.lineTo(pad.left + plotW, y(r));
    ctx.stroke();
    ctx.fillText(`${(r * 100).toFixed(2)}%`, pad.left - 8, y(r) + 3);
  }

  const line = (rates: number[], stroke: string, dash: number[]) => {
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    samples.forEach((t, i) => {
      const px = x(t);
      const py = y(rates[i] as number);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  };

  line(baseRates, '#8d8880', [4, 3]);
  line(shockedRates, '#d2612a', []);

  // The quoted points, which are the only places the curve is pinned.
  ctx.fillStyle = '#1c1a17';
  for (const quote of QUOTES) {
    const t = quote.kind === 'future' ? quote.end : quote.maturity;
    ctx.beginPath();
    ctx.arc(x(t), y(snapshot.base.zero(t)), 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // The tenor the options price off, which is where the transmission reads.
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = '#3a7bc9';
  ctx.beginPath();
  ctx.moveTo(x(PRICING_TENOR), pad.top);
  ctx.lineTo(x(PRICING_TENOR), pad.top + plotH);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#3a7bc9';
  ctx.textAlign = 'left';
  ctx.fillText('option discount tenor', x(PRICING_TENOR) + 6, pad.top + 12);

  ctx.fillStyle = '#8d8880';
  ctx.fillText('dashed: today   solid: shocked   dots: quotes', pad.left, height - 8);
}

for (const control of [shapePicker, bpsSlider, pivotSlider]) {
  control.addEventListener('input', compute);
}
window.addEventListener('resize', () => { if (latest) render(latest); });
compute();

Object.assign(window as unknown as Record<string, unknown>, {
  __rates: () => latest,
});
