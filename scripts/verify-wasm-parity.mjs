/**
 * Verifies the PRD's "bit-identical results on client and server" claim.
 *
 * The pricing core compiles to a native service and to WASM in the browser, and
 * the client shows an optimistic local price that the server's authoritative
 * one replaces. If those two disagree even in the last few digits, the visual
 * tick that says they agree never settles (PRD 7.1).
 *
 * So: run the same inputs through both, and compare the raw f64 bit patterns.
 * Comparing decimals would hide the disagreement this exists to find.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRATE = fileURLToPath(new URL('../crates/pricing-core', import.meta.url));

// Build both from the current source. Reading a pre-built .wasm would compare
// whatever was last compiled against freshly-built native code, which is a
// harness that reports parity failures for edits it has not seen.
execFileSync(
  'cargo',
  ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown'],
  { cwd: CRATE, stdio: 'inherit' },
);

const native = execFileSync(
  'cargo',
  ['run', '--quiet', '--release', '--example', 'dump_native'],
  { cwd: CRATE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));

const wasmBytes = readFileSync(`${CRATE}/target/wasm32-unknown-unknown/release/pricing_core.wasm`);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const w = instance.exports;

const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

/**
 * Reprices the same 40-leg grid through WASM, once, and indexes the result by
 * the label the native side emitted.
 *
 * The grid is checked as well as the scalars because scalar parity does not
 * imply it: every cell sums across forty legs, so a last-bit disagreement
 * anywhere inside compounds into the number the analyst actually reads.
 */
function wasmGrid() {
  w.pc_book_reset();
  for (let i = 0; i < 40; i += 1) {
    w.pc_book_add_leg(
      80 + (i % 20) * 2.5,
      0.08 + (i % 5) * 0.24,
      i % 2 === 0 ? 1 : 0,
      i % 4 < 2 ? 1 : 0,
      i % 3 === 0 ? -5 : 5,
      100,
      0.22 + (i % 7) * 0.02,
    );
  }
  const cells = w.pc_grid_reprice(100, 0.045, 0.017, 25, 0.2, 15, 0.1, 7, 1);
  const stride = w.pc_grid_stride();
  // Copied before anything else calls in: the view aliases linear memory.
  const data = new Float64Array(w.memory.buffer, w.pc_grid_data(), cells * stride).slice();

  const rows = new Map();
  for (let i = 0; i < data.length; i += 1) {
    rows.set(`cell${Math.floor(i / stride)}/${i % stride}`, data[i]);
  }
  for (let which = 0; which < 5; which += 1) rows.set(`guard${which}`, w.pc_guard_value(which));
  return rows;
}

const grid = wasmGrid();

/**
 * Rebuilds the same curves through WASM.
 *
 * The bootstrap is a bisection that runs until the bracket collapses to
 * adjacent doubles, so a single differing bit anywhere in the objective sends
 * the two targets to different pins and every rate off that curve diverges.
 * That makes this the sharpest parity check in the suite, and the reason the
 * curve work is checked here rather than only in Rust.
 */
function wasmCurves() {
  const rows = new Map();

  w.pc_curve_reset();
  w.pc_curve_add_deposit(0.0833, 0.0533);
  w.pc_curve_add_deposit(0.25, 0.0528);
  w.pc_curve_add_deposit(0.5, 0.0515);
  w.pc_curve_add_future(0.5, 0.75, 0.0496, 0.4);
  w.pc_curve_add_future(0.75, 1.0, 0.0471, 0.7);
  for (const [maturity, rate] of [
    [2, 0.0428], [3, 0.0401], [5, 0.0388], [7, 0.0387],
    [10, 0.0392], [20, 0.0407], [30, 0.0396],
  ]) {
    w.pc_curve_add_swap(maturity, rate, 2);
  }
  rows.set('curve_pins', w.pc_curve_bootstrap());
  for (let step = 0; step <= 80; step += 1) {
    const t = 0.25 + step * 0.5;
    rows.set(`curve_zero(${fmt(t)})`, w.pc_curve_zero(t));
    rows.set(`curve_df(${fmt(t)})`, w.pc_curve_discount(t));
    rows.set(`curve_fwd(${fmt(t)})`, w.pc_curve_forward(t, t + 0.5));
  }
  for (let index = 0; index < 12; index += 1) {
    rows.set(`curve_resid(${index})`, w.pc_curve_residual(index));
  }

  for (const [shape, bps, pivot] of [[0, 50, 0], [1, 40, 2], [2, 25, 5], [3, 30, 5]]) {
    w.pc_curve_bootstrap();
    w.pc_curve_shock(shape, bps, pivot);
    for (let step = 0; step <= 12; step += 1) {
      const t = 0.25 + step * 2.5;
      rows.set(`shock${shape}_zero(${fmt(t)})`, w.pc_curve_zero(t));
    }
  }

  w.pc_nss_reset();
  for (const [tenor, zero] of [
    [0.25, 0.0521], [0.5, 0.0508], [1, 0.0472], [2, 0.0428], [3, 0.0404],
    [5, 0.0389], [7, 0.0388], [10, 0.0394], [20, 0.0412], [30, 0.0399],
  ]) {
    w.pc_nss_observe(tenor, zero);
  }
  rows.set('nss_status', w.pc_nss_fit());
  for (let which = 0; which < 6; which += 1) rows.set(`nss_param(${which})`, w.pc_nss_param(which));
  for (let which = 0; which < 3; which += 1) rows.set(`nss_stat(${which})`, w.pc_nss_stat(which));
  for (let step = 0; step <= 20; step += 1) {
    const t = 0.25 + step * 1.5;
    rows.set(`nss_zero(${fmt(t)})`, w.pc_nss_zero(t));
  }
  for (let index = 0; index < 10; index += 1) {
    rows.set(`nss_resid(${index})`, w.pc_nss_residual(index));
  }
  return rows;
}

