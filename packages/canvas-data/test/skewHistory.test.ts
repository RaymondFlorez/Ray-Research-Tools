import { describe, expect, it } from 'vitest';
import { BitemporalStore } from '../src/bitemporal.js';
import { MIN_HISTORY, recordSkew, skewHistory, skewKey, type SkewPoint } from '../src/skewHistory.js';

function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

function point(rr: number): SkewPoint {
  return { riskReversal: rr, butterfly: 0.01, atmVol: 0.3 };
}

/** Fifty days of 25-delta skew, each marked at 16:00 on its day. */
function fifty(): BitemporalStore<SkewPoint> {
  const store = new BitemporalStore<SkewPoint>();
  for (let i = 0; i < 50; i++) {
    recordSkew(store, {
      underlier: 'NVDA',
      delta: 0.25,
      date: day(i),
      point: point(0.02 + (i % 10) * 0.002),
      knownAt: `${day(i)}T16:00:00Z`,
    });
  }
  return store;
}

describe('skew history', () => {
  it('keeps the 25-delta and 10-delta series apart', () => {
    expect(skewKey('NVDA', 0.25)).not.toBe(skewKey('NVDA', 0.1));
    const store = fifty();
    recordSkew(store, { underlier: 'NVDA', delta: 0.1, date: day(49), point: point(0.2), knownAt: `${day(49)}T16:00:00Z` });
    const h = skewHistory(store, { underlier: 'NVDA', delta: 0.25, asof: `${day(60)}T00:00:00Z` });
    expect(h.points).toHaveLength(50);
    expect(h.points.every((p) => p.value.riskReversal < 0.1)).toBe(true);
  });

  it('ranks today against the days before it, not a sample that contains it', () => {
    const store = fifty();
    // Day 50 prints the highest skew on record.
    recordSkew(store, { underlier: 'NVDA', delta: 0.25, date: day(50), point: point(0.08), knownAt: `${day(50)}T16:00:00Z` });
    const h = skewHistory(store, { underlier: 'NVDA', delta: 0.25, from: day(1), asof: `${day(51)}T00:00:00Z` });
    expect(h.priorDays).toBe(49);
    expect(h.percentile).toBe(1);
    // The same fifty readings ranked with today among them.
    const withSelf = h.points.map((p) => p.value.riskReversal);
    const today = 0.08;
    const selfRank = (withSelf.filter((v) => v < today).length + withSelf.filter((v) => v === today).length / 2) / 50;
    expect(selfRank).toBe(0.99);
  });

  it('reads the history as it was known, not as it was later corrected', () => {
    const store = fifty();
    // Day 49's smile is corrected overnight: the skew was wider than marked.
    recordSkew(store, {
      underlier: 'NVDA',
      delta: 0.25,
      date: day(49),
      point: point(0.07),
      knownAt: `${day(50)}T07:00:00Z`,
      source: 'vendor correction',
    });
    const thatEvening = skewHistory(store, { underlier: 'NVDA', delta: 0.25, asof: `${day(49)}T20:00:00Z` });
    const nextMorning = skewHistory(store, { underlier: 'NVDA', delta: 0.25, asof: `${day(50)}T08:00:00Z` });
    expect(thatEvening.latest!.value.riskReversal).toBeCloseTo(0.038, 12);
    expect(nextMorning.latest!.value.riskReversal).toBe(0.07);
    expect(nextMorning.latest!.source).toBe('vendor correction');
  });

  it('does not report a percentile on too little history', () => {
    const store = fifty();
    const h = skewHistory(store, { underlier: 'NVDA', delta: 0.25, from: day(40), asof: `${day(60)}T00:00:00Z` });
    expect(h.priorDays).toBe(9);
    expect(h.priorDays).toBeLessThan(MIN_HISTORY);
    expect(h.percentile).toBeUndefined();
  });

  it('puts a flat history at the median, not at an end', () => {
    const store = new BitemporalStore<SkewPoint>();
    for (let i = 0; i < 30; i++) {
      recordSkew(store, { underlier: 'SPY', delta: 0.25, date: day(i), point: point(0.03), knownAt: `${day(i)}T16:00:00Z` });
    }
    expect(skewHistory(store, { underlier: 'SPY', delta: 0.25, asof: `${day(40)}T00:00:00Z` }).percentile).toBe(0.5);
  });
});
