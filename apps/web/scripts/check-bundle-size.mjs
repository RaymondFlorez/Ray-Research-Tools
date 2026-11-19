#!/usr/bin/env node
/**
 * Bundle-size budget (Step 11). Run after `vite build`; exits non-zero when a budget is
 * exceeded so CI catches regressions (e.g. deck.gl leaking back into the eager graph).
 *
 * Budgets are gzip sizes:
 *  - initial: JS the browser must load before first paint (entry + modulepreloads)
 *  - chunk:   any single JS chunk
 *  - total:   all JS
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = { initial: 100, chunk: 150, total: 400 };
const dist = new URL('../dist/', import.meta.url).pathname;
const assets = join(dist, 'assets');

const gz = (file) => gzipSync(readFileSync(join(assets, file))).length / 1024;

const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const eager = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);

const sizes = Object.fromEntries(js.map((f) => [f, gz(f)]));
const initial = eager.reduce((sum, f) => sum + (sizes[f] ?? 0), 0);
const total = Object.values(sizes).reduce((a, b) => a + b, 0);

const failures = [];
console.log('chunk (gzip kB)');
for (const [file, kb] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) {
  const flag = eager.includes(file) ? ' [initial]' : '';
  console.log(`  ${kb.toFixed(1).padStart(7)}  ${file}${flag}`);
  if (kb > BUDGET_KB.chunk) failures.push(`${file}: ${kb.toFixed(1)} kB > ${BUDGET_KB.chunk} kB`);
}
console.log(`initial ${initial.toFixed(1)} kB (budget ${BUDGET_KB.initial})`);
console.log(`total   ${total.toFixed(1)} kB (budget ${BUDGET_KB.total})`);
if (initial > BUDGET_KB.initial)
  failures.push(`initial JS ${initial.toFixed(1)} kB > ${BUDGET_KB.initial} kB`);
if (total > BUDGET_KB.total)
  failures.push(`total JS ${total.toFixed(1)} kB > ${BUDGET_KB.total} kB`);

if (failures.length) {
  console.error(`\nBundle budget exceeded:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('Bundle budget OK');
