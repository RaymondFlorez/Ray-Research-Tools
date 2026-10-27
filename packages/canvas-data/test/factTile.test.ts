import { describe, expect, it } from 'vitest';
import { addNode, createDocument } from '@picasso/canvas-core';
import { BitemporalStore } from '../src/bitemporal.js';
import { createFactTile, evaluateFactTile, localSource, type PointInTimeSource, type SourceRead } from '../src/factTile.js';
import { SnapshotCatalog, setCanvasAsOf } from '../src/timescrub.js';

const THE_MORNING = '2024-08-05T09:30:00Z';
const TODAY = () => '2026-09-10T00:00:00Z';

function store() {
  const s = new BitemporalStore<number>();
  s.appendAll([
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, source: '10-Q' },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, restatement: true },
    { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08, source: '10-Q' },
  ]);
  return s;
}

describe('a fact tile on a scrubbed canvas', () => {
  it('shows the latest period known that morning, and the latest known today', async () => {
    const doc = createDocument('c');
    const tile = addNode(doc, createFactTile({ id: 'rev', key: 'NVDA.revenue' }));
    const catalog = new SnapshotCatalog();
    catalog.register({ source: 'iceberg', snapshotId: 'ice-0801', committedAt: '2024-08-01T00:00:00Z' });
    setCanvasAsOf(doc, THE_MORNING, catalog);
    expect(tile.state.status).toBe('stale');

    const morning = await evaluateFactTile(tile, localSource(store()), { mode: 'pinned', asof: THE_MORNING }, TODAY);
    expect(morning).toEqual({
      kind: 'value', key: 'NVDA.revenue', validTime: '2024-06-30', value: 30.04, knownAt: '2024-07-24',
      asof: THE_MORNING, source: 'local store · 10-Q',
    });
    expect(tile.state.status).toBe('ready');
    expect(tile.provenance.asof).toBe(THE_MORNING);

    const live = await evaluateFactTile(tile, localSource(store()), { mode: 'live' }, TODAY);
    expect(live).toMatchObject({ kind: 'value', validTime: '2024-09-30', value: 35.08, asof: '2026-09-10T00:00:00Z' });
  });

  it('is empty, not zero, before anything was known', async () => {
    const tile = createFactTile({ id: 'rev', key: 'NVDA.revenue' });
    expect(await evaluateFactTile(tile, localSource(store()), { mode: 'pinned', asof: '2024-01-01' }, TODAY)).toEqual({
      kind: 'empty', key: 'NVDA.revenue', asof: '2024-01-01',
    });
  });
});

function canned(read: SourceRead): PointInTimeSource {
  return { name: 'canned', read: async () => read };
}

describe('the rules a tile cannot bend', () => {
  it('shows blocked when the latest period is blocked, not the period before it', async () => {
    const tile = createFactTile({ id: 'rev', key: 'NVDA.revenue' });
    const r = await evaluateFactTile(tile, canned({
      observations: [{ validTime: '2024-06-30', value: 30.04, knownAt: '2024-07-24' }],
      blocked: [{ validTime: '2024-09-30', message: 'Requires a vendor-b licence.' }],
    }), { mode: 'live' }, TODAY);
    expect(r).toEqual({ kind: 'blocked', key: 'NVDA.revenue', validTime: '2024-09-30', message: 'Requires a vendor-b licence.', asof: TODAY() });
    // An older blocked period under a newer visible one does not hide the newer one.
    const ok = await evaluateFactTile(tile, canned({
      observations: [{ validTime: '2024-09-30', value: 35.08, knownAt: '2024-11-20' }],
      blocked: [{ validTime: '2024-06-30', message: 'Requires a vendor-b licence.' }],
    }), { mode: 'live' }, TODAY);
    expect(ok).toMatchObject({ kind: 'value', value: 35.08 });
  });

  it('discards a read that lands after the canvas was scrubbed elsewhere', async () => {
    const doc = createDocument('c');
    const tile = addNode(doc, createFactTile({ id: 'rev', key: 'NVDA.revenue' }));
    let release!: () => void;
    const slow: PointInTimeSource = {
      name: 'slow',
      read: () => new Promise((resolve) => {
        release = () => resolve({ observations: [{ validTime: '2024-06-30', value: 30.04, knownAt: '2024-07-24' }], blocked: [] });
      }),
    };
    const inFlight = evaluateFactTile(tile, slow, { mode: 'pinned', asof: THE_MORNING }, TODAY);
    // The analyst scrubs to today before the morning's answer arrives.
    setCanvasAsOf(doc, '2026-09-10T00:00:00Z', new SnapshotCatalog());
    release();
    expect(await inFlight).toEqual({ kind: 'superseded', key: 'NVDA.revenue', asof: THE_MORNING });
    // Nothing settled: the node is still waiting on the read for where it is now.
    expect(tile.state.status).toBe('stale');
    expect(tile.provenance.asof).toBe('2026-09-10T00:00:00Z');
  });
});
