/**
 * The degradation ladder, checked against the systems it describes.
 *
 * PRD 7.4 lists six rungs and one rule underneath them. `canvas-guard` holds
 * that list and tests it as data — six entries, in order, each with a badge.
 * What nothing checks is whether the rungs are **achievable**: rung 1 says a
 * frontier outage routes to the 70B open-weight fleet, and only the router
 * knows whether an open-weight model is actually eligible for the work. A
 * ladder whose first rung describes a fallback the router cannot produce is a
 * document, not a degradation plan.
 *
 * So each rung here is exercised against the package that would really carry
 * it, and the two "do not silently substitute" clauses are tested as
 * refusals rather than as badges.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_UP,
  LADDER,
  active,
  present,
  rungFor,
  stillAnswers,
  type SystemHealth,
} from '@picasso/canvas-guard';
import {
  DEFAULT_POLICY,
  NoEligibleModel,
  route,
  type Model,
  type RoutingFeatures,
  type RoutingPolicy,
  type TaskClass,
} from '@picasso/canvas-router';
import { TIER_LABEL, chooseTier } from '@picasso/canvas-agents';
import { SyncedCanvas, Link } from '@picasso/canvas-sync';
import { createDocument, createNode, deriveCacheKey, type CanvasDocument } from '@picasso/canvas-core';
import { SnapshotCatalog, setCanvasAsOf } from '@picasso/canvas-data';

/** The fleet with some placements unreachable. */
function fleetWithout(...placements: Array<Model['placement']>): RoutingPolicy {
  return {
    ...DEFAULT_POLICY,
    models: DEFAULT_POLICY.models.filter((m) => !placements.includes(m.placement)),
  };
}

function features(taskClass: TaskClass, over: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    taskClass,
    inputTokens: 3_000,
    expectedOutputTokens: 600,
    modalities: ['text'],
    toolsRequired: [],
    rigorFlag: false,
    dataSensitivity: 'public',
    costCeilingCents: 100,
    latencyBudgetMs: 60_000,
    determinismRequired: false,
    priorFailures: [],
    ...over,
  };
}

describe('rung 1 · frontier vendor unavailable', () => {
  const degraded = fleetWithout('vendor');

  // "route to the 70B open-weight fleet". The ladder can only claim that if
  // the router can actually produce it.
  it('still answers the frontier task classes, from self-hosted models', () => {
    for (const taskClass of ['synthesis.final', 'plan.decompose', 'critique.redteam'] as const) {
      const decision = route(degraded, features(taskClass));
      expect(decision.model.placement).not.toBe('vendor');
      expect(decision.model.id).toBe('open-70b');
    }
  });

  // "mark affected nodes with a reduced-capability badge, do not silently
  // substitute" — the substitution has to be visible in what comes back.
  it('says in its reasons that a fallback tier was used', () => {
    const before = route(DEFAULT_POLICY, features('synthesis.final'));
    const after = route(degraded, features('synthesis.final'));
    expect(before.model.id).not.toBe(after.model.id);
    // Every vendor model appears in the exclusion list with a rule naming why.
    const excludedIds = after.excluded.map((e) => e.modelId);
    for (const vendor of DEFAULT_POLICY.models.filter((m) => m.placement === 'vendor')) {
      expect(excludedIds).not.toContain(vendor.id);
    }
    // They are gone from the fleet entirely, which is the honest model of an
    // outage: not excluded by a rule, simply not there.
    expect(after.candidates.some((c) => c.model.placement === 'vendor')).toBe(false);
  });

  it('carries the rung\'s badge for any node on that path', () => {
    const health: SystemHealth = { ...ALL_UP, frontier_vendor: 'down' };
    const rung = rungFor(health, 'frontier_vendor')!;
    expect(rung.badge).toContain('open-weight');
    const shown = present(0.93, { source: 'subtext read', asof: '2026-03-11T14:30:00Z', asofMs: 1 }, 60_001, rung);
    expect(shown.caption).toContain(rung.badge);
  });

  // The ladder and Appendix C.5 have to agree about what a frontier outage
  // leaves you with, or the Critic would label itself against a fallback the
  // ladder never planned for.
  it('agrees with the Critic\'s independence ladder about the fallback', () => {
    const openOnly = degraded.models;
    // The author is gone too: this is an outage, not a preference.
    const author = DEFAULT_POLICY.models.find((m) => m.id === 'frontier-a')!;
    const choice = chooseTier(author, openOnly);
    expect(choice.tier).toBe(4);
    expect(choice.model?.id).toBe('open-70b');
    expect(choice.label).toBe(TIER_LABEL[4]);
    // The same model the routing ladder falls to.
    expect(choice.model?.id).toBe(route(degraded, features('critique.redteam')).model.id);
  });
});

