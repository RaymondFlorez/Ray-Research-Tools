#!/usr/bin/env node
/**
 * A plan executed for real: the data plane on Postgres serves Treasury's own
 * par yield curve, a retrieval agent reads it over HTTP at a knowledge time,
 * and a pricing agent bootstraps a curve from it in the Rust core's WASM
 * build and reprices a bond sleeve under the PRD's +50bp shock.
 *
 * The yields are real: `cmd/load treasury` fetches the year's daily par curve
 * from home.treasury.gov and appends it through the data plane like any other
 * load. The sleeve is SYNTHETIC — three bonds with round coupons, standing in
 * for positions this repo does not have — and is printed as such.
 *
 *   DATAPLANE_PG_URL=postgres://... node scripts/execute-live.mjs [year,...]
 *
 * Needs Go, network access to home.treasury.gov, `npm run build`, and the WASM
 * build (`cargo build --release --target wasm32-unknown-unknown` in
 * crates/pricing-core).
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dist = (p) => import(join(ROOT, `packages/${p}/dist/index.js`));
const { Blackboard, curveShockAgent, parInstruments, plan, retrievalAgent, run, scope, toPlanSteps } = await dist('canvas-agents');
const { RemotePointInTime, remoteSource } = await dist('canvas-data');
const { BondAnalytics, CurveEngine, instantiatePricing } = await dist('canvas-pricing');

const PG = process.env.DATAPLANE_PG_URL;
if (!PG) {
  console.error('DATAPLANE_PG_URL is required: the data plane serves the curve from Postgres');
  process.exit(1);
}
const YEARS = process.argv[2] ?? String(new Date().getUTCFullYear());
const PORT = Number(process.env.DP_PORT ?? 8744);
const BASE = `http://127.0.0.1:${PORT}`;

// The tenors the curve is built from; Treasury publishes more.
const POINTS = [['3M', 0.25], ['6M', 0.5], ['1Y', 1], ['2Y', 2], ['3Y', 3], ['5Y', 5], ['7Y', 7], ['10Y', 10], ['20Y', 20], ['30Y', 30]].map(([t, years]) => ({ key: `UST.par.${t}`, years }));
const bond = (id, years, coupon, face) => ({
  id,
  quantity: face / 100,
  flows: Array.from({ length: years * 2 }, (_, i) => [(i + 1) / 2, coupon / 2 + (i + 1 === years * 2 ? 100 : 0)]),
});
// SYNTHETIC positions: $10mm of a 2y 4%, $5mm of a 5y 4.25%, $5mm of a 10y 4.5%.
const SLEEVE = [bond('2y-4', 2, 4, 10_000_000), bond('5y-4.25', 5, 4.25, 5_000_000), bond('10y-4.5', 10, 4.5, 5_000_000)];

const work = await mkdtemp(join(tmpdir(), 'execute-'));
const go = (pkg, out) => execFileSync('go', ['build', '-o', join(work, out), pkg], { cwd: join(ROOT, 'services/dataplane'), stdio: 'inherit' });
go('./cmd/dataplane', 'dataplane');
go('./cmd/load', 'load');
const schema = `execute_${Date.now().toString(36)}`;
const config = join(ROOT, 'services/dataplane/config');
const dataplane = spawn(join(work, 'dataplane'), ['-addr', `127.0.0.1:${PORT}`, '-dev-identity', '-users', `${config}/users.json`, '-symbology', `${config}/symbology.json`, '-pg', PG, '-schema', schema, '-audit-schema', `${schema}_audit`, '-migrate'], { stdio: ['ignore', 'ignore', 'inherit'] });

try {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('the data plane never came up');
    await new Promise((r) => setTimeout(r, 100));
  }
  execFileSync(join(work, 'load'), ['-to', BASE, '-as', 'loader', 'treasury', '-years', YEARS], { stdio: 'inherit' });

  const knowledgeTime = new Date().toISOString();
  const exportsReady = await instantiatePricing(readFileSync(join(ROOT, 'crates/pricing-core/target/wasm32-unknown-unknown/release/pricing_core.wasm')));
  const curves = new CurveEngine(exportsReady);
  const source = remoteSource(new RemotePointInTime({ baseUrl: BASE, user: 'pm', purpose: 'agents.execute' }), 'data plane (Postgres)');

  const question = 'What does a 50bp rise in rates do to the bond sleeve?';
  const compiled = plan({
    scope: scope({ question, resolve: () => [] }),
    author: { kind: 'analyst', user: 'pm' },
    steps: [
      { id: 'rates', kind: 'retrieval', agent: 'retriever', description: 'read the Treasury par curve as of now', dependsOn: [], estimatedCents: 0, estimatedMs: 100 },
      { id: 'sleeve', kind: 'compute', agent: 'simulator', description: 'bootstrap the curve and reprice the sleeve under +50bp', dependsOn: ['rates'], estimatedCents: 0, estimatedMs: 100 },
    ],
  });
  const board = new Blackboard('execute-live', question, 10);
  board.setPlan(toPlanSteps(compiled));
  const started = performance.now();
  const result = await run({
    board,
    agents: {
      rates: retrievalAgent({ source, knowledgeTime, keys: POINTS.map((p) => ({ key: p.key, unit: 'pct' })) }),
      sleeve: curveShockAgent({ curves, points: POINTS, book: SLEEVE, shock: { shape: 'parallel', bps: 50 } }),
    },
  });
  const ms = performance.now() - started;

  console.log(`\n${question}\nplan by ${compiled.author.user}, ${compiled.steps.length} steps; ran in ${result.waves} waves, ${ms.toFixed(0)}ms`);
  for (const s of board.steps()) console.log(`  ${s.id.padEnd(7)} ${s.status.padEnd(7)} ${s.note ?? ''}`);
  if (result.failed.length > 0 || result.skipped.length > 0) process.exitCode = 1;
  console.log('\nread from the data plane (real, US Treasury daily par yield curve):');
  for (const p of POINTS) {
    const f = board.fact(`rates:${p.key}`);
    if (f) console.log(`  ${p.key.padEnd(12)} ${f.value.number.toFixed(2)}%  for ${f.value.asof}`);
  }
  const usd = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const base = board.fact('sleeve:base');
  const pnl = board.fact('sleeve:pnl');
  if (base && pnl) {
    console.log('\nthe SYNTHETIC sleeve: $10mm 2y 4%, $5mm 5y 4.25%, $5mm 10y 4.5%');
    console.log(`  on the curve     $${usd(base.value.number)}`);
    console.log(`  under +50bp      $${usd(board.fact('sleeve:shocked').value.number)}`);
    console.log(`  P&L              $${usd(pnl.value.number)}  (derived: ${pnl.derivation.operands.join(' - ')})`);
    const bonds = new BondAnalytics(exportsReady, curves);
    const curve = curves.bootstrap(parInstruments(POINTS.map((p) => ({ years: p.years, pct: board.fact(`rates:${p.key}`).value.number }))));
    const dv01 = SLEEVE.reduce((t, b) => {
      const price = b.flows.reduce((v, [time, cf]) => v + cf * curve.discount(time), 0);
      return t + b.quantity * bonds.yieldMetrics(b.flows, price).dv01;
    }, 0);
    console.log(`  against -DV01 x 50, from yield: ${(pnl.value.number / (-dv01 * 50)).toFixed(4)} of it`);
  }
} finally {
  dataplane.kill();
}
