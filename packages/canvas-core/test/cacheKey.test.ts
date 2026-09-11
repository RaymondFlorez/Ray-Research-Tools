import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  cacheKeyPreimage,
  canonicalize,
  deriveCacheKey,
  nodeSignature,
  type CacheKeyInput,
} from '../src/cacheKey.js';
import { sha256Hex } from '../src/hash.js';
import { addNode, createDocument } from '../src/document.js';
import type { CanvasDocument, Edge } from '../src/types.js';
import { node, port } from './fixtures.js';

const base: CacheKeyInput = {
  nodeKind: 'MonteCarloNode',
  nodeVersion: '3',
  params: { paths: 100_000, process: 'heston' },
  upstream: {},
  datasetVersions: { clickhouse: 'snap-1' },
  modelFingerprints: [],
};

describe('canonical serialization', () => {
  it('is insensitive to key order but sensitive to values', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });

  it('keeps arrays ordered, because order is meaning', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('distinguishes null, absent and false', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
    expect(canonicalize({ a: false })).not.toBe(canonicalize({ a: null }));
    // undefined members are absent, so an explicitly-undefined param is not a change.
    expect(canonicalize({ a: undefined })).toBe(canonicalize({}));
  });

  it('normalizes -0 and refuses NaN', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
    expect(() => canonicalize(NaN)).toThrow(/NaN/);
  });
});

describe('cache keys (PRD 3.4.3)', () => {
  it('is stable for identical inputs and changes with any component', () => {
    const key = cacheKey(base);
    expect(cacheKey({ ...base })).toBe(key);
    expect(cacheKey({ ...base, nodeVersion: '4' })).not.toBe(key);
    expect(cacheKey({ ...base, nodeKind: 'BacktestNode' })).not.toBe(key);
    expect(cacheKey({ ...base, params: { ...base.params, paths: 200_000 } })).not.toBe(key);
    expect(cacheKey({ ...base, upstream: { in: 'abc' } })).not.toBe(key);
    expect(cacheKey({ ...base, datasetVersions: { clickhouse: 'snap-2' } })).not.toBe(key);
  });

  it('changes when the model version moves, so a number that moved for that reason says so', () => {
    const withModel = {
      ...base,
      modelFingerprints: [{ model: 'qwen-coder-32b', version: '2025-11-a', promptHash: 'p1' }],
    };
    const bumped = {
      ...base,
      modelFingerprints: [{ model: 'qwen-coder-32b', version: '2025-12-a', promptHash: 'p1' }],
    };
    expect(cacheKey(withModel)).not.toBe(cacheKey(bumped));
    expect(cacheKey(withModel)).not.toBe(cacheKey(base));
  });

  it('does not depend on the order fingerprints were collected in', () => {
    const one = { model: 'a', version: '1', promptHash: 'x' };
    const two = { model: 'b', version: '1', promptHash: 'y' };
    expect(cacheKey({ ...base, modelFingerprints: [one, two] })).toBe(
      cacheKey({ ...base, modelFingerprints: [two, one] }),
    );
  });

  it('exposes the preimage so a cache miss can be diffed', () => {
    expect(cacheKeyPreimage(base)).toContain('MonteCarloNode');
    expect(cacheKeyPreimage(base)).toContain('snap-1');
  });

  it('accepts an injected hash function', () => {
    const key = cacheKey(base, (s) => `len:${s.length}`);
    expect(key.startsWith('len:')).toBe(true);
  });
});

describe('SHA-256 default', () => {
  it('matches published vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('a'.repeat(1_000_000)).slice(0, 16)).toBe('cdc76e5c9914fb92');
  });

  it('handles multibyte input as UTF-8', () => {
    expect(sha256Hex('naïve café')).toHaveLength(64);
    expect(sha256Hex('naïve café')).not.toBe(sha256Hex('naive cafe'));
  });
});

describe('deriving keys from the document', () => {
  function chain(): CanvasDocument {
    const doc = createDocument('c');
    addNode(
      doc,
      node({
        id: 'src',
        kind: 'DataTile',
        outputs: [port('out', 'series')],
        params: { ticker: 'NVDA' },
      }),
    );
    addNode(
      doc,
      node({
        id: 'calc',
        kind: 'TransformNode',
        inputs: [port('in', 'series')],
        outputs: [port('out', 'series')],
        params: { op: 'zscore' },
      }),
    );
    const edge: Edge = {
      id: 'e1',
      from: { nodeId: 'src', portId: 'out' },
      to: { nodeId: 'calc', portId: 'in' },
      class: 'data',
    };
    doc.edges.set(edge.id, edge);
    return doc;
  }

  it('folds the upstream key into the downstream key', () => {
    const doc = chain();
    const srcKey = deriveCacheKey(doc, 'src');
    expect(srcKey).toBeDefined();
    const src = doc.nodes.get('src');
    if (!src || !srcKey) throw new Error('missing');
    src.state.cacheKey = srcKey;

    const calcKey = deriveCacheKey(doc, 'calc');
    expect(calcKey).toBeDefined();

    // Change the upstream and the downstream key must move with it.
    src.params = { ticker: 'AMD' };
    const newSrcKey = deriveCacheKey(doc, 'src');
    if (!newSrcKey) throw new Error('missing');
    expect(newSrcKey).not.toBe(srcKey);
    src.state.cacheKey = newSrcKey;
    expect(deriveCacheKey(doc, 'calc')).not.toBe(calcKey);
  });

  it('returns undefined while an upstream key is unknown', () => {
    const doc = chain();
    expect(deriveCacheKey(doc, 'calc')).toBeUndefined();
  });

  it('folds the implicit adapter into the key', () => {
    const doc = chain();
    const src = doc.nodes.get('src');
    const edge = doc.edges.get('e1');
    if (!src || !edge) throw new Error('missing');
    src.state.cacheKey = 'upstream-key';

    const plain = deriveCacheKey(doc, 'calc');
    edge.adapter = 'latest';
    expect(deriveCacheKey(doc, 'calc')).not.toBe(plain);
  });

  it('gives loose objects no cache key at all', () => {
    const doc = chain();
    const src = doc.nodes.get('src');
    if (!src) throw new Error('missing');
    src.binding = 'loose';
    expect(deriveCacheKey(doc, 'src')).toBeUndefined();
  });

  it('names a node by kind and version', () => {
    const n = node({ kind: 'BacktestNode' });
    n.nodeVersion = '2';
    expect(nodeSignature(n)).toBe('BacktestNode@2');
  });
});
