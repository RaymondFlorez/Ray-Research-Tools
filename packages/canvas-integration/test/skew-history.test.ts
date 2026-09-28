/**
 * The skew-history seam (PRD 5.4, "skew and its history").
 *
 * `canvas-pricing` reads a day's risk reversal off a day's smile through the
 * engine; `canvas-data` keeps the series bitemporally. Neither depends on the
 * other, so the assignment from `Skew` to `SkewPoint` below is the only thing
 * that would notice either shape changing — at typecheck.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { BitemporalStore, recordSkew, skewHistory, type SkewPoint } from '@picasso/canvas-data';
import { skew, type PricingExports, type Skew, type SmileQuote } from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';

let wasm: PricingExports;
beforeAll(async () => {
  wasm = await loadPricing();
});

/** An equity smile whose put wing steepens by `tilt` vol points per 10 strikes. */
function smile(tilt: number): SmileQuote[] {
  const quotes: SmileQuote[] = [];
  for (const strike of [75, 80, 85, 90, 95, 100]) quotes.push({ strike, vol: 0.3 + tilt * (100 - strike) / 10, kind: 'put' });
  for (const strike of [100, 105, 110, 115, 120, 125]) quotes.push({ strike, vol: 0.3 - 0.004 * (strike - 100) / 10, kind: 'call' });
  return quotes;
}

function day(i: number): string {
  return new Date(Date.UTC(2026, 1, 2) + i * 86_400_000).toISOString().slice(0, 10);
}

describe('a month of skew, read by the engine and kept point-in-time', () => {
  it('ranks the steepest day at the top of its own history', () => {
    const store = new BitemporalStore<SkewPoint>();
    const tilts = Array.from({ length: 25 }, (_, i) => 0.01 + ((i * 7) % 11) * 0.001);
    tilts.push(0.03);
    for (const [i, tilt] of tilts.entries()) {
      const read: Skew = skew({ exports: wasm, quotes: smile(tilt), spot: 100, time: 0.25, rate: 0.04, dividend: 0 });
      // The seam, checked by the compiler.
      const point: SkewPoint = read;
      recordSkew(store, { underlier: 'SPX', delta: read.delta, date: day(i), point, knownAt: `${day(i)}T21:00:00Z` });
    }
    const history = skewHistory(store, { underlier: 'SPX', delta: 0.25, asof: `${day(30)}T00:00:00Z` });
    expect(history.points).toHaveLength(26);
    expect(history.priorDays).toBe(25);
    expect(history.percentile).toBe(1);
    // A steeper put wing is a larger risk reversal: the engine and the history
    // agree on which way is up.
    const values = history.points.map((p) => p.value.riskReversal);
    expect(values[values.length - 1]).toBe(Math.max(...values));
  });
});
