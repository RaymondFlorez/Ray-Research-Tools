#!/usr/bin/env node
/**
 * The hardest book in WASM: 40 American legs over a 25x15 grid, the book
 * `crates/pricing-core/examples/grid_bench.rs` times natively, at each quality,
 * under Node's V8 and in headless Chromium. Prints p50 and p95 of 41 runs after
 * three to warm up, and the guard's verdict on the last.
 *
 * Run after building the WASM (`cargo build --release --target
 * wasm32-unknown-unknown` in crates/pricing-core):
 *
 *   node scripts/bench-grid-wasm.mjs
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const bytes = readFileSync(new URL('../crates/pricing-core/target/wasm32-unknown-unknown/release/pricing_core.wasm', import.meta.url));

// Runs where it is handed the module's bytes: in Node directly, in the page by
// serialization, so the two time the same code.
async function bench(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const w = instance.exports;
  const out = [];
  for (const [quality, name] of [[0, 'draft'], [1, 'standard'], [2, 'exact']]) {
    const times = [];
    let guard = 0;
    for (let run = 0; run < 44; run++) {
      w.pc_book_reset();
      for (let i = 0; i < 40; i++) {
        w.pc_book_add_leg(80 + (i % 20) * 2.5, 0.08 + (i % 6) * 0.25, i % 2 === 0 ? 1 : 0, 1, i % 3 === 0 ? -10 : 5, 100, 0.22 + (i % 7) * 0.03);
      }
      w.pc_grid_use_dividends(0);
      const t = performance.now();
      w.pc_grid_reprice(100, 0.04, 0.015, 25, 0.2, 15, 0.1, 0, quality);
      if (run >= 3) times.push(performance.now() - t);
      guard = w.pc_guard_value(0);
    }
    times.sort((a, b) => a - b);
    const at = (q) => times[Math.ceil(q * times.length) - 1];
    out.push({ name, p50: at(0.5), p95: at(0.95), guard });
  }
  return out;
}

const print = (where, rows) => {
  for (const r of rows) console.log(`${where.padEnd(9)} ${r.name.padEnd(9)} p50 ${r.p50.toFixed(1).padStart(6)}ms  p95 ${r.p95.toFixed(1).padStart(6)}ms  guard ${["not needed", "passed", "escalated"][r.guard] ?? r.guard}`);
};

print('node', await bench(bytes));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const rows = await page.evaluate(
    async ({ source, data }) => {
      const run = new Function(`return (${source})`)();
      return run(new Uint8Array(data));
    },
    { source: bench.toString(), data: [...bytes] },
  );
  print('chromium', rows);
} finally {
  await browser.close();
}
