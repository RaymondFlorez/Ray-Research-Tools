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
  const cells = w.pc_grid_reprice(100, 0.045, 0.017, 25, 0.2, 15, 0.1, 7);
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

/** Recomputes one labelled row through the WASM module. */
function recompute(label) {
  if (grid.has(label)) return grid.get(label);

  let match = /^norm_cdf\((-?[\d.]+)\)$/.exec(label);
  if (match) return w.pc_norm_cdf(Number(match[1]));

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
    `and a 40-leg 25x15 grid` +
    `${nans > 0 ? ` (${nans} NaN by design)` : ''}`,
);
if (mismatches === 0) {
  console.log('bit-identical: native and WASM agree on every bit of every value');
} else {
  console.error(`\n${mismatches} value(s) differ between native and WASM`);
}
process.exit(mismatches > 0 ? 1 : 0);
