import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode, type CanvasDocument, type Edge } from '@picasso/canvas-core';
import { DEFAULT_POLICY, modelById, type Model } from '@picasso/canvas-router';
import type { Scored } from '@picasso/canvas-hypothesis';
import {
  chooseTier,
  critique,
  disconfirming,
  extractAssumptions,
  negate,
  sensitivitySweep,
  TIER_LABEL,
  WEAK_MAPPING_R2,
} from '../src/critic.js';

const frontierA = modelById(DEFAULT_POLICY, 'frontier-a')!;
const frontierB = modelById(DEFAULT_POLICY, 'frontier-b')!;
const open70 = modelById(DEFAULT_POLICY, 'open-70b')!;

function scenario(): CanvasDocument {
  const doc = createDocument('canvas-1');
  addNode(
    doc,
    createNode({
      id: 'scn',
      kind: 'ScenarioNode',
      binding: 'wired',
      inputs: [
        { id: 'shockBps', name: 'shock', type: 'scalar', cardinality: 'one', required: true },
        { id: 'curve', name: 'curve', type: 'curve', cardinality: 'one', required: true },
      ],
      outputs: [{ id: 'out', name: 'out', type: 'distribution', cardinality: 'one', required: false }],
      params: { shockBps: 50, curve: 'USD-SOFR', lookbackDays: 250 },
    }),
  );
  addNode(
    doc,
    createNode({
      id: 'curve',
      kind: 'CurveNode',
      binding: 'wired',
      outputs: [{ id: 'out', name: 'curve', type: 'curve', cardinality: 'one', required: false }],
    }),
  );
  doc.edges.set('e-curve', {
    id: 'e-curve',
    from: { nodeId: 'curve', portId: 'out' },
    to: { nodeId: 'scn', portId: 'curve' },
    class: 'data',
  });
  return doc;
}

describe('assumption extraction is a graph traversal', () => {
  it('names the params nobody wired and leaves the wired ones alone', () => {
    const assumptions = extractAssumptions(scenario());
    expect(assumptions.map((a) => a.name)).toEqual(['shockBps']);
    expect(assumptions[0]?.value).toBe(50);
  });

  // A lookback or a seed is configuration, not a belief about the world.
  // Listing them buries the numbers that carry the argument.
  it('ignores params that have no input port', () => {
    const assumptions = extractAssumptions(scenario());
    expect(assumptions.map((a) => a.name)).not.toContain('lookbackDays');
  });

  it('flags a causal mapping the data barely supports', () => {
    const doc = scenario();
    const weak: Edge = {
      id: 'e-causal',
      from: { nodeId: 'curve', portId: 'out' },
      to: { nodeId: 'scn', portId: 'shockBps' },
      class: 'causal',
      causal: {
        sign: -1,
        elasticity: 0.4,
        lagPeriods: 1,
        estimation: { method: 'local_projection', window: ['2020-01-01', '2026-01-01'], r2: 0.11 },
      },
    };
    doc.edges.set(weak.id, weak);
    const found = extractAssumptions(doc).filter((a) => a.kind === 'weak_mapping');
    expect(found).toHaveLength(1);
    expect(found[0]?.r2).toBeLessThan(WEAK_MAPPING_R2);
  });

  it('leaves a well-estimated mapping out of the list', () => {
    const doc = scenario();
    doc.edges.set('e-causal', {
      id: 'e-causal',
      from: { nodeId: 'curve', portId: 'out' },
      to: { nodeId: 'scn', portId: 'shockBps' },
      class: 'causal',
      causal: {
        sign: -1,
        elasticity: 0.4,
        lagPeriods: 1,
        estimation: { method: 'local_projection', window: ['2020-01-01', '2026-01-01'], r2: 0.61 },
      },
    });
    expect(extractAssumptions(doc).filter((a) => a.kind === 'weak_mapping')).toHaveLength(0);
  });
});

describe('negating a thesis for the disconfirming search', () => {
  it('flips the directional word the thesis is written with', () => {
    expect(negate('segment gross margin comes in below 71 percent')).toBe(
      'segment gross margin comes in above 71 percent',
    );
    expect(negate('NVDA outperforms the sector into the print')).toContain('underperforms');
  });

  it('flips exactly one word, so the sentence stays a claim', () => {
    expect(negate('margins rise as spreads widen')).toBe('margins fall as spreads widen');
  });

  // The fallback matters more than the table: retrieving on the unmodified
  // thesis would surface confirming evidence under a disconfirming heading.
  it('never returns the thesis unchanged', () => {
    const thesis = 'the CFO is signalling a guide-down';
    expect(negate(thesis)).not.toBe(thesis);
  });

  it('searches on the negation, not the thesis', () => {
    const queries: string[] = [];
    const evidence = disconfirming(
      'hedging density rises before a guide-down',
      (query) => {
        queries.push(query);
        return [
          { id: 'a', text: 'weak', score: 0.2 },
          { id: 'b', text: 'strong', score: 0.9 },
        ];
      },
    );
    expect(queries[0]).toContain('falls');
    expect(evidence[0]?.id).toBe('b');
  });
});