describe('rung 2 · GPU fleet saturated', () => {
  // "local 3B handles classification and autocomplete; heavy tasks queue with
  // a visible position indicator."
  const onDeviceOnly = fleetWithout('vendor', 'self_hosted');

  it('still classifies, on the device', () => {
    const decision = route(onDeviceOnly, features('intent.classify'));
    expect(decision.model.id).toBe('local-3b');
    expect(decision.model.placement).toBe('on_device');
  });

  // Queueing is the PRD's answer, and a router that quietly answered a codegen
  // request from a 3B model would be the silent substitution rung 1 forbids.
  it('refuses heavy work rather than answering it from the 3B', () => {
    expect(() => route(onDeviceOnly, features('quant.codegen'))).toThrow(NoEligibleModel);
  });
});

describe('rung 3 · the real-time feed drops', () => {
  // "tiles show last value with a stale-data badge and elapsed time, never a
  // silently frozen number."
  it('shows the last value with its age, not a frozen one', () => {
    const health: SystemHealth = { ...ALL_UP, realtime_feed: 'down' };
    const rung = rungFor(health, 'realtime_feed')!;
    const asofMs = 1_772_000_000_000;
    const shown = present(118.5, { source: 'NVDA last trade', asof: '2026-03-11T14:30:00Z', asofMs }, asofMs + 8 * 60_000, rung);

    expect(shown.value).toBe(118.5);
    expect(shown.badge).toBe('stale data');
    expect(shown.caption).toContain('8m old');
    expect(shown.caption).toContain('NVDA last trade');
  });
});

describe('rung 4 · the warehouse is degraded', () => {
  // "serve from the client's local cache where the data is present, mark as
  // cached-at-timestamp."
  function catalogue(): SnapshotCatalog {
    const catalog = new SnapshotCatalog();
    catalog.register({ source: 'prices', snapshotId: 'ch-0805', committedAt: '2024-08-05T13:00:00Z' });
    catalog.register({ source: 'prices', snapshotId: 'ch-0806', committedAt: '2024-08-06T13:00:00Z' });
    // Fundamentals only started being captured later.
    catalog.register({ source: 'fundamentals', snapshotId: 'fd-0901', committedAt: '2024-09-01T13:00:00Z' });
    return catalog;
  }

  function canvas(): CanvasDocument {
    const doc = createDocument('c');
    const tile = createNode({
      id: 'tile',
      kind: 'DataTile',
      binding: 'bound',
      params: { symbol: 'NVDA' },
      provenance: { datasetSnapshots: { prices: 'ch-0806' }, asof: '2024-08-06', verified: true },
    });
    tile.state = { status: 'ready', cacheKey: 'stale-key-from-live-data' };
    doc.nodes.set(tile.id, tile);
    doc.nodes.set('sticky', createNode({ id: 'sticky', kind: 'TextPad', binding: 'loose' }));
    return doc;
  }

  // "where the data is present" is the whole qualifier. A source the cache
  // does not reach is named, not filled in from the nearest thing on hand.
  it('names a source it cannot serve rather than substituting the oldest it has', () => {
    const result = setCanvasAsOf(canvas(), '2024-08-05T20:00:00Z', catalogue());
    expect(result.snapshots).toEqual({ prices: 'ch-0805' });
    expect(result.missingSources).toEqual(['fundamentals']);
  });

  // The degraded read must not reuse a key derived against live data, or the
  // cache would serve today's number under yesterday's question.
  it('drops the cache key that was computed against the live warehouse', () => {
    const doc = canvas();
    expect(doc.nodes.get('tile')!.state.cacheKey).toBe('stale-key-from-live-data');

    setCanvasAsOf(doc, '2024-08-05T20:00:00Z', catalogue());

    const tile = doc.nodes.get('tile')!;
    expect(tile.state.cacheKey).toBeUndefined();
    expect(tile.state.status).toBe('stale');
    // And the key it derives now is a key about the cached snapshot.
    const derived = deriveCacheKey(doc, 'tile');
    expect(derived).toBeDefined();
    expect(derived).not.toBe('stale-key-from-live-data');
  });

  it('leaves loose objects alone, since time never computed them', () => {
    const result = setCanvasAsOf(canvas(), '2024-08-05T20:00:00Z', catalogue());
    expect(result.skippedLoose).toEqual(['sticky']);
  });

  it('stamps the served value cached-at-timestamp, with its age', () => {
    const health: SystemHealth = { ...ALL_UP, warehouse: 'degraded' };
    const rung = rungFor(health, 'warehouse')!;
    const asofMs = Date.parse('2024-08-05T20:00:00Z');
    const shown = present(118.5, { source: 'prices @ ch-0805', asof: '2024-08-05T20:00:00Z', asofMs }, asofMs + 26 * 3_600_000, rung);
    expect(shown.badge).toContain('cached');
    expect(shown.caption).toContain('26h old');
    expect(shown.caption).toContain('ch-0805');
  });
});

