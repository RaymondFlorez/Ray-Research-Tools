import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode } from '@picasso/canvas-core';
import { assertEdge, createCausalEdge, estimateEdge, linksFromDocument } from '../src/edge.js';
import { propagate } from '../src/propagate.js';

function rng(seed = 5) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
}

/** A rate shock whose effect on a basket peaks two periods out, at −2.1. */
function duration(n = 600, noise = 0.4) {
  const random = rng();
  const cause: number[] = [];
  const effect: number[] = [];
  for (let t = 0; t < n; t += 1) {
    cause.push(random() * 2);
    let value = random() * noise;
    if (t - 2 >= 0) value += -2.1 * (cause[t - 2] as number);
    effect.push(value);
  }
  return { cause, effect };
}

describe('estimating an edge from history', () => {
  /** PRD 7.4, almost word for word: "reports −2.1 with a standard error". */
  it('finds the elasticity, the lag, and an error to react to', () => {
    const { cause, effect } = duration();
    const edge = estimateEdge({ cause, effect, window: ['2016-01-01', '2026-01-01'] });
    expect(edge).toBeDefined();
    if (!edge) return;

    expect(edge.params.elasticity).toBeCloseTo(-2.1, 1);
    expect(edge.params.sign).toBe(-1);
    // The lag was not asserted; the estimator found where the response peaks.
    expect(edge.params.lagPeriods).toBe(2);
    expect(edge.params.estimation?.method).toBe('local_projection');
    expect(edge.params.estimation?.se).toBeGreaterThan(0);
    expect(edge.params.estimation?.window).toEqual(['2016-01-01', '2026-01-01']);
  });

  it('narrowing the window widens the error, which is the trade the analyst makes', () => {
    const { cause, effect } = duration(600);
    const wide = estimateEdge({ cause, effect, window: ['2016-01-01', '2026-01-01'] });
    const narrow = estimateEdge({
      cause: cause.slice(-120),
      effect: effect.slice(-120),
      window: ['2024-01-01', '2026-01-01'],
    });
    expect(wide?.params.estimation?.se).toBeDefined();
    expect(narrow?.params.estimation?.se).toBeGreaterThan(
      wide?.params.estimation?.se as number,
    );
  });

  it('carries the regime warning onto the edge', () => {
    const random = rng(21);
    const cause: number[] = [];
    const effect: number[] = [];
    for (let t = 0; t < 400; t += 1) {
      const shock = random() * 2;
      cause.push(shock);
      effect.push((t < 200 ? 2.0 : -1.0) * shock + random() * 0.2);
    }
    const edge = estimateEdge({ cause, effect, window: ['2016-01-01', '2026-01-01'] });
    expect(edge?.warning).toContain('average of two regimes');
    expect(edge?.regimes.unstable).toBe(true);
  });

  it('says nothing rather than fitting a sample it does not have', () => {
    expect(
      estimateEdge({ cause: [1, 2, 3], effect: [1, 2, 3], window: ['a', 'b'] }),
    ).toBeUndefined();
  });

  it('an asserted edge records that it was asserted', () => {
    const params = assertEdge(-1.8, 3);
    expect(params.estimation?.method).toBe('asserted');
    expect(params.estimation?.r2).toBeUndefined();
    expect(params.sign).toBe(-1);
  });
});

describe('the canvas graph and the causal graph are different graphs', () => {
  it('reads causal edges and skips data wires', () => {
    const doc = createDocument('macro');
    for (const id of ['fed', 'rates', 'basket', 'chart']) {
      addNode(doc, createNode({ id, kind: 'CausalNode', binding: 'wired' }));
    }
    const { cause, effect } = duration();
    const estimated = estimateEdge({ cause, effect, window: ['2016-01-01', '2026-01-01'] });
    expect(estimated).toBeDefined();
    if (!estimated) return;

    for (const edge of [
      createCausalEdge('e1', 'fed', 'rates', assertEdge(0.8, 1)),
      createCausalEdge('e2', 'rates', 'basket', estimated.params),
    ]) {
      doc.edges.set(edge.id, edge);
    }
    // A data wire between the same nodes is not a causal claim.
    doc.edges.set('d1', {
      id: 'd1',
      from: { nodeId: 'basket', portId: 'out' },
      to: { nodeId: 'chart', portId: 'in' },
      class: 'data',
    });

    const links = linksFromDocument(doc);
    expect(links.map((l) => l.id)).toEqual(['e1', 'e2']);
    expect(links[0]?.method).toBe('asserted');
    expect(links[1]?.method).toBe('local_projection');
    expect(links[1]?.rSquared).toBeGreaterThan(0);

    // And the whole chain runs, with the asserted edge named as an assumption.
    const result = propagate(links, new Map([['fed', 1]]), { horizon: 12, damping: 1 });
    expect(result.total.get('basket')).toBeLessThan(0);
    expect(result.assumptions.some((a) => a.includes('fed → rates'))).toBe(true);
    expect(result.assumptions.some((a) => a.includes('rates → basket'))).toBe(false);
  });

  it('marks an edge unstable when the caller knows it is', () => {
    const doc = createDocument('macro');
    const edge = createCausalEdge('e1', 'a', 'b', assertEdge(1.0, 1));
    doc.edges.set(edge.id, edge);
    const links = linksFromDocument(doc, new Set(['e1']));
    expect(links[0]?.unstable).toBe(true);
  });
});
