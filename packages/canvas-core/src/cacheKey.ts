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
 * The inputs a node's key is derived from, read off the document — what
 * `explainKeyChange` compares. Upstream keys are read from the feeding nodes'
 * runtime state, so callers must derive in topological order.
 *
 * Undefined when the node is `loose` (loose objects never hold a cache key) or
 * when an upstream key is not yet known.
 */
export function cacheKeyInput(
  doc: CanvasDocument,
  nodeId: NodeID,
  options: Pick<DeriveOptions, 'modelFingerprints'> = {},
): CacheKeyInput | undefined {
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

  return {
    nodeKind: node.kind,
    nodeVersion: node.nodeVersion ?? '0',
    params: node.params,
    upstream,
    datasetVersions: node.provenance.datasetSnapshots,
    modelFingerprints: options.modelFingerprints ?? [],
  };
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
  const input = cacheKeyInput(doc, nodeId, options);
  return input === undefined ? undefined : cacheKey(input, options.hashFn);
}

/** Node kind and version pair used by the orchestrator's node registry. */
export function nodeSignature(node: PicassoNode): string {
  return `${node.kind}@${node.nodeVersion ?? '0'}`;
}

/**
 * Why a node's cache key moved (PRD 4.7).
 *
 * > Model version changes mark those nodes stale with an explicit reason so the
 * > analyst knows a number moved because the model changed, not because the
 * > market did.
 *
 * A new key says *that* something changed; the badge has to say *what*. Each
 * reason names one input of the key, and model reasons come first, because "the
 * model changed" is the one an analyst would otherwise mistake for the market.
 */
export type StaleReason =
  | { kind: 'model_version'; model: string; from: string; to: string }
  | { kind: 'model_added'; model: string; version: string }
  | { kind: 'model_removed'; model: string; version: string }
  /** Same model and version, but a call's prompt, seed or temperature moved, or a call was added or dropped (`calls`). */
  | { kind: 'model_call'; model: string; fields: string[] }
  | { kind: 'dataset'; source: string; from?: string; to?: string }
  | { kind: 'params'; keys: string[] }
  | { kind: 'upstream'; slots: string[] }
  | { kind: 'node_version'; from: string; to: string };

const RANK: Record<StaleReason['kind'], number> = {
  model_version: 0,
  model_added: 1,
  model_removed: 1,
  model_call: 2,
  dataset: 3,
  params: 4,
  upstream: 5,
  node_version: 6,
};

/** Every input of the key that differs between `before` and `after`, model reasons first. */
export function explainKeyChange(before: CacheKeyInput, after: CacheKeyInput): StaleReason[] {
  const reasons: StaleReason[] = [];

  // Grouped by model, because one model can contribute more than one call to
  // a value; a map keyed by name alone would let the second call's change go
  // unexplained.
  const byModel = (list: ModelFingerprint[]) => {
    const groups = new Map<string, ModelFingerprint[]>();
    for (const f of list) groups.set(f.model, [...(groups.get(f.model) ?? []), f]);
    for (const group of groups.values()) group.sort((a, b) => (canonicalize(a) < canonicalize(b) ? -1 : 1));
    return groups;
  };
  const was = byModel(before.modelFingerprints);
  const now = byModel(after.modelFingerprints);
  const versions = (group: ModelFingerprint[]) => [...new Set(group.map((f) => f.version))].sort().join(', ');
  for (const [model, old] of was) {
    const next = now.get(model);
    if (!next) {
      reasons.push({ kind: 'model_removed', model, version: versions(old) });
      continue;
    }
    if (versions(old) !== versions(next)) {
      reasons.push({ kind: 'model_version', model, from: versions(old), to: versions(next) });
      continue;
    }
    if (canonicalize(old) === canonicalize(next)) continue;
    // A call added or dropped is "calls"; otherwise the fields that differ.
    const fields =
      old.length !== next.length
        ? ['calls']
        : (['promptHash', 'seed', 'temperature'] as const).filter((f) => old.some((call, i) => call[f] !== next[i]![f]));
    reasons.push({ kind: 'model_call', model, fields: fields.length > 0 ? [...fields] : ['calls'] });
  }
  for (const [model, next] of now) {
    if (!was.has(model)) reasons.push({ kind: 'model_added', model, version: versions(next) });
  }

  const sources = new Set([...Object.keys(before.datasetVersions), ...Object.keys(after.datasetVersions)]);
  for (const source of [...sources].sort()) {
    const from = before.datasetVersions[source];
    const to = after.datasetVersions[source];
    if (from !== to) {
      reasons.push({ kind: 'dataset', source, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
    }
  }

  const paramKeys = new Set([...Object.keys(before.params), ...Object.keys(after.params)]);
  const changedParams = [...paramKeys]
    .filter((k) => canonicalize(before.params[k]) !== canonicalize(after.params[k]))
    .sort();
  if (changedParams.length > 0) reasons.push({ kind: 'params', keys: changedParams });

  const slots = new Set([...Object.keys(before.upstream), ...Object.keys(after.upstream)]);
  const changedSlots = [...slots].filter((s) => before.upstream[s] !== after.upstream[s]).sort();
  if (changedSlots.length > 0) reasons.push({ kind: 'upstream', slots: changedSlots });

  if (before.nodeVersion !== after.nodeVersion) {
    reasons.push({ kind: 'node_version', from: before.nodeVersion, to: after.nodeVersion });
  }

  return reasons.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/** The badge text: one line per reason, and an explicit "not the data" when only a model moved. */
export function describeStaleReasons(reasons: readonly StaleReason[]): string[] {
  const lines = reasons.map((r) => {
    switch (r.kind) {
      case 'model_version':
        return `model ${r.model} changed version (${r.from} → ${r.to})`;
      case 'model_added':
        return `model ${r.model} ${r.version} now contributes to this value`;
      case 'model_removed':
        return `model ${r.model} ${r.version} no longer contributes to this value`;
      case 'model_call':
        return `model ${r.model}'s call changed: ${r.fields.join(', ')}`;
      case 'dataset':
        return `${r.source} moved to snapshot ${r.to ?? '(none)'}${r.from !== undefined ? ` from ${r.from}` : ''}`;
      case 'params':
        return `parameters changed: ${r.keys.join(', ')}`;
      case 'upstream':
        return `an input recomputed: ${r.slots.join(', ')}`;
      case 'node_version':
        return `the node's code changed (${r.from} → ${r.to})`;
    }
  });
  const modelOnly = reasons.length > 0 && reasons.every((r) => r.kind.startsWith('model'));
  if (modelOnly) lines.push('the data did not change: this number moved because the model did');
  return lines;
}