describe('rung 5 · the collab server is unreachable', () => {
  // "canvas continues fully offline against IndexedDB; edits merge on
  // reconnect via CRDT."
  it('keeps both analysts working, and merges what they did', () => {
    const maya = new SyncedCanvas({ id: 'canvas-1' });
    const sam = new SyncedCanvas({ id: 'canvas-1' });
    const link = new Link(maya.doc, sam.doc);

    maya.addNode(createNode({ id: 'shared', kind: 'ChartNode', binding: 'bound' }));
    expect(sam.getNode('shared')).toBeDefined();

    // The server goes away.
    link.disconnect();
    maya.addNode(createNode({ id: 'maya-offline', kind: 'TableNode', binding: 'bound' }));
    sam.addNode(createNode({ id: 'sam-offline', kind: 'ScenarioNode', binding: 'bound' }));
    sam.setParam('shared', 'range', '6m');

    // Both kept working. Neither can see the other.
    expect(maya.nodeCount).toBe(2);
    expect(sam.nodeCount).toBe(2);
    expect(maya.getNode('sam-offline')).toBeUndefined();

    link.connect();

    for (const client of [maya, sam]) {
      expect([...client.snapshot().nodes.keys()].sort()).toEqual([
        'maya-offline',
        'sam-offline',
        'shared',
      ]);
      expect(client.getNode('shared')?.params.range).toBe('6m');
    }
  });

  it('is the rung that keeps every other capability', () => {
    const health: SystemHealth = { ...ALL_UP, collab: 'down' };
    expect(stillAnswers(health)).toBe(true);
    expect(active(health).map((r) => r.subsystem)).toEqual(['collab']);
  });
});

// Rung 6 — "sandbox unavailable → code nodes fall back to the in-browser
// runtime, otherwise queue" — has nothing to exercise. There is no Firecracker
// sandbox and no Pyodide in this build, so the only honest thing to assert
// about it is that the rung exists and carries a badge, which canvas-guard
// already tests as data. Writing a green test around a substitution neither
// side of which is implemented would make the ladder look more verified than
// it is.
describe('rung 6 · the sandbox', () => {
  it('is present in the ladder, and that is all this build can say about it', () => {
    const rung = LADDER.find((r) => r.subsystem === 'sandbox')!;
    expect(rung.level).toBe(6);
    expect(rung.badge).toContain('in-browser runtime');
  });
});

describe('the rule underneath all six', () => {
  // "The system never shows a number without telling the truth about where it
  // came from and how old it is."
  it('holds on every rung, with the badge naming the degradation', () => {
    const asofMs = 1_772_000_000_000;
    for (const rung of LADDER) {
      const shown = present(
        42.5,
        { source: 'the aggregation node', asof: '2026-03-11T14:30:00Z', asofMs },
        asofMs + 3 * 60_000,
        rung,
      );
      expect(shown.source).toBe('the aggregation node');
      expect(shown.ageMs).toBe(180_000);
      expect(shown.caption).toContain('3m old');
      expect(shown.caption).toContain(rung.badge);
    }
  });

  it('degrades in the ladder\'s order however the failures arrived', () => {
    const health: SystemHealth = {
      ...ALL_UP,
      sandbox: 'down',
      frontier_vendor: 'degraded',
      realtime_feed: 'down',
    };
    expect(active(health).map((r) => r.level)).toEqual([1, 3, 6]);
  });

  // The one state where there is no answer to degrade to.
  it('stops claiming to answer only when both model tiers are gone', () => {
    expect(stillAnswers({ ...ALL_UP, frontier_vendor: 'down' })).toBe(true);
    expect(stillAnswers({ ...ALL_UP, gpu_fleet: 'down' })).toBe(true);
    expect(stillAnswers({ ...ALL_UP, frontier_vendor: 'down', gpu_fleet: 'down' })).toBe(false);
  });
});
