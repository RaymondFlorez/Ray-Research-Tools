import { describe, expect, it } from 'vitest';
import {
  CROSS_VENUE_BPS,
  MissingResolutionCriteria,
  REFERENCE_DEPTH,
  confidenceOf,
  crossVenue,
  curve,
  pointFromBook,
  type CurveInput,
  type ResolutionCriteria,
} from '../src/probability.js';

const bls: ResolutionCriteria = {
  text: 'Resolves YES if the BLS initial print for March CPI year-over-year is at or above 3.0%.',
  source: 'BLS initial release',
  settlesAt: '2026-04-10',
};

function input(overrides: Partial<CurveInput> = {}): CurveInput {
  return {
    venue: 'polymarket',
    marketType: 'binary_clob',
    event: 'March CPI at or above 3.0%',
    criteria: bls,
    points: [
      { at: '2026-03-01', probability: 0.41, band: 0.005, depth: 30_000 },
      { at: '2026-03-08', probability: 0.34, band: 0.005, depth: 40_000 },
    ],
    ...overrides,
  };
}

describe('resolution criteria are first-class', () => {
  // "first-class, not a footnote" is only true if something enforces it. A
  // field that can be left empty is a footnote with a longer name.
  it('cannot be omitted', () => {
    expect(() => curve(input({ criteria: { ...bls, text: '   ' } }))).toThrow(MissingResolutionCriteria);
    expect(() => curve(input({ criteria: { ...bls, settlesAt: '' } }))).toThrow(MissingResolutionCriteria);
  });

  it('say why they are required, in the error', () => {
    try {
      curve(input({ criteria: { ...bls, text: '' } }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('resolution-criteria mistakes');
    }
  });

  it('travel with the curve', () => {
    expect(curve(input()).criteria.source).toBe('BLS initial release');
  });
});

describe('the curve', () => {
  it('orders its points and takes the latest as current', () => {
    const built = curve(
      input({
        points: [
          { at: '2026-03-08', probability: 0.34, band: 0.005, depth: 40_000 },
          { at: '2026-03-01', probability: 0.41, band: 0.005, depth: 30_000 },
        ],
      }),
    );
    expect(built.points.map((p) => p.at)).toEqual(['2026-03-01', '2026-03-08']);
    expect(built.latest.probability).toBe(0.34);
  });

  it('refuses to exist with no points', () => {
    expect(() => curve(input({ points: [] }))).toThrow();
  });

  it('reads its latest point straight off a book', () => {
    const point = pointFromBook('2026-03-09', {
      outcome: 'YES',
      bid: 0.33,
      ask: 0.35,
      bidSize: 20_000,
      askSize: 5_000,
    });
    expect(point.depth).toBe(25_000);
    expect(point.band).toBeCloseTo(0.01, 12);
    expect(point.probability).toBeGreaterThan(0.34);
  });
});

describe('liquidity-weighted confidence', () => {
  // Multiplied, not averaged: a tight spread on an empty book is not a
  // confident price, and neither is a deep book quoted ten points wide.
  it('needs both a tight spread and a real book', () => {
    const tightAndDeep = confidenceOf({ at: 'x', probability: 0.34, band: 0.002, depth: REFERENCE_DEPTH });
    const tightAndEmpty = confidenceOf({ at: 'x', probability: 0.34, band: 0.002, depth: 0 });
    const wideAndDeep = confidenceOf({ at: 'x', probability: 0.34, band: 0.05, depth: 500_000 });
    expect(tightAndDeep.value).toBeGreaterThan(0.4);
    expect(tightAndEmpty.value).toBe(0);
    expect(wideAndDeep.value).toBe(0);
  });

  // Past the reference depth, more size stops telling you anything new about
  // whether the price is real.
  it('saturates in depth rather than rewarding size without limit', () => {
    const band = 0.002;
    const at = (depth: number) => confidenceOf({ at: 'x', probability: 0.34, band, depth }).value;
    const first = at(REFERENCE_DEPTH) - at(REFERENCE_DEPTH / 2);
    const second = at(REFERENCE_DEPTH * 4) - at(REFERENCE_DEPTH * 3.5);
    expect(second).toBeLessThan(first);
  });

  it('shows what it is made of, so it is arguable', () => {
    const { reason } = confidenceOf({ at: 'x', probability: 0.34, band: 0.005, depth: 40_000 });
    expect(reason).toContain('spread');
    expect(reason).toContain('depth');
  });

  it('treats a bookless point as a wide one', () => {
    expect(confidenceOf({ at: 'x', probability: 0.34 }).value).toBe(0);
  });
});

describe('cross-venue comparison', () => {
  const kalshiSameTerms = input({
    venue: 'kalshi',
    points: [{ at: '2026-03-08', probability: 0.37, band: 0.01, depth: 12_000 }],
  });

  it('calls a small gap aligned', () => {
    const result = crossVenue([
      curve(input()),
      curve(input({ venue: 'kalshi', points: [{ at: '2026-03-08', probability: 0.345, band: 0.01, depth: 9_000 }] })),
    ]);
    expect(result.verdict).toBe('aligned');
    expect(result.gapBps).toBeLessThanOrEqual(CROSS_VENUE_BPS);
  });

  it('calls a large gap on identical terms a divergence, and leads with the better book', () => {
    const result = crossVenue([curve(input()), curve(kalshiSameTerms)]);
    expect(result.verdict).toBe('divergent');
    expect(result.gapBps).toBe(300);
    expect(result.quotes[0]?.venue).toBe('polymarket');
  });

  // The single most common way to lose money in these markets, and exactly
  // what a node showing only prices would invite.
  it('refuses to call a gap a divergence when the contracts settle differently', () => {
    const revised = curve(
      input({
        venue: 'kalshi',
        criteria: {
          text: 'Resolves YES if the BLS revised print for March CPI year-over-year is at or above 3.0%.',
          source: 'BLS second revision',
          settlesAt: '2026-05-12',
        },
        points: [{ at: '2026-03-08', probability: 0.46, band: 0.01, depth: 12_000 }],
      }),
    );
    const result = crossVenue([curve(input()), revised]);
    expect(result.verdict).toBe('different_questions');
    expect(result.explanation).toContain('not a divergence');
    expect(result.criteriaGap).toHaveLength(2);
  });

  it('ignores whitespace and case in the criteria, but never the deciding source', () => {
    const cosmetic = curve(
      input({
        venue: 'kalshi',
        criteria: { ...bls, text: `  ${bls.text.toUpperCase()}  ` },
        points: [{ at: '2026-03-08', probability: 0.37, band: 0.01, depth: 12_000 }],
      }),
    );
    expect(crossVenue([curve(input()), cosmetic]).verdict).toBe('divergent');

    const differentSource = curve(
      input({
        venue: 'kalshi',
        criteria: { ...bls, source: 'Cleveland Fed nowcast' },
        points: [{ at: '2026-03-08', probability: 0.37, band: 0.01, depth: 12_000 }],
      }),
    );
    expect(crossVenue([curve(input()), differentSource]).verdict).toBe('different_questions');
  });

  it('says so plainly when only one venue quotes the event', () => {
    expect(crossVenue([curve(input())]).explanation).toContain('only one venue');
  });
});