/** Rust's `{}` for an f64, which is what the native labels were built with. */
function fmt(value) {
  return Number.isInteger(value) ? String(value) : String(value);
}

const curves = wasmCurves();

/**
 * The realized-vol series, through WASM.
 *
 * Built once and indexed, because the series is stateful: the values are read
 * at four points as it grows, and re-pushing it per label would compare a
 * different window each time.
 */
function wasmVol() {
  const rows = new Map();
  w.pc_vol_reset();
  let close = 100;
  for (let i = 0; i < 120; i += 1) {
    const step = i % 3 === 0 ? 1.013 : i % 3 === 1 ? 0.991 : 1.004;
    close *= step;
    w.pc_vol_observe(close);
    if (i % 20 === 19) {
      rows.set(`realized(${i})`, w.pc_realized_vol(252));
      rows.set(`realized_var(${i})`, w.pc_realized_variance(252));
    }
  }
  return rows;
}

const volRows = wasmVol();

/** Bond analytics and the Hull-White lattice, through WASM. */
function wasmBonds() {
  const rows = new Map();
  w.pc_curve_bootstrap();
  w.pc_bond_reset();
  for (let i = 1; i <= 20; i += 1) w.pc_bond_add_flow(0.5 * i, i === 20 ? 102 : 2);

  for (const [which, label] of [
    [0, 'ytm'], [1, 'macaulay'], [2, 'modified'], [3, 'convexity'], [4, 'dv01'],
  ]) {
    for (const price of [92, 100, 107.5]) {
      rows.set(`bond_${label}(${price})`, w.pc_bond_metric(which, price, 2));
    }
  }
  for (const price of [92, 100, 107.5]) {
    rows.set(`bond_z(${price})`, w.pc_bond_z_spread(price));
    rows.set(`bond_asw(${price})`, w.pc_bond_asset_swap(price, 2, 100));
    rows.set(`bond_pay(${price})`, w.pc_bond_price_at_yield(price / 2000, 2));
  }

  rows.set('hw_steps', w.pc_hw_calibrate(0.05, 0.011, 0.5, 20));
  for (let step = 1; step <= 20; step += 1) rows.set(`hw_zc(${step})`, w.pc_hw_zero_coupon(step));
  for (const [callFrom, callPrice] of [[-1, 0], [6, 100], [4, 102]]) {
    rows.set(`hw_price(${callFrom})`, w.pc_hw_bond_price(2, 100, 20, callFrom, callPrice, 0.008));
    rows.set(`hw_oas(${callFrom})`, w.pc_hw_oas(2, 100, 20, callFrom, callPrice, 96.5));
    rows.set(`hw_opt(${callFrom})`, w.pc_hw_option_value(2, 100, 20, callFrom, callPrice, 0.008));
  }
  return rows;
}

const bonds = wasmBonds();

/** Monte Carlo and Sobol, through WASM. */
function wasmMonteCarlo() {
  const rows = new Map();
  for (let dimension = 0; dimension < 6; dimension += 1) {
    for (const skip of [0, 1, 7, 64, 1000]) {
      rows.set(`sobol(${dimension}/${skip})`, w.pc_sobol(8, skip, dimension));
    }
  }
  for (let process = 0; process < 4; process += 1) {
    for (const [sampling, anti] of [[0, 1], [0, 0], [1, 0]]) {
      rows.set(
        `mc(${process}/${sampling}/${anti})`,
        w.pc_mc_european(process, 100, 105, 1, 0.04, 0.015, 0.3, 1, 4096, 16, sampling, anti, 12345),
      );
    }
  }
  return rows;
}

const monteCarlo = wasmMonteCarlo();

