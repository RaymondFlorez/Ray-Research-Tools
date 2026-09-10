import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode, type CanvasDocument } from '@picasso/canvas-core';
import {
  SnapshotCatalog,
  knowledgeTimeFor,
  isPinned,
  sameSnapshots,
  setCanvasAsOf,
  type StaleReason,
} from '../src/timescrub.js';

function catalog(): SnapshotCatalog {
  const c = new SnapshotCatalog();
  c.registerAll([
    { source: 'clickhouse', snapshotId: 'ch-1', committedAt: '2024-08-01T00:00:00Z' },
    { source: 'clickhouse', snapshotId: 'ch-2', committedAt: '2024-08-05T09:00:00Z' },
    { source: 'clickhouse', snapshotId: 'ch-3', committedAt: '2024-08-06T00:00:00Z' },
    { source: 'iceberg', snapshotId: 'ice-1', committedAt: '2024-07-01T00:00:00Z' },
    { source: 'iceberg', snapshotId: 'ice-2', committedAt: '2024-08-05T06:00:00Z' },
    // A source that did not exist until later.
    { source: 'polymarket', snapshotId: 'pm-1', committedAt: '2025-01-01T00:00:00Z' },
  ]);
  return c;
}

function docWith(bindings: Array<'loose' | 'bound' | 'wired'>): CanvasDocument {
  const doc = createDocument('semis');
  bindings.forEach((binding, i) => {
    const node = addNode(
      doc,
      createNode({ id: `n${i}`, kind: 'ChartNode', binding, position: { x: i * 10, y: 0 } }),
    );
    node.state = { status: 'ready', cacheKey: `key-${i}` };
  });
  return doc;
}

describe('snapshot resolution', () => {
  it('takes the newest snapshot committed at or before the asof', () => {
    const c = catalog();
    expect(c.resolveSource('clickhouse', '2024-08-05T12:00:00Z')?.snapshotId).toBe('ch-2');
    // Six hours earlier, the morning's snapshot had not landed yet.
    expect(c.resolveSource('clickhouse', '2024-08-05T03:00:00Z')?.snapshotId).toBe('ch-1');
  });

  it('resolves every source at once', () => {
    expect(catalog().resolve('2024-08-05T12:00:00Z')).toEqual({
      clickhouse: 'ch-2',
      iceberg: 'ice-2',
    });
  });

  it('omits a source that did not exist yet, rather than substituting its oldest data', () => {
    const c = catalog();
    const morning = c.resolve('2024-08-05T12:00:00Z');
    expect('polymarket' in morning).toBe(false);
    // And says so, so the canvas can mark that node unavailable.
    expect(c.missingAt('2024-08-05T12:00:00Z')).toEqual(['polymarket']);
    expect(c.missingAt('2025-06-01T00:00:00Z')).toEqual([]);
  });

  it('resolves nothing before any snapshot exists', () => {
    const c = catalog();
    expect(c.resolve('2020-01-01T00:00:00Z')).toEqual({});
    expect(c.missingAt('2020-01-01T00:00:00Z')).toEqual(['clickhouse', 'iceberg', 'polymarket']);
  });

  it('is order-independent: registration order does not change the answer', () => {
    const forwards = catalog().resolve('2024-08-05T12:00:00Z');
    const backwards = new SnapshotCatalog();
    backwards.registerAll([
      { source: 'iceberg', snapshotId: 'ice-2', committedAt: '2024-08-05T06:00:00Z' },
      { source: 'clickhouse', snapshotId: 'ch-3', committedAt: '2024-08-06T00:00:00Z' },
      { source: 'clickhouse', snapshotId: 'ch-1', committedAt: '2024-08-01T00:00:00Z' },
      { source: 'iceberg', snapshotId: 'ice-1', committedAt: '2024-07-01T00:00:00Z' },
      { source: 'clickhouse', snapshotId: 'ch-2', committedAt: '2024-08-05T09:00:00Z' },
      { source: 'polymarket', snapshotId: 'pm-1', committedAt: '2025-01-01T00:00:00Z' },
    ]);
    expect(backwards.resolve('2024-08-05T12:00:00Z')).toEqual(forwards);
  });
});

