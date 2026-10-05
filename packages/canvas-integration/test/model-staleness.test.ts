/**
 * The model-staleness seam: router → core (PRD 4.7).
 *
 * > Any node feeding a compute path pins model version, temperature 0, and
 * > seed. Model version changes mark those nodes stale with an explicit
 * > reason so the analyst knows a number moved because the model changed,
 * > not because the market did.
 *
 * The version lives in the router's policy, the key lives in canvas-core, and
 * the reason has to survive the trip: a manifest that bumps a model's version
 * must move the key of every node the model fed, and the explanation must
 * name the model — not the data, which did not move.
 */

import { describe, expect, it } from 'vitest';
import {
  addNode,
  cacheKey,
  cacheKeyInput,
  createDocument,
  createNode,
  describeStaleReasons,
  explainKeyChange,
} from '@picasso/canvas-core';
import { DEFAULT_POLICY, fingerprintOf, route, type RoutingFeatures, type RoutingPolicy } from '@picasso/canvas-router';

const features: RoutingFeatures = {
  taskClass: 'doc.extract',
  inputTokens: 4_000,
  expectedOutputTokens: 400,
  modalities: ['text'],
  toolsRequired: [],
  rigorFlag: false,
  dataSensitivity: 'public',
  costCeilingCents: 100,
  latencyBudgetMs: 60_000,
  // The extraction feeds a compute node, so the call is pinned and seeded.
  determinismRequired: true,
  priorFailures: [],
};

function withVersion(policy: RoutingPolicy, modelId: string, version: string): RoutingPolicy {
  return { ...policy, models: policy.models.map((m) => (m.id === modelId ? { ...m, version } : m)) };
}

describe('a model version bump, explained', () => {
  const doc = createDocument('c');
  const node = createNode({
    id: 'guide',
    kind: 'EvidenceNode',
    binding: 'wired',
    position: { x: 0, y: 0 },
    params: { field: 'q1_revenue_guide' },
    nodeVersion: '2',
  });
  node.provenance.datasetSnapshots = { transcripts: 'snap-0805' };
  addNode(doc, node);

  it('moves the key, and names the model as the reason', () => {
    const before = route(DEFAULT_POLICY, features, { seed: 42 });
    expect(before.pinned).toEqual({ temperature: 0, seed: 42 });
    const bumped = withVersion(DEFAULT_POLICY, before.model.id, `${before.model.version}-next`);
    const after = route(bumped, features, { seed: 42 });
    expect(after.model.id).toBe(before.model.id);

    const was = cacheKeyInput(doc, 'guide', { modelFingerprints: [fingerprintOf(before, 'prompt-h1')] })!;
    const now = cacheKeyInput(doc, 'guide', { modelFingerprints: [fingerprintOf(after, 'prompt-h1')] })!;
    expect(cacheKey(now)).not.toBe(cacheKey(was));

    const reasons = explainKeyChange(was, now);
    expect(reasons).toEqual([
      { kind: 'model_version', model: before.model.id, from: before.model.version, to: `${before.model.version}-next` },
    ]);
    expect(describeStaleReasons(reasons)).toContain('the data did not change: this number moved because the model did');
  });

  it('keeps the key when the router picks the same pinned model again', () => {
    const a = route(DEFAULT_POLICY, features, { seed: 42 });
    const b = route(DEFAULT_POLICY, features, { seed: 42 });
    const ka = cacheKeyInput(doc, 'guide', { modelFingerprints: [fingerprintOf(a, 'p')] })!;
    const kb = cacheKeyInput(doc, 'guide', { modelFingerprints: [fingerprintOf(b, 'p')] })!;
    expect(cacheKey(ka)).toBe(cacheKey(kb));
    expect(explainKeyChange(ka, kb)).toEqual([]);
  });
});
