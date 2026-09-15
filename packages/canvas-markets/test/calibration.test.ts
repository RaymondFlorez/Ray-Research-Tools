import { describe, expect, it } from 'vitest';
import { MIN_SCORED } from '@picasso/canvas-hypothesis';
import { analystScored, compare, marketScored, type ResolvedContract } from '../src/calibration.js';

/** A run of contracts where the analyst is systematically overconfident. */
function history(count: number, analystOnEvery = true): ResolvedContract[] {
  const out: ResolvedContract[] = [];
  for (let i = 0; i < count; i += 1) {
    // The market is well calibrated: it says 0.3 and it happens 30% of the time.
    const marketProbability = 0.3;
    const outcome = i % 10 < 3;
    const contract: ResolvedContract = {
      contractId: `c${i}`,
      event: `event ${i}`,
      marketProbability,
      outcome,
      resolvedAt: `2026-0${(i % 9) + 1}-01`,
    };
    // The analyst says 0.8 on the same questions and is wrong most of the time.
    if (analystOnEvery) contract.analystProbability = 0.8;
    out.push(contract);
  }
  return out;
}

describe('scoring both sides', () => {
  it('scores the market on every contract it priced', () => {
    expect(marketScored(history(20))).toHaveLength(20);
  });

  it('scores the analyst only where they said something', () => {
    const contracts = history(20, false);
    contracts[0]!.analystProbability = 0.6;
    contracts[1]!.analystProbability = 0.2;
    expect(analystScored(contracts)).toHaveLength(2);
  });
});

describe('the comparison', () => {
  // An analyst who states a probability on the twelve questions they find
  // interesting and compares to the market across four hundred is measuring
  // question selection, and the answer will flatter them.
  it('scores both sides on the contracts they both spoke about', () => {
    const contracts = history(40, false);
    for (let i = 0; i < 12; i += 1) contracts[i]!.analystProbability = 0.8;
    const result = compare(contracts);
    expect(result.overlap).toBe(12);
    expect(result.market.scored).toHaveLength(12);
    expect(result.analyst.scored).toHaveLength(12);
  });

  it('puts an overconfident analyst behind a calibrated market', () => {
    const result = compare(history(40));
    expect(result.edge).toBeGreaterThan(0);
    expect(result.verdict).toContain('behind the market');
  });

  it('puts a sharper analyst ahead', () => {
    const contracts = history(40, false);
    for (const [i, contract] of contracts.entries()) {
      // The analyst knows which ones resolve YES and says so, mildly.
      contract.analystProbability = contract.outcome ? 0.6 : 0.15;
      contract.contractId = `c${i}`;
    }
    const result = compare(contracts);
    expect(result.edge).toBeLessThan(0);
    expect(result.verdict).toContain('ahead of the market');
  });

  it('reports no measurable edge when the two agree', () => {
    const contracts = history(40, false);
    for (const contract of contracts) contract.analystProbability = contract.marketProbability;
    const result = compare(contracts);
    expect(result.edge).toBeCloseTo(0, 12);
    expect(result.verdict).toContain('no measurable edge');
  });

  // The hypothesis tracker's own rule: show the count, withhold the score,
  // until there is enough history for it to mean anything.
  it('withholds a verdict on too few contracts and says how few', () => {
    const contracts = history(40, false);
    for (let i = 0; i < MIN_SCORED - 1; i += 1) contracts[i]!.analystProbability = 0.8;
    const result = compare(contracts);
    expect(result.verdict).toContain('too few to score');
    expect(result.verdict).toContain(`${MIN_SCORED - 1}`);
  });

  it('says so when the analyst has never stated a view', () => {
    const result = compare(history(40, false));
    expect(result.overlap).toBe(0);
    expect(result.verdict).toContain('no contract');
  });

  it('carries the Brier decomposition through from the hypothesis tracker', () => {
    const result = compare(history(40));
    const { brier, reliability, resolution, uncertainty } = result.market.calibration;
    expect(brier).toBeCloseTo(reliability - resolution + uncertainty, 10);
  });
});
