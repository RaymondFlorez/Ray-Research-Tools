import { describe, expect, it } from 'vitest';
import { devig, type Quote } from '../src/devig.js';
import { curve } from '../src/probability.js';
import { expectedValue, weigh, weightFromCurve, type WeightedScenario } from '../src/weights.js';

const scenarios: WeightedScenario[] = [
  { scenarioId: 'cut', name: 'Fed cuts in March', probability: 0.34, pnl: 180_000 },
  { scenarioId: 'hold', name: 'Fed holds', probability: 0.6, pnl: -20_000 },
];

describe('weights have to account for all of the probability', () => {
  // A set summing to 0.94 is not an estimate with wide error bars. It is
  // arithmetic that assumes the missing six percent is worth zero P&L.
  it('carries the residual rather than normalizing it away', () => {
    const set = weigh(scenarios);
    expect(set.residual).toBeCloseTo(0.06, 12);
    // The stated weights are untouched: normalizing up to one would spread the
    // unmodelled mass across the scenarios the analyst happened to think of.
    expect(set.scenarios[0]?.probability).toBe(0.34);
  });

  it('warns when the uncovered mass is material', () => {
    expect(weigh(scenarios).warnings.join(' ')).toContain('6.0% of the probability is not covered');
  });

  it('stays quiet when the set is complete', () => {
    const complete = weigh([
      { scenarioId: 'cut', name: 'cut', probability: 0.34, pnl: 1 },
      { scenarioId: 'hold', name: 'hold', probability: 0.66, pnl: 2 },
    ]);
    expect(complete.residual).toBeCloseTo(0, 12);
    expect(complete.warnings).toEqual([]);
  });

  it('calls out a set that sums past one as a contradiction, not a rounding issue', () => {
    const set = weigh([
      { scenarioId: 'a', name: 'a', probability: 0.7 },
      { scenarioId: 'b', name: 'b', probability: 0.6 },
    ]);
    expect(set.overweight).toBe(true);
    expect(set.warnings.join(' ')).toContain('cannot all be mutually exclusive');
  });
});

describe('expected value', () => {
  it('is the probability-weighted P&L, with the contributions shown', () => {
    const result = expectedValue(weigh(scenarios));
    expect(result.value).toBeCloseTo(0.34 * 180_000 + 0.6 * -20_000, 6);
    expect(result.contributions).toHaveLength(2);
    expect(result.contributions[0]?.contribution).toBeCloseTo(61_200, 6);
  });

  // These are the worst and best things the analyst *wrote down*, which is a
  // different claim from the worst and best things that can happen — and a
  // scenario set is exactly where those two get confused.
  it('labels the range as the extremes of the stated scenarios', () => {
    const result = expectedValue(weigh(scenarios));
    expect(result.worst).toBe(-20_000);
    expect(result.best).toBe(180_000);
    expect(result.residualMass).toBeCloseTo(0.06, 12);
  });

  it('says when a weighted scenario has no revaluation behind it', () => {
    const result = expectedValue(
      weigh([...scenarios, { scenarioId: 'hike', name: 'Fed hikes', probability: 0.06 }]),
    );
    expect(result.warnings.join(' ')).toContain('no revaluation');
    expect(result.contributions).toHaveLength(2);
  });
});

describe('C.4 flag propagation', () => {
  // "If the probability is wired into a ScenarioNode as a weight, the flag
  // renders inline on the scenario node too, since that is the point where
  // method choice becomes load-bearing."
  it('carries the divergence flag onto the scenario set', () => {
    const quotes: Quote[] = [
      { outcome: 'favourite', price: 0.92 },
      { outcome: 'longshot', price: 0.14 },
    ];
    const devigged = devig({ marketType: 'sportsbook', quotes });
    expect(devigged.divergence).toBeDefined();

    const set = weigh([
      {
        scenarioId: 'longshot',
        name: 'the tail case',
        probability: devigged.probabilities[1]!.probability,
        pnl: 900_000,
        divergence: devigged.divergence,
      },
      { scenarioId: 'base', name: 'the base case', probability: 0.868, pnl: -40_000 },
    ]);

    expect(set.divergences).toHaveLength(1);
    expect(set.divergences[0]?.scenarioId).toBe('longshot');
    expect(set.warnings.join(' ')).toContain('load-bearing');
    expect(expectedValue(set).warnings.join(' ')).toContain('load-bearing');
  });

  it('leaves the set clean when no market diverged', () => {
    expect(weigh(scenarios).divergences).toEqual([]);
  });
});

describe('a weight built from a probability curve', () => {
  // "so 'Fed cuts in March at 34 percent' becomes an actual weight in a
  // portfolio expected-value calculation rather than a number the analyst
  // holds in their head."
  it('carries the venue, the criteria and the confidence with it', () => {
    const built = weightFromCurve(
      'cut',
      'Fed cuts in March',
      curve({
        venue: 'kalshi',
        marketType: 'binary_clob',
        event: 'Fed cuts in March',
        criteria: {
          text: 'Resolves YES if the March FOMC lowers the target range.',
          settlesAt: '2026-03-18',
        },
        points: [{ at: '2026-03-01', probability: 0.34, band: 0.005, depth: 40_000 }],
      }),
      { pnl: 180_000 },
    );
    expect(built.probability).toBe(0.34);
    expect(built.source?.venue).toBe('kalshi');
    expect(built.source?.criteria).toContain('lowers the target range');
    expect(built.source?.confidence).toBeGreaterThan(0);
  });
});
