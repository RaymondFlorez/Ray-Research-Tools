/**
 * Content-addressed cache keys (PRD 3.4.3).
 *
 *   cacheKey = hash(
 *     nodeKind || nodeVersion || sortedParams || upstreamCacheKeys ||
 *     datasetVersionIDs || modelFingerprints
 *   )
 *
 * The derivation has to be stable across client and server and across sessions,
 * so everything that feeds it is canonicalized: object keys sorted, upstream
 * keys ordered by the port they arrive on, `undefined` distinguished from
 * absent. Two nodes that would compute the same value get the same key; two
 * that would not, never do.
 */

import type { CanvasDocument, NodeID, ParamValue, PicassoNode } from './types.js';
import { hash as defaultHash, type HashFn } from './hash.js';

/** Identifies the exact model that produced an AI value (PRD 4.7 determinism). */
export interface ModelFingerprint {
  model: string;
  version: string;
  seed?: number;
  /** Hash of the rendered prompt, not the prompt itself. */
  promptHash: string;
  temperature?: number;
}

export interface CacheKeyInput {
  nodeKind: string;
  nodeVersion: string;
  params: Record<string, ParamValue>;
  /** Upstream cache keys, keyed by the input port they arrive on. */
  upstream: Record<string, string>;
  /** source -> Iceberg snapshot ID, pinning point-in-time reads. */
  datasetVersions: Record<string, string>;
  modelFingerprints: ModelFingerprint[];
}

/** Deterministic serialization: sorted keys, explicit nulls, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    // -0 and 0 are the same input to a computation; NaN is not a valid param.
    if (Number.isNaN(value)) throw new TypeError('NaN cannot appear in a cache key');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported value in cache key: ${typeof value}`);
}

/** The exact string that gets hashed. Exposed for debugging a cache miss. */
export function cacheKeyPreimage(input: CacheKeyInput): string {
  const fingerprints = [...input.modelFingerprints].sort((a, b) => {
    const ka = `${a.model}|${a.version}|${a.promptHash}`;
    const kb = `${b.model}|${b.version}|${b.promptHash}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return [
    input.nodeKind,
    input.nodeVersion,
    canonicalize(input.params),
    canonicalize(input.upstream),
    canonicalize(input.datasetVersions),
    canonicalize(fingerprints),
  ].join(' ');
}

export function cacheKey(input: CacheKeyInput, hashFn: HashFn = defaultHash): string {
  return hashFn(cacheKeyPreimage(input));
}

export interface DeriveOptions {
  modelFingerprints?: ModelFingerprint[];
  hashFn?: HashFn;
}

/**
 * Derives the key for one node from the document. Upstream keys are read from
 * the feeding nodes' runtime state, so callers must derive in topological order.
 *
 * Returns undefined when the node is `loose` (loose objects never hold a cache
 * key) or when an upstream key is not yet known.
 */
export function deriveCacheKey(
  doc: CanvasDocument,
  nodeId: NodeID,
  options: DeriveOptions = {},
): string | undefined {
  const node = doc.nodes.get(nodeId);
  if (!node || node.binding === 'loose') return undefined;

  const upstream: Record<string, string> = {};
  for (const edge of doc.edges.values()) {
    if (edge.class !== 'data' || edge.to.nodeId !== nodeId) continue;
    const source = doc.nodes.get(edge.from.nodeId);
    if (!source) return undefined;
    const key = source.state.cacheKey;
    if (key === undefined) return undefined;
    // Many-cardinality ports can take several inputs; slots are named after the
    // source port so the key does not depend on edge insertion order.
    const slot = `${edge.to.portId}:${edge.from.nodeId}.${edge.from.portId}`;
    upstream[slot] = edge.adapter ? `${edge.adapter}(${key})` : key;
  }

  return cacheKey(
    {
      nodeKind: node.kind,
      nodeVersion: node.nodeVersion ?? '0',
      params: node.params,
      upstream,
      datasetVersions: node.provenance.datasetSnapshots,
      modelFingerprints: options.modelFingerprints ?? [],
    },
    options.hashFn,
  );
}

/** Node kind and version pair used by the orchestrator's node registry. */
export function nodeSignature(node: PicassoNode): string {
  return `${node.kind}@${node.nodeVersion ?? '0'}`;
}
