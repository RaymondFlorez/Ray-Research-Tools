/**
 * Phase 1's exit criterion, as an executable test.
 *
 * "Global time scrub reproduces a historical morning exactly."
 *
 * The morning is 2024-08-05, the day of the yen-carry unwind. The canvas is
 * scrubbed back to 09:30 that morning and has to show what was on the screen
 * then — not today's numbers wearing that date. Between then and now:
 *
 *   - Q2 revenue was restated twice.
 *   - A 10-for-1 split went ex, rebasing every price before it.
 *   - Two later ClickHouse snapshots landed.
 *
 * Any one of those would silently change a naive historical read.
 */

import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode, type CanvasDocument } from '@picasso/canvas-core';
import { BitemporalStore, detectRestatementLeak, type Instant } from '../src/bitemporal.js';
import { adjustSeries, type CorporateAction, type PriceSeries } from '../src/adjustments.js';
import { SnapshotCatalog, sameSnapshots, setCanvasAsOf } from '../src/timescrub.js';

const THE_MORNING: Instant = '2024-08-05T09:30:00Z';
const TODAY: Instant = '2026-09-10T00:00:00Z';

function fundamentals(): BitemporalStore<number> {
  const store = new BitemporalStore<number>();
  store.appendAll([
    // Q2, first reported in August 2024 — this is what was on screen that day.
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04 },
    // Restated the following February, and again a year later.
    {
      key: 'NVDA.revenue',
      validTime: '2024-06-30',
      knowledgeTime: '2025-02-26',
      value: 29.87,
      restatement: true,
    },
    {
      key: 'NVDA.revenue',
      validTime: '2024-06-30',
      knowledgeTime: '2025-11-19',
      value: 29.71,
      restatement: true,
    },
    // A quarter that had not been reported on the morning in question.
    { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08 },
  ]);
  return store;
}

const prices: PriceSeries = {
  instrument: 'NVDA',
  points: [
    { validTime: '2024-07-01', value: 1240, knownAt: '2024-07-01' },
    { validTime: '2024-08-01', value: 1170, knownAt: '2024-08-01' },
    { validTime: '2024-08-05', value: 1010, knownAt: '2024-08-05' },
  ],
};

/** Announced and effective long after the morning being reproduced. */
const split: CorporateAction = {
  instrument: 'NVDA',
  kind: 'split',
  exDate: '2025-03-10',
  announcedAt: '2025-02-20',
  factor: 0.1,
  description: '10-for-1 split',
};

function catalog(): SnapshotCatalog {
  const c = new SnapshotCatalog();
  c.registerAll([
    { source: 'clickhouse', snapshotId: 'ch-0804', committedAt: '2024-08-04T22:00:00Z' },
    { source: 'clickhouse', snapshotId: 'ch-0805', committedAt: '2024-08-05T09:00:00Z' },
    { source: 'clickhouse', snapshotId: 'ch-0806', committedAt: '2024-08-06T09:00:00Z' },
    { source: 'iceberg', snapshotId: 'ice-0801', committedAt: '2024-08-01T00:00:00Z' },
    { source: 'iceberg', snapshotId: 'ice-2026', committedAt: '2026-01-01T00:00:00Z' },
  ]);
  return c;
}

function canvas(): CanvasDocument {
  const doc = createDocument('semis-and-duration');
  for (const [id, binding] of [
    ['revenue-tile', 'wired'],
    ['price-chart', 'wired'],
    ['margin-note', 'loose'],
  ] as const) {
    const node = addNode(doc, createNode({ id, kind: 'ChartNode', binding }));
    node.state = { status: 'ready', cacheKey: `live-${id}` };
    node.provenance = { datasetSnapshots: { clickhouse: 'ch-0806' }, asof: TODAY, verified: true };
  }
  return doc;
}

/** Everything the canvas would show, at one instant. */
function readCanvas(knowledgeTime: Instant) {
  const store = fundamentals();
  const revenue = store.asOf({ key: 'NVDA.revenue', knowledgeTime });
  const adjusted = adjustSeries(prices, [split], { knowledgeTime });
  return {
    revenue: revenue.map((o) => ({ validTime: o.validTime, value: o.value })),
    prices: adjusted.points.map((p) => ({ validTime: p.validTime, value: p.value })),
    factors: adjusted.factors.map((f) => f.factor),
    snapshots: catalog().resolve(knowledgeTime),
  };
}

