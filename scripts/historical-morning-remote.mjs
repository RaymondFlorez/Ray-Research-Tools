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
 *   - a restatement that arrives later leaves the morning byte-identical.
 *
 * Needs DATAPLANE_PG_URL, Go, and canvas-data built (npm run build).
 *
 *   DATAPLANE_PG_URL=postgres://... node scripts/historical-morning-remote.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { BitemporalStore, RemotePointInTime, DataPlaneError } = await import(join(ROOT, 'packages/canvas-data/dist/index.js'));

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
const dataplane = spawn(binary, ['-addr', `127.0.0.1:${PORT}`, '-users', `${config}/users.json`, '-symbology', `${config}/symbology.json`, '-pg', PG, '-schema', schema, '-migrate'], { stdio: ['ignore', 'ignore', 'inherit'] });

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
} finally {
  dataplane.kill();
  try {
    execFileSync('psql', [PG, '-qc', `DROP SCHEMA ${schema} CASCADE`], { stdio: 'ignore' });
  } catch {
    // A database the run cannot clean is left to its owner; the schema is unique to this run.
  }
}
process.exit(failures > 0 ? 1 : 0);
