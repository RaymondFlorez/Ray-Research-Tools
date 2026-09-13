import { describe, expect, it } from 'vitest';
import { addNode, createDocument, deriveCacheKey } from '@picasso/canvas-core';
import { createHypothesisNode, evaluateHypothesis, readHypothesis } from '../src/node.js';
import type { Hypothesis, Observable, Observation } from '../src/hypothesis.js';
import type { Scored } from '../src/calibration.js';

const claim: Hypothesis = {
  id: 'h1',
  claim: 'NVDA data center gross margin compresses below 71% by the Q2 report',
  confidence: 0.65,
  createdAt: '2026-02-10',
  observables: [
    {
      id: 'dc-gm',
      name: 'data center segment gross margin',
      direction: 'below',
      threshold: 71,
      falsifier: 73,
      dueBy: '2026-08-20',
      unit: '%',
    },
  ],
};

const observed = (value: number): Observation[] => [
  { observableId: 'dc-gm', value, observedAt: '2026-08-18' },
];

/** The first observable, which every fixture here has. */
function first(h: Hypothesis): Observable {
  const observable = h.observables[0];
  if (!observable) throw new Error('fixture has no observable');
  return observable;
}

describe('the node', () => {
  it('round-trips the claim through params', () => {
    const node = createHypothesisNode({ id: 'h1', hypothesis: claim });
    const read = readHypothesis(node);
    expect(read.claim).toBe(claim.claim);
    expect(read.confidence).toBe(0.65);
    expect(read.observables[0]?.falsifier).toBe(73);
  });

  it('is wired by default, because an untracked claim is the mood board', () => {
    expect(createHypothesisNode({ id: 'h1', hypothesis: claim }).binding).toBe('wired');
  });

  it('shows what happened, and what it was called at', () => {
    const node = createHypothesisNode({ id: 'h1', hypothesis: claim });
    expect(evaluateHypothesis(node, observed(70.2), '2026-08-21').badge).toBe(
      'supported — called at 65%',
    );
    expect(evaluateHypothesis(node, observed(74), '2026-08-21').badge).toBe(
      'contradicted — called at 65%',
    );
    expect(evaluateHypothesis(node, observed(72), '2026-08-21').badge).toContain('inconclusive');
    expect(evaluateHypothesis(node, [], '2026-06-01').badge).toBe('open — 1 observation awaited');
    expect(evaluateHypothesis(node, [], '2026-09-01').badge).toContain('never arrived');
  });

  /**
   * Being wrong is the system working, so a contradicted claim is `ready` with
   * the verdict on its badge. What is an error is a claim nothing could refute.
   */
  it('does not treat being wrong as a failure', () => {
    const node = createHypothesisNode({ id: 'h1', hypothesis: claim });
    evaluateHypothesis(node, observed(74), '2026-08-21');
    expect(node.state.status).toBe('ready');
    expect(node.state.error).toBeUndefined();
  });

  it('does treat an untestable claim as a failure', () => {
    const node = createHypothesisNode({
      id: 'h2',
      hypothesis: {
        ...claim,
        observables: [{ ...first(claim), falsifier: 69 }],
      },
    });
    const result = evaluateHypothesis(node, observed(70), '2026-08-21');
    expect(node.state.status).toBe('error');
    expect(node.state.error?.code).toBe('untestable_claim');
    expect(result.badge).toBe('not testable');
  });

  it('cites the track record alongside the verdict', () => {
    const history: Scored[] = [
      { confidence: 0.7, outcome: false },
      { confidence: 0.65, outcome: true },
      { confidence: 0.6, outcome: false },
    ];
    const node = createHypothesisNode({ id: 'h1', hypothesis: claim });
    const result = evaluateHypothesis(node, observed(70.2), '2026-08-21', history);
    expect(result.record).toBe('made this call 3 times, right once');
    // And it will not dress three calls up as a calibration.
    expect(result.calibration?.warning).toContain('not yet a calibration');
  });

  /**
   * The reason the claim belongs in the cache key: a threshold quietly moved
   * after the data arrives is a different claim, and must not inherit the old
   * one's identity.
   */
  it('a moved threshold is a different claim', () => {
    const keyFor = (hypothesis: Hypothesis) => {
      const doc = createDocument('theses');
      addNode(doc, createHypothesisNode({ id: 'h1', hypothesis }));
      return deriveCacheKey(doc, 'h1');
    };
    const original = keyFor(claim);
    expect(original).toBeDefined();
    expect(keyFor({ ...claim })).toBe(original);

    const moved: Hypothesis = {
      ...claim,
      observables: [{ ...first(claim), threshold: 74 }],
    };
    expect(keyFor(moved)).not.toBe(original);
    // And so is one called at a different confidence.
    expect(keyFor({ ...claim, confidence: 0.9 })).not.toBe(original);
  });
});