describe('the time scrub reproduces a historical morning', () => {
  it('shows the numbers that were on the screen, not the ones that replaced them', () => {
    const morning = readCanvas(THE_MORNING);

    // Q2 revenue as first reported. The two later restatements do not exist yet.
    expect(morning.revenue).toEqual([{ validTime: '2024-06-30', value: 30.04 }]);

    // Prices on the pre-split basis, because the split was seven months away.
    expect(morning.prices.map((p) => p.value)).toEqual([1240, 1170, 1010]);
    expect(morning.factors).toEqual([1, 1, 1]);

    // The snapshot in force at 09:30, not the one that landed the next day.
    expect(morning.snapshots).toEqual({ clickhouse: 'ch-0805', iceberg: 'ice-0801' });
  });

  it('shows something different today, which is the point', () => {
    const morning = readCanvas(THE_MORNING);
    const today = readCanvas(TODAY);

    expect(today.revenue).toEqual([
      { validTime: '2024-06-30', value: 29.71 },
      { validTime: '2024-09-30', value: 35.08 },
    ]);
    expect(today.prices.map((p) => p.value)).toEqual([124, 117, 101]);

    expect(today.revenue).not.toEqual(morning.revenue);
    expect(today.prices).not.toEqual(morning.prices);
    expect(sameSnapshots(today.snapshots, morning.snapshots)).toBe(false);
  });

  it('does not show a quarter that had not been reported that morning', () => {
    const morning = readCanvas(THE_MORNING);
    expect(morning.revenue.some((r) => r.validTime === '2024-09-30')).toBe(false);
  });

  it('reproduces exactly: the same read twice is byte-identical', () => {
    expect(JSON.stringify(readCanvas(THE_MORNING))).toBe(JSON.stringify(readCanvas(THE_MORNING)));
  });

  it('stays reproducible after the world moves on', () => {
    const before = JSON.stringify(readCanvas(THE_MORNING));

    // A restatement, a new snapshot, and a fresh corporate action all arrive.
    const store = fundamentals();
    store.append({
      key: 'NVDA.revenue',
      validTime: '2024-06-30',
      knowledgeTime: '2026-09-01',
      value: 29.4,
      restatement: true,
    });
    const c = catalog();
    c.register({ source: 'clickhouse', snapshotId: 'ch-2026', committedAt: '2026-09-01T00:00:00Z' });

    expect(JSON.stringify(readCanvas(THE_MORNING))).toBe(before);
    // And the morning's snapshot is still the morning's snapshot.
    expect(c.resolve(THE_MORNING).clickhouse).toBe('ch-0805');
    expect(store.asOf({ key: 'NVDA.revenue', knowledgeTime: THE_MORNING })[0]?.value).toBe(30.04);
  });

  it('names what a backtest run on today’s data would have got wrong', () => {
    const leak = detectRestatementLeak(fundamentals(), 'NVDA.revenue', THE_MORNING, TODAY);
    expect(leak.differences).toEqual([
      { validTime: '2024-06-30', pointInTime: 30.04, latest: 29.71 },
    ]);
  });
});

describe('scrubbing the canvas itself', () => {
  it('re-pins every computing node to the morning and marks it stale', () => {
    const doc = canvas();
    const result = setCanvasAsOf(doc, THE_MORNING, catalog());

    expect(result.snapshots).toEqual({ clickhouse: 'ch-0805', iceberg: 'ice-0801' });
    expect(new Set(result.invalidated)).toEqual(new Set(['revenue-tile', 'price-chart']));
    expect(result.skippedLoose).toEqual(['margin-note']);

    for (const id of ['revenue-tile', 'price-chart']) {
      const node = doc.nodes.get(id);
      expect(node?.provenance.asof).toBe(THE_MORNING);
      expect(node?.provenance.datasetSnapshots.clickhouse).toBe('ch-0805');
      // The cached value was computed against today's data and is now wrong.
      expect(node?.state.cacheKey).toBeUndefined();
      expect(node?.state.status).toBe('stale');
    }
  });

  it('scrubbing back and forth returns the canvas to where it started', () => {
    const doc = canvas();
    setCanvasAsOf(doc, THE_MORNING, catalog());
    const atMorning = doc.nodes.get('revenue-tile')?.provenance.datasetSnapshots;

    setCanvasAsOf(doc, TODAY, catalog());
    expect(doc.nodes.get('revenue-tile')?.provenance.datasetSnapshots.clickhouse).toBe('ch-0806');

    setCanvasAsOf(doc, THE_MORNING, catalog());
    expect(doc.nodes.get('revenue-tile')?.provenance.datasetSnapshots).toEqual(atMorning);
  });

  it('leaves the analyst’s handwritten note untouched by time', () => {
    const doc = canvas();
    setCanvasAsOf(doc, THE_MORNING, catalog());
    const note = doc.nodes.get('margin-note');
    expect(note?.state.cacheKey).toBe('live-margin-note');
    expect(note?.provenance.asof).toBe(TODAY);
  });
});