/** The multi-asset portfolio simulator, through WASM. */
function wasmPortfolio() {
  const rows = new Map();
  // The last is deliberately impossible — equicorrelation needs
  // rho > -1/(n-1), so -0.3 across six assets is not a correlation matrix. Both
  // builds must refuse it identically, and neither may read the result buffers
  // afterwards: a refused run leaves them null, and reading them is what made
  // this harness report seventeen differing values the first time it ran.
  const shapes = [
    [4, 512, 24, 0.0],
    [8, 384, 32, 0.55],
    [6, 256, 16, -0.15],
    [6, 128, 8, -0.3],
  ];
  shapes.forEach(([assets, paths, steps, rho], index) => {
    w.pc_mc_reset();
    for (let i = 0; i < assets; i += 1) {
      w.pc_mc_add_asset(
        50 + 7 * i,
        i % 3 === 0 ? -150 : 100,
        0.18 + 0.03 * (i % 5),
        0.04,
        0.01,
      );
    }
    w.pc_mc_corr_equicorrelated(rho);
    const code = w.pc_mc_run(1, paths, steps, 1, 4242, 4);
    rows.set(`pf_run(${index})`, code);
    if (code < 0) return;

    const summary = new Float64Array(w.memory.buffer, w.pc_mc_summary(), 9);
    for (let which = 0; which < 9; which += 1) {
      rows.set(`pf_summary(${index}/${which})`, summary[which]);
    }
    for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      rows.set(`pf_pct(${index}/${q})`, w.pc_mc_percentile(q));
      rows.set(`pf_dd(${index}/${q})`, w.pc_mc_drawdown_percentile(q));
    }
    for (const a of [0.01, 0.05, 0.1]) {
      rows.set(`pf_cvar(${index}/${a})`, w.pc_mc_cvar(a));
    }
    const sample = new Float64Array(w.memory.buffer, w.pc_mc_sample(), steps + 1);
    for (let step = 0; step <= steps; step += 1) {
      rows.set(`pf_path(${index}/${step})`, sample[step]);
    }
  });
  return rows;
}

const portfolio = wasmPortfolio();

/** A mixed-process correlated portfolio, through WASM. */
function wasmMixedPortfolio() {
  const rows = new Map();
  w.pc_mc_reset();
  w.pc_mc_add_asset(100, 100, 0.24, 0.04, 0.01);
  w.pc_mc_add_heston(80, -150, 0.04, 0.01, 0.0625, 0.09, 1.6, 0.6, -0.65);
  w.pc_mc_add_merton(120, 100, 0.04, 0.01, 0.2, 1.2, -0.06, 0.14);
  w.pc_mc_add_heston(60, 200, 0.04, 0.0, 0.16, 0.12, 0.8, 1.1, 0.3);
  w.pc_mc_corr_equicorrelated(0.4);
  rows.set('mix_run', w.pc_mc_run(0.75, 512, 40, 1, 909, 3));

  const summary = new Float64Array(w.memory.buffer, w.pc_mc_summary(), 9);
  for (let which = 0; which < 9; which += 1) {
    rows.set(`mix_summary(${which})`, summary[which]);
  }
  for (const q of [0.01, 0.1, 0.5, 0.9, 0.99]) {
    rows.set(`mix_pct(${q})`, w.pc_mc_percentile(q));
    rows.set(`mix_dd(${q})`, w.pc_mc_drawdown_percentile(q));
  }
  const sample = new Float64Array(w.memory.buffer, w.pc_mc_sample(), 41);
  for (let step = 0; step <= 40; step += 1) {
    rows.set(`mix_path(${step})`, sample[step]);
  }
  return rows;
}

const mixed = wasmMixedPortfolio();

/** Heston closed form and a small calibration, through WASM. */
function wasmHeston() {
  const rows = new Map();
  const sets = [
    [0.042, 0.058, 1.8, 0.55, -0.68],
    [0.09, 0.09, 0.3, 1.0, -0.5],
    [0.0025, 0.64, 15.0, 3.0, -0.95],
    [0.25, 0.25, 0.5, 2.0, 0.0],
  ];
  sets.forEach(([v0, theta, kappa, sigma, rho], index) => {
    rows.set(`hst_cond(${index})`, w.pc_heston_conditioning(v0, theta, kappa, sigma, rho));
    for (const k of [70, 90, 100, 110, 130]) {
      for (const t of [0.08, 0.5, 2, 7]) {
        for (const isCall of [0, 1]) {
          const tag = `${index}/${k}/${t}/${isCall}`;
          rows.set(
            `hst_px(${tag})`,
            w.pc_heston_price(100, k, t, 0.03, 0.01, isCall, v0, theta, kappa, sigma, rho),
          );
          rows.set(
            `hst_iv(${tag})`,
            w.pc_heston_iv(100, k, t, 0.03, 0.01, isCall, v0, theta, kappa, sigma, rho),
          );
        }
      }
    }
  });

  w.pc_heston_surface_reset();
  for (const k of [80, 90, 100, 110, 125]) {
    for (const t of [0.25, 1, 2]) {
      const isCall = k >= 100 ? 1 : 0;
      const vol = w.pc_heston_iv(100, k, t, 0.03, 0.01, isCall, 0.042, 0.058, 1.8, 0.55, -0.68);
      w.pc_heston_surface_add(k, t, isCall, vol, 1);
    }
  }
  rows.set('hst_fit_n', w.pc_heston_calibrate(100, 0.03, 0.01, 0, 16, 12, 4242));
  const fit = new Float64Array(w.memory.buffer, w.pc_heston_fit(), 11);
  for (let which = 0; which < 11; which += 1) {
    rows.set(`hst_fit(${which})`, fit[which]);
  }
  return rows;
}

