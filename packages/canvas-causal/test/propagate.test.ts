import { describe, expect, it } from 'vitest';
import {
  auditLinks,
  cycleGain,
  findCycles,
  propagate,
  type CausalLink,
} from '../src/propagate.js';

function link(
  from: string,
  to: string,
  elasticity: number,
  lag: number,
  extra: Partial<CausalLink> = {},
): CausalLink {
  const base: CausalLink = {
    id: `${from}->${to}`,
    from,
    to,
    elasticity,
    lag,
    method: 'local_projection',
    rSquared: 0.5,
  };
  // An asserted edge has no R² at all, which is different from having a low
  // one — so the override deletes the key rather than setting it undefined.
  const merged = { ...base, ...extra };
  if (extra.method === 'asserted' || extra.method === 'cited') delete merged.rSquared;
  return merged;
}

/** The PRD's own chain: "Fed hawkish → real rates up → multiple compression". */
const chain: CausalLink[] = [
  link('fed', 'real_rates', 0.8, 1),
  link('real_rates', 'multiples', -2.1, 2),
  link('multiples', 'nvda', 1.4, 1),
];

describe('a shock down a chain', () => {
  it('arrives with the right sign, size and delay', () => {
    const result = propagate(chain, new Map([['fed', 1]]), { horizon: 12, damping: 1 });

    // Each hop multiplies by its elasticity and waits out its lag.
    const rates = result.series.get('real_rates') as number[];
    expect(rates[1]).toBeCloseTo(0.8, 12);
    expect(rates[0]).toBe(0);

    const multiples = result.series.get('multiples') as number[];
    expect(multiples[3]).toBeCloseTo(0.8 * -2.1, 12);

    const nvda = result.series.get('nvda') as number[];
    expect(nvda[4]).toBeCloseTo(0.8 * -2.1 * 1.4, 12);
    // Hawkish surprise, multiples compress, the long-duration name falls.
    expect(result.total.get('nvda')).toBeLessThan(0);
  });

  it('damping shrinks the far end of the chain, not the near one', () => {
    const undamped = propagate(chain, new Map([['fed', 1]]), { horizon: 12, damping: 1 });
    const damped = propagate(chain, new Map([['fed', 1]]), { horizon: 12, damping: 0.8 });

    const ratio = (r: typeof undamped, node: string) =>
      (damped.total.get(node) as number) / (r.total.get(node) as number);
    // One hop loses one factor, three hops lose three.
    expect(ratio(undamped, 'real_rates')).toBeCloseTo(0.8, 9);
    expect(ratio(undamped, 'nvda')).toBeCloseTo(0.8 ** 3, 9);
  });

  it('a shock that has not arrived yet is zero, not missing', () => {
    const result = propagate(chain, new Map([['fed', 1]]), { horizon: 2, damping: 1 });
    // The horizon cuts the chain off before it reaches the end, and the node
    // reads zero rather than being absent from the result.
    expect(result.series.get('nvda')).toBeDefined();
    expect(result.total.get('nvda')).toBe(0);
    expect(result.total.get('real_rates')).toBeCloseTo(0.8, 12);
  });
});

