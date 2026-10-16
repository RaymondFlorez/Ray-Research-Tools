/**
 * The contract between this package and the Go data plane.
 *
 * PRD 2.3 puts point-in-time reads and entitlements in `data-access` and
 * conflation in `stream-ingest`, both Go services. This package holds the same
 * rules in TypeScript, for the browser and for every test that came before
 * them. Two implementations of one rule drift unless something holds them
 * together, so this test writes down what the TypeScript does on a fixed set
 * of cases — `services/dataplane/testdata/conformance.json` — and the Go tests
 * read the same file and must produce the same answers, to the bit.
 *
 * The file is checked in. This test fails if the TypeScript no longer produces
 * it; `UPDATE_CONFORMANCE=1` rewrites it, which is a change to the contract and
 * reads as one in review.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BitemporalStore, type AsOfQuery, type Fact } from '../src/bitemporal.js';
import { Conflator, TRADE_FIELDS, type Tick } from '../src/conflate.js';
import { checkEntitlement, type ClassifiedRecord, type DataClass, type Entitlements } from '../src/entitlements.js';

const FILE = fileURLToPath(new URL('../../../services/dataplane/testdata/conformance.json', import.meta.url));

/** Integer-only, so the cases are the same on every machine. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

const day = (d: number) => new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10);
const instant = (d: number, h: number) => `${day(d)}T${String(h).padStart(2, '0')}:00:00Z`;

function pitCases() {
  const facts: Fact<number>[] = [
    // The historical morning: Q2 reported, restated twice, and Q3 not yet known.
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, source: '10-Q' },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, restatement: true },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-11-19', value: 29.71, restatement: true },
    { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08 },
    // Two versions known at the same instant: the later append wins.
    { key: 'TIE', validTime: '2024-03-31', knowledgeTime: '2024-04-02', value: 1 },
    { key: 'TIE', validTime: '2024-03-31', knowledgeTime: '2024-04-02', value: 2 },
  ];
  const next = lcg(7);
  for (let k = 0; k < 400; k += 1) {
    const valid = next(60);
    facts.push({
      key: `S${next(4)}`,
      validTime: day(valid),
      // Known on the day or up to a month later, at one of a few hours.
      knowledgeTime: instant(valid + next(30), [8, 16, 22][next(3)]!),
      value: next(100_000) / 100 - 400,
      ...(next(5) === 0 ? { source: 'vendor-b' } : {}),
    });
  }
  const store = new BitemporalStore<number>();
  store.appendAll(facts);

  const queries: AsOfQuery[] = [
    { key: 'NVDA.revenue', knowledgeTime: '2024-08-05T09:30:00Z' },
    { key: 'NVDA.revenue', knowledgeTime: '2026-09-10T00:00:00Z' },
    { key: 'NVDA.revenue', knowledgeTime: '2025-03-01', from: '2024-07-01' },
    { key: 'TIE', knowledgeTime: '2024-04-02' },
    { key: 'TIE', knowledgeTime: '2024-04-01' },
    { key: 'MISSING', knowledgeTime: '2030-01-01' },
  ];
  for (let k = 0; k < 60; k += 1) {
    const q: AsOfQuery = { key: `S${next(4)}`, knowledgeTime: instant(next(90), [0, 9, 16, 23][next(4)]!) };
    if (next(3) === 0) q.from = day(next(40));
    if (next(3) === 0) q.to = day(20 + next(40));
    queries.push(q);
  }
  const histories = [
    { key: 'NVDA.revenue', validTime: '2024-06-30' },
    ...Array.from({ length: 10 }, () => ({ key: `S${next(4)}`, validTime: day(next(60)) })),
  ];
  return {
    facts,
    asOf: queries.map((query) => ({ query, expected: store.asOf(query) })),
    history: histories.map(({ key, validTime }) => ({ key, validTime, expected: store.history(key, validTime) })),
  };
}

function conflateCases() {
  const next = lcg(11);
  const ticks: Tick[] = [];
  let t = 1_700_000_000_000;
  for (let k = 0; k < 600; k += 1) {
    t += next(120);
    const series = ['NVDA', 'AMD', 'AVGO', 'TSM'][next(4)]!;
    const price = 100 + next(2_000) / 100;
    // Now and then a tick arrives late: older than the one before it.
    const at = next(25) === 0 ? t - 300 : t;
    const values: Record<string, number> = { price, size: 1 + next(500) };
    if (next(2) === 0) values.high = price + next(50) / 100;
    if (next(2) === 0) values.low = price - next(50) / 100;
    if (next(3) === 0) values.open = price;
    if (series === 'TSM') values.bid = price - 0.01;
    ticks.push({ seriesId: series, t: at, values });
  }
  // Drained on a 100ms timer, and then everything left at shutdown.
  const conflator = new Conflator({ fields: { TSM: { ...TRADE_FIELDS, bid: 'last' } } });
  const drains: Array<{ now: number; updates: ReturnType<Conflator['drain']> }> = [];
  let clock = ticks[0]!.t;
  let i = 0;
  while (i < ticks.length) {
    clock += 100;
    while (i < ticks.length && ticks[i]!.t <= clock) {
      conflator.accept(ticks[i]!);
      i += 1;
    }
    drains.push({ now: clock, updates: conflator.drain(clock) });
  }
  const flushed = conflator.flush();
  return {
    windowMs: 250,
    defaultFields: TRADE_FIELDS,
    fields: { TSM: { ...TRADE_FIELDS, bid: 'last' } },
    ticks,
    drains: drains.filter((d) => d.updates.length > 0),
    drainTimes: drains.map((d) => d.now),
    flushed,
    stats: { accepted: conflator.stats.accepted, emitted: conflator.stats.emitted },
  };
}

function entitlementCases() {
  const records: ClassifiedRecord[] = [
    { id: 'px', dataClass: 'public' },
    { id: 'bars', dataClass: 'licensed', vendor: 'vendor-a' },
    { id: 'chain', dataClass: 'licensed', vendor: 'vendor-b' },
    { id: 'orphan', dataClass: 'licensed' },
    { id: 'book', dataClass: 'positions' },
    { id: 'wall-cross', dataClass: 'mnpi_risk' },
  ];
  const users: Array<Omit<Entitlements, 'vendors'> & { vendors: string[] }> = [
    { userId: 'analyst', tenantId: 't1', vendors: ['vendor-a'], positions: false, mnpi: false },
    { userId: 'pm', tenantId: 't1', vendors: ['vendor-a', 'vendor-b'], positions: true, mnpi: false },
    { userId: 'compliance', tenantId: 't1', vendors: [], positions: true, mnpi: true },
  ];
  return users.flatMap((user) =>
    records.map((record) => ({
      user,
      record,
      expected: checkEntitlement(record, { ...user, vendors: new Set(user.vendors) }),
    })),
  );
}

describe('the contract with the Go data plane', () => {
  it('is what the TypeScript produces', () => {
    const contract = {
      note: 'Generated by packages/canvas-data/test/conformance.test.ts. Do not edit by hand.',
      dataClasses: ['public', 'licensed', 'positions', 'mnpi_risk'] satisfies DataClass[],
      pointInTime: pitCases(),
      conflation: conflateCases(),
      entitlements: entitlementCases(),
    };
    const written = `${JSON.stringify(contract, null, 1)}\n`;
    if (process.env.UPDATE_CONFORMANCE === '1') writeFileSync(FILE, written);
    expect(readFileSync(FILE, 'utf8')).toBe(written);
  });
});
