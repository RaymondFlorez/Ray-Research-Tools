/**
 * The collaboration seam: two clients, one document, and the computation that
 * deliberately does not travel with it.
 *
 * PRD 3.7: "The document syncs; the computation does not, so no one inherits a
 * stale cache key from a peer."
 *
 * That sentence is a claim about two packages at once and neither can check it
 * alone. `canvas-sync` knows what crosses the wire but not what a cache key is
 * made of; `canvas-core` derives cache keys but has never seen a document that
 * arrived over a CRDT. The interesting failure lives exactly between them: if
 * a field that feeds `deriveCacheKey` were dropped from the synced schema, two
 * clients would compute *different* keys for the same node and each would
 * believe the other's cached results were stale forever — or worse, agree on a
 * key while disagreeing about the inputs behind it.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createNode,
  deriveCacheKey,
  schedule,
  topologicalOrder,
  type CanvasDocument,
  type Edge,
  type PicassoNode,
} from '@picasso/canvas-core';
import { SyncedCanvas } from '@picasso/canvas-sync';

/** Replays every update from `a` into `b` and back, until both are converged. */
function sync(a: SyncedCanvas, b: SyncedCanvas): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
}

function tile(id: string): PicassoNode {
  return createNode({
    id,
    kind: 'DataTile',
    binding: 'bound',
    params: { symbol: 'NVDA', frequency: 'daily' },
    outputs: [{ id: 'out', name: 'price', type: 'series', cardinality: 'one', required: false }],
    provenance: { datasetSnapshots: { prices: 'snap-441' }, asof: '2026-03-11', verified: true },
    nodeVersion: '2',
  });
}

function transform(id: string): PicassoNode {
  return createNode({
    id,
    kind: 'TransformNode',
    binding: 'wired',
    params: { op: 'zscore', lookback: 60 },
    inputs: [{ id: 'in', name: 'series', type: 'series', cardinality: 'one', required: true }],
    outputs: [{ id: 'out', name: 'z', type: 'series', cardinality: 'one', required: false }],
    provenance: { datasetSnapshots: {}, asof: '2026-03-11', verified: true },
    nodeVersion: '5',
  });
}

const WIRE: Edge = {
  id: 'e1',
  from: { nodeId: 'tile', portId: 'out' },
  to: { nodeId: 'zscore', portId: 'in' },
  class: 'data',
  adapter: 'resample',
};

/** Derive keys down the chain, in topological order, as a client would. */
function deriveAll(doc: CanvasDocument): Map<string, string | undefined> {
  const keys = new Map<string, string | undefined>();
  for (const id of topologicalOrder(doc)) {
    const key = deriveCacheKey(doc, id);
    keys.set(id, key);
    const node = doc.nodes.get(id);
    if (node && key !== undefined) node.state = { ...node.state, cacheKey: key };
  }
  return keys;
}

function twoClients(): [SyncedCanvas, SyncedCanvas] {
  const maya = new SyncedCanvas({ id: 'canvas-1' });
  maya.addNode(tile('tile'));
  maya.addNode(transform('zscore'));
  maya.addEdge(WIRE);
  const sam = new SyncedCanvas({ id: 'canvas-1' });
  sync(maya, sam);
  return [maya, sam];
}

describe('what crosses the wire is enough to reproduce a cache key', () => {
  // The property neither package can test alone.
  it('two clients derive the same key for the same node', () => {
    const [maya, sam] = twoClients();
    const mine = deriveAll(maya.snapshot());
    const theirs = deriveAll(sam.snapshot());

    expect(mine.get('tile')).toBeDefined();
    expect(mine.get('zscore')).toBeDefined();
    expect(theirs.get('tile')).toBe(mine.get('tile'));
    expect(theirs.get('zscore')).toBe(mine.get('zscore'));
  });

  // Every field below feeds deriveCacheKey. If one stopped crossing the wire,
  // the peer's key would not move when the field did, and this would catch it.
  it.each([
    ['a param', (c: SyncedCanvas) => c.setParam('zscore', 'lookback', 120)],
    ['the dataset snapshot', (c: SyncedCanvas) => c.setProvenance('tile', { datasetSnapshots: { prices: 'snap-999' }, asof: '2026-03-12', verified: true })],
    ['the node version', (c: SyncedCanvas) => c.setNodeVersion('zscore', '6')],
  ])('a change to %s moves the peer\'s key too', (_label, mutate) => {
    const [maya, sam] = twoClients();
    const before = deriveAll(sam.snapshot());

    mutate(maya);
    sync(maya, sam);

    const after = deriveAll(sam.snapshot());
    expect(after.get('zscore')).not.toBe(before.get('zscore'));
    // And the two clients still agree with each other.
    expect(after.get('zscore')).toBe(deriveAll(maya.snapshot()).get('zscore'));
  });

  // The adapter is part of the upstream slot, so a silently-dropped adapter
  // would produce agreeing keys for two different computations.
  it('carries the edge adapter into the key', () => {
    const [maya, sam] = twoClients();
    const withAdapter = deriveAll(sam.snapshot()).get('zscore');

    maya.removeEdge('e1');
    const { adapter: _dropped, ...bare } = WIRE;
    maya.addEdge(bare as Edge);
    sync(maya, sam);

    expect(deriveAll(sam.snapshot()).get('zscore')).not.toBe(withAdapter);
  });
});