describe('the global time scrub', () => {
  it('stamps every computing node with the resolved snapshots and marks it stale', () => {
    const doc = docWith(['wired', 'wired', 'bound']);
    const reasons = new Map<string, StaleReason>();
    const result = setCanvasAsOf(doc, '2024-08-05T12:00:00Z', catalog(), { reasons });

    expect(result.invalidated).toEqual(['n0', 'n1', 'n2']);
    for (const node of doc.nodes.values()) {
      expect(node.state.status).toBe('stale');
      // The old cache key is gone: it was computed against different data.
      expect(node.state.cacheKey).toBeUndefined();
      expect(node.provenance.asof).toBe('2024-08-05T12:00:00Z');
      expect(node.provenance.datasetSnapshots).toEqual({ clickhouse: 'ch-2', iceberg: 'ice-2' });
    }
    // A number that moved because time was scrubbed is a different event from
    // one that moved because the market did.
    expect([...reasons.values()]).toEqual(['asof_changed', 'asof_changed', 'asof_changed']);
  });

  it('leaves loose objects alone: ink has no asof', () => {
    const doc = docWith(['loose', 'wired']);
    const result = setCanvasAsOf(doc, '2024-08-05T12:00:00Z', catalog());

    expect(result.skippedLoose).toEqual(['n0']);
    expect(result.invalidated).toEqual(['n1']);
    const sketch = doc.nodes.get('n0');
    expect(sketch?.state.status).toBe('ready');
    expect(sketch?.state.cacheKey).toBe('key-0');
  });

  it('reports sources with no data at that instant', () => {
    const doc = docWith(['wired']);
    expect(setCanvasAsOf(doc, '2024-08-05T12:00:00Z', catalog()).missingSources)
      .toEqual(['polymarket']);
  });

  it('gives each node its own copy of the snapshot set', () => {
    const doc = docWith(['wired', 'wired']);
    setCanvasAsOf(doc, '2024-08-05T12:00:00Z', catalog());
    const first = doc.nodes.get('n0')?.provenance.datasetSnapshots as Record<string, string>;
    const second = doc.nodes.get('n1')?.provenance.datasetSnapshots as Record<string, string>;
    expect(first).not.toBe(second);
    first.clickhouse = 'tampered';
    expect(second.clickhouse).toBe('ch-2');
  });
});

describe('reproducibility', () => {
  it('scrubbing to the same morning twice resolves to the same data', () => {
    const c = catalog();
    const first = c.resolve('2024-08-05T12:00:00Z');
    const second = c.resolve('2024-08-05T12:00:00Z');
    expect(sameSnapshots(first, second)).toBe(true);
  });

  it('a snapshot committed after the asof does not change a historical read', () => {
    const c = catalog();
    const before = c.resolve('2024-08-05T12:00:00Z');
    c.register({ source: 'clickhouse', snapshotId: 'ch-4', committedAt: '2026-01-01T00:00:00Z' });
    expect(sameSnapshots(c.resolve('2024-08-05T12:00:00Z'), before)).toBe(true);
  });

  it('tells different snapshot sets apart', () => {
    const c = catalog();
    expect(sameSnapshots(c.resolve('2024-08-05T12:00:00Z'), c.resolve('2024-08-07T00:00:00Z')))
      .toBe(false);
    expect(sameSnapshots({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameSnapshots({ a: '1' }, { b: '1' })).toBe(false);
  });
});

describe('live versus pinned', () => {
  it('a live canvas follows the tape rather than freezing at the moment of asking', () => {
    let clock = '2026-01-01T00:00:00Z';
    const now = (): string => clock;

    const live = { mode: 'live' } as const;
    expect(isPinned(live)).toBe(false);
    expect(knowledgeTimeFor(live, now)).toBe('2026-01-01T00:00:00Z');
    clock = '2026-01-01T00:00:01Z';
    expect(knowledgeTimeFor(live, now)).toBe('2026-01-01T00:00:01Z');
  });

  it('a pinned canvas ignores the clock', () => {
    const pinned = { mode: 'pinned', asof: '2024-08-05T12:00:00Z' } as const;
    expect(isPinned(pinned)).toBe(true);
    expect(knowledgeTimeFor(pinned, () => '2026-01-01T00:00:00Z')).toBe('2024-08-05T12:00:00Z');
  });
});