describe('the sensitivity sweep', () => {
  // One at a time. "If four things go against you at once, you are wrong" is
  // true of every argument and tells the analyst nothing they can act on.
  it('names the single change that flips the conclusion', () => {
    const sweep = sensitivitySweep({
      assumptions: [
        {
          nodeId: 'scn',
          kind: 'hand_set_param',
          name: 'shockBps',
          description: '',
          value: 50,
          sigma: 25,
        },
        {
          nodeId: 'scn',
          kind: 'hand_set_param',
          name: 'vol',
          description: '',
          value: 0.3,
          sigma: 0.02,
        },
      ],
      evaluate: ({ name, value }) => (name === 'shockBps' ? 100 - value : 40),
      holds: (metric) => metric > 30,
    });
    expect(sweep.flips).toHaveLength(1);
    expect(sweep.flips[0]).toMatchObject({ name: 'shockBps', direction: 'up', to: 75 });
    expect(sweep.robust.map((r) => r.name)).toEqual(['vol']);
  });
});

describe('the independence ladder (Appendix C.5)', () => {
  it('takes a different frontier vendor when one is available', () => {
    const choice = chooseTier(frontierA, DEFAULT_POLICY.models);
    expect(choice.tier).toBe(1);
    expect(choice.model?.id).toBe('frontier-b');
    expect(choice.label).toBe(TIER_LABEL[1]);
  });

  it('falls to a different family at the same vendor when it cannot', () => {
    const cousin: Model = { ...frontierA, id: 'a-general', family: 'a-general' };
    const choice = chooseTier(frontierA, [frontierA, cousin, open70]);
    expect(choice.tier).toBe(2);
    expect(choice.model?.id).toBe('a-general');
  });

  it('runs the author adversarially at a different seed when nothing else is up', () => {
    const choice = chooseTier(frontierA, [frontierA, open70].filter((m) => m.id !== 'open-70b'));
    expect(choice.tier).toBe(3);
    expect(choice.settings).toEqual({ temperature: 0.7, seed: 7, adversarialPrompt: true });
  });

  it('reaches the open-weight critic when the author cannot critique at all', () => {
    const narrow: Model = { ...frontierA, quality: { 'synthesis.final': 0.95 } };
    const choice = chooseTier(narrow, [narrow, open70]);
    expect(choice.tier).toBe(4);
    expect(choice.model?.id).toBe('open-70b');
  });

  // Independence is not a quantity the Critic gets to trade for cost. A score
  // that can exchange it will exchange it every time.
  it('never takes a cheaper model at a worse tier', () => {
    const choice = chooseTier(frontierA, DEFAULT_POLICY.models);
    expect(choice.model?.centsPerKiloToken).toBeGreaterThan(open70.centsPerKiloToken);
  });
});

describe('the critique at full frontier outage', () => {
  const history: Scored[] = [
    { confidence: 0.7, outcome: false },
    { confidence: 0.6, outcome: true },
    { confidence: 0.8, outcome: false },
  ];

  it('still produces every deterministic section with no model at all', () => {
    const result = critique({
      thesis: 'hedging density rises before a guide-down',
      document: scenario(),
      author: frontierA,
      available: [],
      history,
      retrieve: () => [{ id: 'e1', text: 'the same pattern preceded an 18 percent rally', score: 0.9 }],
      sweep: {
        assumptions: [
          { nodeId: 'scn', kind: 'hand_set_param', name: 'shockBps', description: '', value: 50, sigma: 25 },
        ],
        evaluate: ({ value }) => 100 - value,
        holds: (m) => m > 30,
      },
    });

    expect(result.tier.model).toBeUndefined();
    expect(result.prose).toBeUndefined();
    expect(result.assumptions).toHaveLength(1);
    expect(result.baseRate?.sentence).toContain('right once');
    expect(result.disconfirming).toHaveLength(1);
    expect(result.sweep?.flips).toHaveLength(1);
    expect(result.lines.length).toBeGreaterThanOrEqual(4);
  });

  it('says on the card which tier produced it', () => {
    const independent = critique({
      thesis: 'margins rise',
      document: scenario(),
      author: frontierA,
      available: DEFAULT_POLICY.models,
    });
    expect(independent.header).toBe('Dissent — independent critique (frontier-b)');

    const degraded = critique({
      thesis: 'margins rise',
      document: scenario(),
      author: frontierB,
      available: [frontierB],
    });
    expect(degraded.header).toContain('reduced independence');
  });
});
