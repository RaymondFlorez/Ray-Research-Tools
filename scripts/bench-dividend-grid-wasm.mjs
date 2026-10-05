#!/usr/bin/env node
/**
 * The dividend grid in WASM: the worst book (40 American legs, all paying
 * 0.50 a quarter, 25x15 cells) at Draft and Standard quality, under V8.
 * Run after building the WASM: node scripts/bench-dividend-grid-wasm.mjs
 */
import { readFileSync } from 'node:fs';
const bytes = readFileSync('./crates/pricing-core/target/wasm32-unknown-unknown/release/pricing_core.wasm');
const { instance } = await WebAssembly.instantiate(bytes, {});
const w = instance.exports;
for (const quality of [0, 1]) {
  const times = [];
  for (let run = 0; run < 7; run++) {
    w.pc_book_reset();
    for (let i = 0; i < 40; i++) w.pc_book_add_leg(80 + (i % 20) * 2.5, 0.08 + (i % 6) * 0.25, i % 2 === 0 ? 1 : 0, 1, i % 3 === 0 ? -10 : 5, 100, 0.22 + (i % 7) * 0.03);
    w.pc_div_reset();
    for (let q = 0; q < 6; q++) w.pc_div_add(0.05 + 0.25 * q, 0.5);
    w.pc_grid_use_dividends(1);
    const t = performance.now();
    w.pc_grid_reprice(100, 0.04, 0, 25, 0.2, 15, 0.1, 0, quality);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(quality === 0 ? 'draft' : 'standard', 'p50', times[3].toFixed(1), 'ms');
}