describe('cycles, which a causal map is allowed to have', () => {
  const loop: CausalLink[] = [
    link('rates', 'multiples', -1.0, 1),
    link('multiples', 'risk_appetite', 0.8, 1),
    link('risk_appetite', 'rates', -0.5, 1),
  ];

  it('finds the loop and reports it rather than refusing to run', () => {
    const cycles = findCycles(loop);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(['rates', 'multiples', 'risk_appetite']));
  });

  it('settles to a fixed point when the round trip loses energy', () => {
    // Gain is (-1.0)(0.8)(-0.5) = 0.4 before damping: comfortably under one.
    expect(Math.abs(cycleGain(loop, ['rates', 'multiples', 'risk_appetite'], 1))).toBeCloseTo(0.4, 12);

    const result = propagate(loop, new Map([['rates', 1]]), { horizon: 60, damping: 1 });
    expect(result.diverged).toBeUndefined();

    // Each trip round the loop is smaller than the last, so the total converges.
    const rates = result.series.get('rates') as number[];
    const first = Math.abs(rates[3] as number);
    const second = Math.abs(rates[6] as number);
    expect(second).toBeLessThan(first);
    expect(Math.abs(result.total.get('rates') as number)).toBeLessThan(10);
  });

  /**
   * PRD 3.4: divergence "halts and reports rather than spinning".
   *
   * A loop with a round-trip gain above one is a legitimate thing to draw and a
   * meaningless thing to evaluate — the answer is infinity. Returning a large
   * number would be worse than returning nothing, because a large number looks
   * like a result.
   */
  it('halts on a loop that runs away, and names what ran away', () => {
    const runaway: CausalLink[] = [
      link('a', 'b', 3.0, 1),
      link('b', 'a', 3.0, 1),
    ];
    const result = propagate(runaway, new Map([['a', 1]]), {
      horizon: 200,
      damping: 1,
      divergenceLimit: 1e6,
    });

    expect(result.diverged).toBeDefined();
    expect(result.diverged?.magnitude).toBeGreaterThan(1e6);
    expect(new Set(result.diverged?.cycle)).toEqual(new Set(['a', 'b']));
    // It stopped early rather than running the full horizon.
    expect(result.periods).toBeLessThan(200);
  });

  it('damping can rescue a loop that would otherwise run away', () => {
    const marginal: CausalLink[] = [link('a', 'b', 1.2, 1), link('b', 'a', 1.0, 1)];
    expect(propagate(marginal, new Map([['a', 1]]), { horizon: 200, damping: 1 }).diverged)
      .toBeDefined();
    // Two hops per trip, so damping enters squared: 1.2 x 0.8² = 0.77.
    expect(propagate(marginal, new Map([['a', 1]]), { horizon: 200, damping: 0.8 }).diverged)
      .toBeUndefined();
    expect(Math.abs(cycleGain(marginal, ['a', 'b'], 0.8))).toBeLessThan(1);
  });

  it('a contemporaneous edge inside a loop still advances time', () => {
    // Lag zero around a cycle would be a shock reaching itself in the same
    // period — an infinite sum, not a propagation. One period is the floor.
    const instant: CausalLink[] = [link('a', 'b', 0.5, 0), link('b', 'a', 0.5, 0)];
    const result = propagate(instant, new Map([['a', 1]]), { horizon: 10, damping: 1 });
    expect(result.diverged).toBeUndefined();
    expect((result.series.get('b') as number[])[1]).toBeCloseTo(0.5, 12);
  });
});

describe('the assumption audit', () => {
  it('names every edge the analyst should not lean on', () => {
    const mixed: CausalLink[] = [
      link('a', 'b', 1.0, 1, { method: 'asserted' }),
      link('b', 'c', -2.1, 1, { method: 'local_projection', rSquared: 0.04 }),
      link('c', 'd', 0.7, 1, { method: 'local_projection', rSquared: 0.61 }),
      link('d', 'e', 1.3, 1, { method: 'cited' }),
      link('e', 'f', 0.9, 1, { method: 'local_projection', rSquared: 0.55, unstable: true }),
    ];
    const audit = auditLinks(mixed);

    // PRD 5.6's example, almost verbatim: the elasticity they asserted has an
    // R-squared of 0.04 over their chosen window.
    expect(audit.some((l) => l.includes('a → b') && l.includes('asserted by hand'))).toBe(true);
    expect(audit.some((l) => l.includes('b → c') && l.includes('R² is 0.04'))).toBe(true);
    expect(audit.some((l) => l.includes('d → e') && l.includes('citation'))).toBe(true);
    expect(audit.some((l) => l.includes('e → f') && l.includes('unstable across regimes'))).toBe(true);

    // The one well-estimated, stable edge is not in the list.
    expect(audit.some((l) => l.includes('c → d'))).toBe(false);
  });

  it('rides along with every propagation, so it cannot be skipped', () => {
    const result = propagate(
      [link('a', 'b', 1.0, 1, { method: 'asserted' })],
      new Map([['a', 1]]),
    );
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]).toContain('asserted by hand');
  });
});
