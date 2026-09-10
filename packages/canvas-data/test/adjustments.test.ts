import { describe, expect, it } from 'vitest';
import {
  CorporateActionStore,
  adjustSeries,
  adjustmentFactors,
  type CorporateAction,
  type PriceSeries,
} from '../src/adjustments.js';

/** A 10-for-1 split with an ex-date in June, announced in May. */
const split: CorporateAction = {
  instrument: 'NVDA',
  kind: 'split',
  exDate: '2024-06-10',
  announcedAt: '2024-05-22',
  factor: 0.1,
  description: '10-for-1 split',
};

const prices: PriceSeries = {
  instrument: 'NVDA',
  points: [
    { validTime: '2024-05-01', value: 900, knownAt: '2024-05-01' },
    { validTime: '2024-06-01', value: 1100, knownAt: '2024-06-01' },
    { validTime: '2024-06-10', value: 120, knownAt: '2024-06-10' },
    { validTime: '2024-07-01', value: 130, knownAt: '2024-07-01' },
  ],
};

describe('corporate actions', () => {
  it('rebases prices before the ex-date and leaves the rest alone', () => {
    const adjusted = adjustSeries(prices, [split], { knowledgeTime: '2024-08-01' });
    expect(adjusted.points.map((p) => p.value)).toEqual([90, 110, 120, 130]);
  });

  it('exposes the factors, so a series that changed shape can be explained', () => {
    const adjusted = adjustSeries(prices, [split], { knowledgeTime: '2024-08-01' });
    expect(adjusted.factors).toEqual([
      { validTime: '2024-05-01', factor: 0.1 },
      { validTime: '2024-06-01', factor: 0.1 },
      { validTime: '2024-06-10', factor: 1 },
      { validTime: '2024-07-01', factor: 1 },
    ]);
    expect(adjusted.applied.map((a) => a.description)).toEqual(['10-for-1 split']);
  });

  it('does not adjust for a split the market had not heard of yet', () => {
    // Standing in April, before the announcement: the unadjusted price is right.
    const asOfApril = adjustSeries(prices, [split], { knowledgeTime: '2024-04-01' });
    expect(asOfApril.points.map((p) => p.value)).toEqual([900, 1100, 120, 130]);
    expect(asOfApril.applied).toEqual([]);
  });

  it('waits for the ex-date, because until then the quoted price is pre-split', () => {
    // Late May: announced, not yet effective. The tape still says 1100, so a
    // chart showing 110 that day would disagree with the market.
    const asOfMay = adjustSeries(prices, [split], { knowledgeTime: '2024-05-25' });
    expect(asOfMay.points.map((p) => p.value)).toEqual([900, 1100, 120, 130]);

    // Once the ex-date has passed, history rebases.
    const asOfJune = adjustSeries(prices, [split], { knowledgeTime: '2024-06-11' });
    expect(asOfJune.points[0]?.value).toBe(90);
  });

  it('does not adjust for an action the data vendor recorded late', () => {
    // The ex-date has passed, but this action was not in the data until July.
    // A backtest standing in June had unadjusted prices, and must see them.
    const lateRecorded = { ...split, announcedAt: '2024-07-05' };
    const inJune = adjustSeries(prices, [lateRecorded], { knowledgeTime: '2024-06-20' });
    expect(inJune.points[0]?.value).toBe(900);
    expect(inJune.applied).toEqual([]);

    const inAugust = adjustSeries(prices, [lateRecorded], { knowledgeTime: '2024-08-01' });
    expect(inAugust.points[0]?.value).toBe(90);
  });

  it('adjusts onto the knowledge time’s basis, not the end of the window', () => {
    // A chart ending before the split still shows post-split terms, so it can
    // be read next to a chart that runs past it.
    const shortWindow: PriceSeries = { instrument: 'NVDA', points: prices.points.slice(0, 2) };
    const adjusted = adjustSeries(shortWindow, [split], { knowledgeTime: '2024-08-01' });
    expect(adjusted.points.map((p) => p.value)).toEqual([90, 110]);
  });

  it('compounds several actions', () => {
    const dividend: CorporateAction = {
      instrument: 'NVDA',
      kind: 'dividend',
      exDate: '2024-05-15',
      announcedAt: '2024-05-01',
      factor: 0.99,
    };
    const factors = adjustmentFactors([split, dividend], ['2024-05-01', '2024-06-01'], {
      knowledgeTime: '2024-08-01',
    });
    // Before both: 0.99 * 0.1. Between them: the split only.
    expect(factors[0]?.factor).toBeCloseTo(0.099, 9);
    expect(factors[1]?.factor).toBeCloseTo(0.1, 9);
  });

  it('ignores an action dated after the point being adjusted to', () => {
    const factors = adjustmentFactors([split], ['2024-05-01'], {
      knowledgeTime: '2024-08-01',
      adjustTo: '2024-05-05',
    });
    // Adjusting a chart that ends before the split: nothing to rebase to.
    expect(factors[0]?.factor).toBe(1);
  });

  it('leaves a series with no actions untouched', () => {
    const untouched = adjustSeries(prices, [], { knowledgeTime: '2024-08-01' });
    expect(untouched.points.map((p) => p.value)).toEqual([900, 1100, 120, 130]);
    expect(untouched.factors.every((f) => f.factor === 1)).toBe(true);
  });

  it('handles an empty series', () => {
    const empty = adjustSeries({ instrument: 'X', points: [] }, [split], {
      knowledgeTime: '2024-08-01',
    });
    expect(empty.points).toEqual([]);
    expect(empty.factors).toEqual([]);
  });
});

describe('the action store is point-in-time too', () => {
  it('only reports actions announced by the knowledge time', () => {
    const store = new CorporateActionStore();
    store.add(split);
    expect(store.known('NVDA', '2024-05-01')).toEqual([]);
    expect(store.known('NVDA', '2024-06-01')).toHaveLength(1);
  });

  it('keeps instruments separate', () => {
    const store = new CorporateActionStore();
    store.addAll([split, { ...split, instrument: 'AMD', exDate: '2024-07-01' }]);
    expect(store.known('NVDA', '2025-01-01')).toHaveLength(1);
    expect(store.known('AMD', '2025-01-01')).toHaveLength(1);
    expect(store.known('AVGO', '2025-01-01')).toEqual([]);
  });
});