const hestonRows = wasmHeston();

/** Recomputes one labelled row through the WASM module. */
function recompute(label) {
  if (grid.has(label)) return grid.get(label);
  if (curves.has(label)) return curves.get(label);
  if (bonds.has(label)) return bonds.get(label);
  if (monteCarlo.has(label)) return monteCarlo.get(label);
  if (portfolio.has(label)) return portfolio.get(label);
  if (hestonRows.has(label)) return hestonRows.get(label);
  if (mixed.has(label)) return mixed.get(label);

  let match = /^norm_cdf\((-?[\d.]+)\)$/.exec(label);
  if (match) return w.pc_norm_cdf(Number(match[1]));

  if (volRows.has(label)) return volRows.get(label);

  match = /^(fwdvol|evmove)\(([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\)$/.exec(label);
  if (match) {
    const [, kind, t1, v1, t2, v2] = match;
    const args = [Number(t1), Number(v1), Number(t2), Number(v2)];
    return kind === 'fwdvol' ? w.pc_forward_vol(...args) : w.pc_event_move(...args);
  }

  match = /^pin\(([\d.]+)\/([\d.]+)\/([\d.]+)\)$/.exec(label);
  if (match) {
    const [, m, v, t] = match;
    return w.pc_pin_sigmas(100, 100 * Number(m), Number(v), Number(t));
  }

  match = /^(carry|discount)\((\d)\/([\d.]+)\/([\d.]+)\/([\d.]+)\)$/.exec(label);
  if (match) {
    const [, kind, isCall, m, q, t] = match;
    return kind === 'discount'
      ? w.pc_discount(0.045, Number(t))
      : w.pc_early_exercise_carry(100, 100 * Number(m), 0.045, Number(q), Number(t), Number(isCall));
  }

  match = /^(greek(\d)|fast|exact|iv)\((\d)\/([\d.]+)\/([\d.]+)\/([\d.]+)\)$/.exec(label);
  if (!match) throw new Error(`unparsed label: ${label}`);

  const [, kind, which, isCall, m, t, v] = match;
  const [s, k, r, q] = [100, 100 * Number(m), 0.045, 0.017];
  const call = Number(isCall);
  const time = Number(t);
  const vol = Number(v);

  if (kind === 'fast') return w.pc_american_fast(s, k, time, r, q, vol, call);
  if (kind === 'exact') return w.pc_american_exact(s, k, time, r, q, vol, call);
  if (kind === 'iv') {
    const price = w.pc_price(s, k, time, r, q, vol, call);
    return w.pc_implied_vol(s, k, time, r, q, price, call);
  }
  return w.pc_greek(s, k, time, r, q, vol, call, Number(which));
}

let mismatches = 0;
let nans = 0;
for (const [label, nativeBits] of native) {
  const value = recompute(label);
  const wasmBits = bits(value);
  // NaN is NaN on both sides; its payload bits are not a contract.
  if (Number.isNaN(value) && nativeBits.startsWith('7ff8')) {
    nans += 1;
    continue;
  }
  if (wasmBits !== nativeBits) {
    if (mismatches < 10) {
      console.error(`  ${label}\n    native ${nativeBits}\n    wasm   ${wasmBits}`);
    }
    mismatches += 1;
  }
}

console.log(
  `compared ${native.length} values across BSM, Greeks, American, implied vol ` +
    `a 40-leg grid, curves, bonds, a Hull-White lattice, Monte Carlo, a mixed-process portfolio, ` +
    `Heston with its calibration, the pin and early-exercise thresholds, and the vol analytics` +
    `${nans > 0 ? ` (${nans} NaN by design)` : ''}`,
);
if (mismatches === 0) {
  console.log('bit-identical: native and WASM agree on every bit of every value');
} else {
  console.error(`\n${mismatches} value(s) differ between native and WASM`);
}
process.exit(mismatches > 0 ? 1 : 0);
