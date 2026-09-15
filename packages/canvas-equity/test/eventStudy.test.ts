import { describe, expect, it } from 'vitest';
import { CLUSTER_SPREAD_FLOOR, eventStudy, type EventSpec } from '../src/eventStudy.js';

/** SplitMix32, so every measurement below repeats exactly. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4_294_967_296;
  };
}

function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

const SESSIONS = 1000;
const calendar = Array.from({ length: SESSIONS }, (_, i) => `d${String(i).padStart(4, '0')}`);

interface World {
  returns: Map<string, Map<string, number>>;
  market: Map<string, number>;
  smb: Map<string, number>;
  hml: Map<string, number>;
}

/**
 * A market where every name loads on the market *and* on an industry factor,
 * and nothing whatsoever happens on event dates.
 *
 * The industry factor is the whole point, and the first version of this
 * simulation did not have one. Without it, every name was beta 1 on the market
 * and nothing else, the market model removed the entire common component, and
 * the residuals really were independent across firms — so clustering the
 * events changed the rejection rate from 3.3 percent to 5.3 percent, which is
 * to say not at all. The measurement refuted the claim the module was making.
 *
 * That was the simulation being wrong rather than the concern being wrong.
 * Clustering does not inflate significance by itself; it inflates it when the
 * events share common variation **the benchmark does not span**, which is the
 * realistic case and the only one worth warning about. A sector-wide
 * announcement moves a sector factor that a market model has never heard of,
 * and twenty residuals on that date all carry it.
 */
const INDUSTRY_LOADING = 1.0;

function world(symbols: readonly string[], seed: number): World {
  const next = rng(seed);
  const market = new Map<string, number>();
  const smb = new Map<string, number>();
  const hml = new Map<string, number>();
  const industry = new Map<string, number>();
  for (const date of calendar) {
    market.set(date, 0.01 * normal(next));
    smb.set(date, 0.006 * normal(next));
    hml.set(date, 0.006 * normal(next));
    // Not in the benchmark, and not in the market either: an industry shock
    // orthogonal to the market that every name in the sector carries.
    industry.set(date, 0.01 * normal(next));
  }
  const returns = new Map<string, Map<string, number>>();
  for (const symbol of symbols) {
    const series = new Map<string, number>();
    for (const date of calendar) {
      series.set(
        date,
        1.0 * (market.get(date) ?? 0) +
          INDUSTRY_LOADING * (industry.get(date) ?? 0) +
          0.012 * normal(next),
      );
    }
    returns.set(symbol, series);
  }
  return { returns, market, smb, hml };
}

function symbols(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `S${i}`);
}

