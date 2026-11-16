import { describe, expect, it } from 'vitest';
import { addNode, createDocument } from '@picasso/canvas-core';
import { BitemporalStore } from '../src/bitemporal.js';
import { classifiedSource, createFactTile, evaluateFactTile, evaluateFactTiles, localSource, type ClassifiedFact, type PointInTimeSource, type SourceRead } from '../src/factTile.js';
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

describe('every tile on a canvas at once', () => {
  const FACTS: ClassifiedFact[] = [
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, dataClass: 'public', source: '10-Q' },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, dataClass: 'licensed', vendor: 'vendor-b' },
    { key: 'AMD.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-30', value: 5.84, dataClass: 'public' },
  ];
  const tiles = () => [
    createFactTile({ id: 'a', key: 'NVDA.revenue' }),
    createFactTile({ id: 'b', key: 'AMD.revenue' }),
    createFactTile({ id: 'c', key: 'NVDA.revenue' }),
    createFactTile({ id: 'd', key: 'MSFT.revenue' }),
  ];
  const reader = (vendors: string[]) => ({ userId: 'u', tenantId: 't', vendors: new Set(vendors), positions: false, mnpi: false });
  /** The same source, read only in batches, counting them. */
  const batching = (base: PointInTimeSource) => {
    const batches: string[][] = [];
    const source: PointInTimeSource = {
      name: base.name,
      read: async () => {
        throw new Error('read key by key');
      },
      readMany: async (keys, knowledgeTime) => {
        batches.push([...keys]);
        return new Map(await Promise.all(keys.map(async (key) => [key, await base.read({ key, knowledgeTime })] as const)));
      },
    };
    return { source, batches };
  };

  it('settles each tile as it would alone, in one batch of the distinct keys', async () => {
    for (const vendors of [['vendor-b'], []]) {
      for (const time of [{ mode: 'pinned' as const, asof: THE_MORNING }, { mode: 'live' as const }]) {
        const base = classifiedSource(FACTS, reader(vendors));
        const alone = await Promise.all(tiles().map((t) => evaluateFactTile(t, base, time, TODAY)));
        const { source, batches } = batching(base);
        expect(await evaluateFactTiles(tiles(), source, time, TODAY)).toEqual(alone);
        expect(batches).toEqual([['NVDA.revenue', 'AMD.revenue', 'MSFT.revenue']]);
      }
    }
    // Live, the unlicensed reader's NVDA tiles are blocked, never the older public figure.
    const live = await evaluateFactTiles(tiles(), classifiedSource(FACTS, reader([])), { mode: 'live' }, TODAY);
    expect(live.map((v) => v.kind)).toEqual(['blocked', 'value', 'blocked', 'empty']);
  });

  it('reads key by key from a source that cannot batch, once per distinct key', async () => {
    const keys: string[] = [];
    const base = localSource(store());
    const counting: PointInTimeSource = { name: base.name, read: async (q) => (keys.push(q.key), base.read(q)) };
    await evaluateFactTiles(tiles(), counting, { mode: 'live' }, TODAY);
    expect(keys.sort()).toEqual(['AMD.revenue', 'MSFT.revenue', 'NVDA.revenue']);
  });

  it('discards only the tile whose own time moved while the batch was in flight', async () => {
    const nodes = tiles();
    const slow: PointInTimeSource = {
      name: 'slow',
      read: async () => ({ observations: [], blocked: [] }),
      readMany: async (keys) => {
        nodes[1]!.provenance = { ...nodes[1]!.provenance, asof: '2026-01-01T00:00:00Z' };
        return new Map(keys.map((k) => [k, { observations: [], blocked: [] }] as const));
      },
    };
    const out = await evaluateFactTiles(nodes, slow, { mode: 'pinned', asof: THE_MORNING }, TODAY);
    expect(out.map((v) => v.kind)).toEqual(['empty', 'superseded', 'empty', 'empty']);
  });
});