describe('the computation does not travel', () => {
  // "no one inherits a stale cache key from a peer"
  it('gives an arriving wired node no cached state at all', () => {
    const [maya, sam] = twoClients();
    // Maya computes hers.
    deriveAll(maya.snapshot());

    const arrived = sam.snapshot().nodes.get('zscore')!;
    expect(arrived.state.cacheKey).toBeUndefined();
    expect(arrived.state.status).toBe('stale');
  });

  it('gives an arriving loose object nothing to compute', () => {
    const maya = new SyncedCanvas({ id: 'c' });
    maya.addNode(createNode({ id: 'sticky', kind: 'TextPad', binding: 'loose' }));
    const sam = new SyncedCanvas({ id: 'c' });
    sync(maya, sam);
    expect(sam.snapshot().nodes.get('sticky')!.state.status).toBe('idle');
  });

  it('schedules the arrived nodes as work, in dependency order', () => {
    const [, sam] = twoClients();
    const doc = sam.snapshot();
    const result = schedule(doc, { visible: ['zscore'] });
    // The upstream tile is pulled in because the visible node needs it.
    expect(result.order).toEqual(['tile', 'zscore']);
  });
});

describe('an offline split, then a merge', () => {
  it('keeps both sides\' work and converges', () => {
    const [maya, sam] = twoClients();

    // Offline: each adds a node the other cannot see yet.
    maya.addNode(createNode({ id: 'maya-chart', kind: 'ChartNode', binding: 'bound' }));
    sam.addNode(createNode({ id: 'sam-table', kind: 'TableNode', binding: 'bound' }));
    expect(maya.snapshot().nodes.has('sam-table')).toBe(false);
    expect(sam.snapshot().nodes.has('maya-chart')).toBe(false);

    sync(maya, sam);

    for (const client of [maya, sam]) {
      const ids = [...client.snapshot().nodes.keys()].sort();
      expect(ids).toEqual(['maya-chart', 'sam-table', 'tile', 'zscore']);
    }
  });

  // Params are their own map precisely so this works.
  it('keeps two concurrent edits to different params on one node', () => {
    const [maya, sam] = twoClients();
    maya.setParam('zscore', 'lookback', 120);
    sam.setParam('zscore', 'op', 'rank');
    sync(maya, sam);

    for (const client of [maya, sam]) {
      const node = client.snapshot().nodes.get('zscore')!;
      expect(node.params.lookback).toBe(120);
      expect(node.params.op).toBe('rank');
    }
    // And both still agree on the key that follows from those params.
    expect(deriveAll(maya.snapshot()).get('zscore')).toBe(deriveAll(sam.snapshot()).get('zscore'));
  });

  // Half-applied, the document briefly holds an edge whose endpoint is gone,
  // and every peer would render that state.
  it('removes a node and its edges atomically, so no peer sees a dangling wire', () => {
    const [maya, sam] = twoClients();
    maya.removeNode('tile');
    sync(maya, sam);

    const doc = sam.snapshot();
    expect(doc.nodes.has('tile')).toBe(false);
    expect([...doc.edges.values()].some((e) => e.from.nodeId === 'tile')).toBe(false);
    // The orphaned transform is still schedulable rather than throwing.
    expect(() => topologicalOrder(doc)).not.toThrow();
  });
});