describe('the three benchmark models', () => {
  const names = symbols(20);
  const { returns, market, smb, hml } = world(names, 7);
  const spread: EventSpec[] = names.map((symbol, i) => ({ symbol, date: calendar[200 + i * 30]! }));

  it('recover roughly zero abnormal return when nothing happened', () => {
    for (const model of ['market_model', 'ff3'] as const) {
      const study = eventStudy({ events: spread, calendar, returns, market, smb, hml, model });
      expect(study.results).toHaveLength(20);
      expect(Math.abs(study.caar)).toBeLessThan(0.02);
    }
  });

  // Around 0.3, not higher: the industry factor takes roughly half the common
  // variance and a market model does not span it. That gap is exactly what the
  // clustering measurement below turns into false positives.
  it('fit the market model to the part of the variance it spans', () => {
    const study = eventStudy({ events: spread, calendar, returns, market, model: 'market_model' });
    const median = [...study.results.map((r) => r.rSquared)].sort((a, b) => a - b)[10]!;
    expect(median).toBeGreaterThan(0.2);
    expect(median).toBeLessThan(0.45);
  });

  // The matched-firm model assumes nothing about factor structure, and pays
  // for that by inheriting all of the control's own idiosyncratic noise.
  it('warn that a matched-firm benchmark carries the control\'s noise', () => {
    const study = eventStudy({
      events: spread.slice(0, 10),
      calendar,
      returns,
      market,
      model: 'matched_firm',
      matched: (event) => (event.symbol === 'S0' ? 'S19' : 'S0'),
    });
    expect(study.results[0]?.warning).toContain('idiosyncratic noise');
  });

  it('skip an event with no room for an estimation window rather than shortening one', () => {
    const study = eventStudy({
      events: [{ symbol: 'S0', date: calendar[3]! }],
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(study.results).toHaveLength(0);
    expect(study.warnings.join(' ')).toContain('not enough history');
  });
});

describe('event-date clustering', () => {
  it('is measured, not assumed', () => {
    const names = symbols(20);
    const { returns, market } = world(names, 11);
    const clustered = eventStudy({
      events: names.map((symbol) => ({ symbol, date: calendar[250]! })),
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(clustered.clustering.distinctDates).toBe(1);
    expect(clustered.clustering.largestCluster).toBe(20);
    expect(clustered.clustering.clustered).toBe(true);
    expect(clustered.recommended).toBe('calendar');

    const spread = eventStudy({
      events: names.map((symbol, i) => ({ symbol, date: calendar[200 + i * 5]! })),
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(spread.clustering.spread).toBe(1);
    expect(spread.clustering.clustered).toBe(false);
    expect(spread.recommended).toBe('naive');
  });

  it('explains the recommendation in terms of what breaks', () => {
    const names = symbols(20);
    const { returns, market } = world(names, 13);
    const study = eventStudy({
      events: names.map((symbol) => ({ symbol, date: calendar[250]! })),
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(study.warnings.join(' ')).toContain('market-wide surprise');
  });
});

/**
 * The measurement that justifies the warning.
 *
 * Under a null with no abnormal return at all, a 5 percent test should reject
 * 5 percent of the time. When events are spread across the calendar it roughly
 * does. When they share dates it does not — because the twenty residuals on
 * that one date all carry the same industry shock, so the cross-sectional
 * standard error is computed from twenty copies of one draw rather than from
 * twenty independent ones.
 */
describe('what clustering does to the naive test', () => {
  function rejectionRate(
    clusterEvents: boolean,
    trials: number,
    spacing = 30,
  ): { naive: number; calendar: number } {
    const names = symbols(20);
    let naive = 0;
    let calendarRejects = 0;
    for (let t = 0; t < trials; t += 1) {
      const { returns, market } = world(names, 1000 + t);
      const events: EventSpec[] = clusterEvents
        ? names.map((symbol) => ({ symbol, date: calendar[250]! }))
        : names.map((symbol, i) => ({ symbol, date: calendar[200 + i * spacing]! }));
      const study = eventStudy({ events, calendar, returns, market, model: 'market_model' });
      if (Math.abs(study.naiveT) > 2.093) naive += 1;
      if (Number.isFinite(study.calendarT) && Math.abs(study.calendarT) > 2.093) calendarRejects += 1;
    }
    return { naive: naive / trials, calendar: calendarRejects / trials };
  }

  it('inflates the false-positive rate, by a measured amount', () => {
    const trials = 400;
    const spread = rejectionRate(false, trials);
    const clustered = rejectionRate(true, trials);

    // eslint-disable-next-line no-console
    console.log(
      `event study under the null, ${trials} trials: ` +
        `spread events reject at ${(spread.naive * 100).toFixed(1)}%, ` +
        `same-day events reject at ${(clustered.naive * 100).toFixed(1)}% ` +
        '(nominal 5%)',
    );

    // Spread events: the test does roughly what it says on the tin.
    expect(spread.naive).toBeLessThan(0.12);
    // Clustered events: it does not, and by enough to matter.
    expect(clustered.naive).toBeGreaterThan(0.3);
    expect(clustered.naive).toBeGreaterThan(spread.naive * 3);
  });

  // The quieter form of the same problem, and one the measurement found
  // rather than the design anticipating it. Events five days apart look
  // perfectly unclustered by every date-based count, and an eleven-day window
  // on them overlaps by six days.
  it('detects overlapping windows even when every event is on its own date', () => {
    const names = symbols(20);
    const { returns, market } = world(names, 41);
    const tight = eventStudy({
      events: names.map((symbol, i) => ({ symbol, date: calendar[200 + i * 5]! })),
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(tight.clustering.spread).toBe(1);
    expect(tight.clustering.clustered).toBe(false);
    expect(tight.clustering.overlappingPairs).toBeGreaterThan(0);
    expect(tight.warnings.join(' ')).toContain('overlapping');
    // And it does not claim the calendar-time statistic repairs it.
    expect(tight.warnings.join(' ')).toContain('does not repair it');
  });

  it('measures what overlapping windows alone do to the test', () => {
    const trials = 400;
    const overlapping = rejectionRate(false, trials, 5);
    const separated = rejectionRate(false, trials, 30);
    // eslint-disable-next-line no-console
    console.log(
      `event study under the null, ${trials} trials: events 5 days apart (windows overlap) ` +
        `reject at ${(overlapping.naive * 100).toFixed(1)}%, 30 days apart at ` +
        `${(separated.naive * 100).toFixed(1)}% (nominal 5%)`,
    );
    expect(overlapping.naive).toBeGreaterThan(separated.naive * 2);
  });

  // With every event on one date the calendar-time statistic has a single
  // observation and no variance to divide by, so it declines to produce a
  // number rather than producing a confident one.
  it('leaves the calendar-time statistic undefined rather than confident when there is one date', () => {
    const names = symbols(20);
    const { returns, market } = world(names, 99);
    const study = eventStudy({
      events: names.map((symbol) => ({ symbol, date: calendar[250]! })),
      calendar,
      returns,
      market,
      model: 'market_model',
    });
    expect(Number.isNaN(study.calendarT)).toBe(true);
    expect(Number.isFinite(study.naiveT)).toBe(true);
  });
});

describe('the cluster floor', () => {
  it('is a stated constant, not a magic number in a branch', () => {
    expect(CLUSTER_SPREAD_FLOOR).toBe(0.8);
  });
});
