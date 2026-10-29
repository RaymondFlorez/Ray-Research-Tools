/**
 * Phase 1's exit criterion, "global time scrub reproduces a historical morning
 * exactly", through the data plane rather than in-process.
 *
 * packages/canvas-data/test/historical-morning.test.ts holds the criterion
 * against the in-memory store. This runs the same morning through
 * services/dataplane on Postgres, over HTTP, read by canvas-data's
 * RemotePointInTime the way a scrubbed canvas reads it, and checks:
 *
 *   - the morning reads exactly what the in-memory store reads;
 *   - today reads the restatements, and an unlicensed reader gets the
 *     restated quarter as blocked, not the superseded public figure;
 *   - a restatement that arrives later leaves the morning byte-identical;
 *   - a chart draws the same line through the service as in-process, with a
 *     withheld period as a gap where it falls;
 *   - a screen on the canvas reads the same universe through the service as
 *     in-process, and a withheld field leaves the name out as withheld;
 *   - a backtest whose history is loaded from the service produces exactly
 *     what the same backtest produces on the same facts held in-process, and
 *     a reader missing some of the versions is refused rather than given a
 *     backtest on the rest.
 *
 * Needs DATAPLANE_PG_URL, Go, and canvas-core, canvas-data and canvas-sim
 * built (npm run build).
 *
 *   DATAPLANE_PG_URL=postgres://... node scripts/historical-morning-remote.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { BitemporalStore, RemotePointInTime, DataPlaneError, SnapshotCatalog, setCanvasAsOf, createFactTile, evaluateFactTile, localSource, remoteSource, createUniverseNode, evaluateUniverseNode, createSeriesChart, evaluateSeriesChart } =
  await import(join(ROOT, 'packages/canvas-data/dist/index.js'));
const { addNode, createDocument } = await import(join(ROOT, 'packages/canvas-core/dist/index.js'));
const { backtest, History, IncompleteHistory, loadHistory } = await import(join(ROOT, 'packages/canvas-sim/dist/index.js'));

const PG = process.env.DATAPLANE_PG_URL;
if (!PG) {
  console.error('DATAPLANE_PG_URL is required: this check is the morning on Postgres, and there is no point running it without one');
  process.exit(1);
}
const PORT = Number(process.env.DP_PORT ?? 8743);
const BASE = `http://127.0.0.1:${PORT}`;
const THE_MORNING = '2024-08-05T09:30:00Z';
const TODAY = '2026-09-10T00:00:00Z';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}

// The morning, as historical-morning.test.ts has it, now classified: the 10-Q
// figures are public, the restatements come from a licensed vendor feed.
const FACTS = [
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, source: '10-Q', dataClass: 'public' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, restatement: true, dataClass: 'licensed', vendor: 'vendor-b' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-11-19', value: 29.71, restatement: true, dataClass: 'licensed', vendor: 'vendor-b' },
  { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08, source: '10-Q', dataClass: 'public' },
];

const work = await mkdtemp(join(tmpdir(), 'morning-'));
const binary = join(work, 'dataplane');
execFileSync('go', ['build', '-o', binary, './cmd/dataplane'], { cwd: join(ROOT, 'services/dataplane'), stdio: 'inherit' });
const schema = `morning_${Date.now().toString(36)}`;
const config = join(ROOT, 'services/dataplane/config');
const dataplane = spawn(binary, ['-addr', `127.0.0.1:${PORT}`, '-dev-identity', '-users', `${config}/users.json`, '-symbology', `${config}/symbology.json`, '-pg', PG, '-schema', schema, '-migrate'], { stdio: ['ignore', 'ignore', 'inherit'] });

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

  const as = (user) => new RemotePointInTime({ baseUrl: BASE, user });
  const plain = (read) => read.observations.map((o) => ({ validTime: o.validTime, value: o.value, knownAt: o.knownAt }));
  const local = new BitemporalStore();
  local.appendAll(FACTS);
  const localAt = (t) => local.asOf({ key: 'NVDA.revenue', knowledgeTime: t }).map((o) => ({ validTime: o.validTime, value: o.value, knownAt: o.knownAt }));

  // Loading is a writer's job; a reader is refused.
  let refused = false;
  try {
    await as('pm').append(FACTS);
  } catch (e) {
    refused = e instanceof DataPlaneError && e.status === 403;
  }
  check('a reader cannot load facts', refused);
  check('the loader can', (await as('loader').append(FACTS)) === FACTS.length);

  const pinned = { mode: 'pinned', asof: THE_MORNING };
  const live = { mode: 'live' };
  const now = () => TODAY;

  const morningPm = await as('pm').read('NVDA.revenue', pinned, now);
  check('scrubbed to the morning, Postgres reads exactly what the in-memory store reads',
    JSON.stringify(plain(morningPm)) === JSON.stringify(localAt(THE_MORNING)), JSON.stringify(plain(morningPm)));
  check('that morning, Q2 was 30.04 and Q3 did not exist', plain(morningPm).length === 1 && plain(morningPm)[0].value === 30.04);
  const morningAnalyst = await as('analyst').read('NVDA.revenue', pinned, now);
  check('an unlicensed reader sees the same morning: the public figure was current then',
    JSON.stringify(plain(morningAnalyst)) === JSON.stringify(plain(morningPm)) && morningAnalyst.blocked.length === 0);

  const todayPm = await as('pm').read('NVDA.revenue', live, now);
  check('live, the licensed reader gets the restatements, matching the in-memory store',
    JSON.stringify(plain(todayPm)) === JSON.stringify(localAt(TODAY)), plain(todayPm).map((o) => o.value).join(', '));
  const todayAnalyst = await as('analyst').read('NVDA.revenue', live, now);
  check('live, the unlicensed reader gets Q2 blocked — not the superseded 30.04 — and Q3',
    todayAnalyst.blocked.length === 1 && todayAnalyst.blocked[0].validTime === '2024-06-30' && plain(todayAnalyst).length === 1 && plain(todayAnalyst)[0].value === 35.08,
    todayAnalyst.blocked[0]?.decision.message);

  // A tile on a canvas scrubbed to the morning, evaluated through the service
  // and through the in-process store: the same answer, value and provenance.
  const tileAt = async (source, time) => {
    const doc = createDocument('morning');
    const tile = addNode(doc, createFactTile({ id: 'rev', key: 'NVDA.revenue' }));
    if (time.mode === 'pinned') setCanvasAsOf(doc, time.asof, new SnapshotCatalog());
    const shown = await evaluateFactTile(tile, source, time, now);
    return { ...shown, source: undefined, status: tile.state.status, asofStamped: tile.provenance.asof };
  };
  const tileRemote = await tileAt(remoteSource(as('pm')), pinned);
  const tileLocal = await tileAt(localSource(local), pinned);
  check('a fact tile scrubbed to the morning shows the same thing through the service as in-process',
    JSON.stringify(tileRemote) === JSON.stringify(tileLocal) && tileRemote.value === 30.04 && tileRemote.status === 'ready' && tileRemote.asofStamped === THE_MORNING,
    `${tileRemote.value} known ${tileRemote.knownAt}`);
  const tileAnalyst = await tileAt(remoteSource(as('analyst')), live);
  check('live, the unlicensed reader\'s tile shows Q3: a blocked older quarter does not hide a newer visible one',
    tileAnalyst.kind === 'value' && tileAnalyst.validTime === '2024-09-30' && tileAnalyst.value === 35.08);

  // A ChartNode of the same series.
  const chartAt = async (source, time) => {
    const v = await evaluateSeriesChart(createSeriesChart({ id: 'c', key: 'NVDA.revenue' }), source, time, now);
    return { ...v, source: undefined };
  };
  for (const [label, time] of [['the morning', pinned], ['today', live]]) {
    const remote = await chartAt(remoteSource(as('pm')), time);
    check(`a chart at ${label} draws the same line through the service as in-process`,
      JSON.stringify(remote) === JSON.stringify(await chartAt(localSource(local), time)), remote.points.map((p) => p.value).join(', '));
  }
  const chartAnalyst = await chartAt(remoteSource(as('analyst')), live);
  check('live, the unlicensed reader\'s chart has Q2 as a gap where it falls, then Q3',
    JSON.stringify(chartAnalyst.points) === JSON.stringify([
      { validTime: '2024-06-30', withheld: 'Requires a vendor-b licence.' },
      { validTime: '2024-09-30', value: 35.08, knownAt: '2024-11-20' },
    ]), JSON.stringify(chartAnalyst.points));

  // A UniverseNode on the same canvas. Market caps are SYNTHETIC figures; the
  // latest NVDA one comes from the licensed feed.
  const CAPS = [
    { key: 'NVDA.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 2.6e12, dataClass: 'public' },
    { key: 'NVDA.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 4.1e12, dataClass: 'licensed', vendor: 'vendor-b' },
    { key: 'AMD.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 2.2e11, dataClass: 'public' },
    { key: 'AMD.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 9.0e10, dataClass: 'public' },
    { key: 'WOLF.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 1.1e9, dataClass: 'public' },
    { key: 'NEWCO.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 5.0e11, dataClass: 'public' },
  ];
  check('the loader can load the market caps', (await as('loader').append(CAPS)) === CAPS.length);
  const REFERENCE = [
    { instrument: 'NVDA', listed: '1999-01-22', fields: { sector: 'semis' } },
    { instrument: 'AMD', listed: '1979-03-17', fields: { sector: 'semis' } },
    { instrument: 'WOLF', listed: '1993-02-01', delisted: '2025-07-01', fields: { sector: 'semis' } },
    { instrument: 'NEWCO', listed: '2025-05-01', fields: { sector: 'semis' } },
  ];
  const capsLocal = new BitemporalStore();
  capsLocal.appendAll(CAPS);
  const screen = async (source, time) => {
    const node = createUniverseNode('u', 'sector == "semis" and market_cap > 100b');
    const v = await evaluateUniverseNode(node, source, REFERENCE, ['market_cap'], time, now);
    return v.universe;
  };
  for (const [label, time] of [['the morning', pinned], ['today', live]]) {
    const remote = await screen(remoteSource(as('pm')), time);
    const inProcess = await screen(localSource(capsLocal), time);
    check(`a screen at ${label} reads the same universe through the service as in-process`,
      JSON.stringify(remote) === JSON.stringify(inProcess), remote.members.join(', '));
  }
  const screenAnalyst = await screen(remoteSource(as('analyst')), live);
  check('live, the unlicensed reader\'s screen leaves NVDA out as withheld, not screened on its older public figure',
    !screenAnalyst.members.includes('NVDA') && screenAnalyst.withheld.count === 1 && screenAnalyst.withheld.byField.market_cap === 1,
    `members ${screenAnalyst.members.join(', ')}; withheld ${screenAnalyst.withheld.count}`);

  const before = JSON.stringify(morningPm);
  await as('loader').append([{ key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2026-09-01', value: 29.4, restatement: true, dataClass: 'licensed', vendor: 'vendor-b' }]);
  const again = JSON.stringify(await as('pm').read('NVDA.revenue', pinned, now));
  check('a restatement arriving later leaves the morning byte-identical', again === before);
  const after = await as('pm').read('NVDA.revenue', live, now);
  check('and moves today', plain(after)[0].value === 29.4);

  const history = await as('analyst').history('NVDA.revenue', '2024-06-30');
  check('the history shows every version, withholding the licensed ones without hiding them',
    history.length === 4 && history[0].value === 30.04 && history.slice(1).every((v) => v.blocked && v.value === undefined),
    history.map((v) => (v.blocked ? `blocked@${v.knowledgeTime}` : `${v.value}@${v.knowledgeTime}`)).join(', '));

  // A backtest on the data plane. The prices are SYNTHETIC — a seeded random
  // walk, labelled as such in the facts' source — because no market data host
  // is reachable from here; what is under test is the loading, not the market.
  // The strategy holds shares in proportion to the revenue of every quarter
  // known on the bar — not just the latest quarter, whose restatements are of
  // Q2 after Q3 has been reported — so each restatement moves the book the bar
  // after it became known.
  const PRICES = [];
  let seed = 20240701;
  let px = 120;
  for (let t = Date.UTC(2024, 6, 1); t <= Date.UTC(2026, 8, 30); t += 86_400_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    px = Math.round(px * (1 + ((seed >>> 16) % 601 - 300) / 10_000) * 100) / 100;
    const date = new Date(t).toISOString().slice(0, 10);
    PRICES.push({ key: 'price:NVDA', validTime: date, knowledgeTime: date, value: px, source: 'synthetic random walk', dataClass: 'public' });
  }
  check('the loader can load the synthetic prices', (await as('loader').append(PRICES)) === PRICES.length, `${PRICES.length} bars`);

  const strategy = (view) => {
    const revenue = view.window('NVDA.revenue', 4).reduce((a, b) => a + b, 0);
    return [{ symbol: 'NVDA', targetShares: Math.round(revenue * 100) }];
  };
  const run = (h) => backtest(h, strategy, { symbols: ['NVDA'] });
  const KEYS = ['price:NVDA', 'NVDA.revenue'];
  const RESTATED = { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2026-09-01', value: 29.4 };
  const inProcess = new History();
  for (const f of [...PRICES, ...FACTS, RESTATED]) inProcess.add(f.key, { validTime: f.validTime, knowledgeTime: f.knowledgeTime, value: f.value });

  const onPlane = run(await loadHistory(as('pm'), KEYS));
  const offPlane = run(inProcess);
  check('a backtest loaded from Postgres is exactly the backtest run in-process',
    JSON.stringify(onPlane) === JSON.stringify(offPlane), `${onPlane.trades.length} trades, final equity ${onPlane.equity.at(-1)}`);
  check('and it trades on each restatement the day it became known, not before',
    ['2025-02-26', '2025-11-19', '2026-09-01'].every((d) => onPlane.trades.some((t) => t.date > d && t.date <= `${d.slice(0, 8)}31`)) &&
      !onPlane.trades.some((t) => t.date > '2024-11-21' && t.date <= '2025-02-26'));

  // The same backtest on today's numbers — each quarter's latest restatement,
  // stamped as if it had been known from the first report — is the lookahead
  // the point-in-time load exists to prevent, and it shows in the result.
  const todays = new History();
  for (const f of PRICES) todays.add(f.key, { validTime: f.validTime, knowledgeTime: f.knowledgeTime, value: f.value });
  todays.add('NVDA.revenue', { validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 29.4 });
  todays.add('NVDA.revenue', { validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08 });
  const leaked = run(todays);
  check('a backtest on today\'s restated numbers differs from the point-in-time one',
    leaked.equity.at(-1) !== onPlane.equity.at(-1), `${leaked.equity.at(-1)} against ${onPlane.equity.at(-1)}`);

  let incomplete;
  try {
    await loadHistory(as('analyst'), KEYS);
  } catch (e) {
    incomplete = e;
  }
  check('an unlicensed reader is refused the backtest, not given one on the versions it may see',
    incomplete instanceof IncompleteHistory && incomplete.key === 'NVDA.revenue' && incomplete.withheld.length === 3,
    incomplete?.message);
  check('though it may load the public prices', (await loadHistory(as('analyst'), ['price:NVDA'])).dates().length === PRICES.length);
} finally {
  dataplane.kill();
  try {
    execFileSync('psql', [PG, '-qc', `DROP SCHEMA ${schema} CASCADE`], { stdio: 'ignore' });
  } catch {
    // A database the run cannot clean is left to its owner; the schema is unique to this run.
  }
}
process.exit(failures > 0 ? 1 : 0);
