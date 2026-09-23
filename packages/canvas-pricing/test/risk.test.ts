import { beforeAll, describe, expect, it } from 'vitest';
import { GridPricer, type Leg, type Market } from '../src/grid.js';
import type { PricingExports } from '../src/module.js';
import {
  PORTFOLIO_MARGIN_RANGE,
  assignmentRisk,
  pinRisk,
  portfolioMargin,
  regTMargin,
  strikeSigmas,
} from '../src/risk.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;
let pricer: GridPricer;

beforeAll(async () => {
  wasm = await loadPricing();
  pricer = new GridPricer(wasm);
});

const market: Market = { spot: 100, rate: 0.045, dividend: 0.017 };

function leg(overrides: Partial<Leg> = {}): Leg {
  return {
    strike: 100,
    time: 0.5,
    kind: 'call',
    style: 'american',
    quantity: -10,
    multiplier: 100,
    vol: 0.3,
    ...overrides,
  };
}

const DAY = 1 / 252;

describe('pin risk', () => {
  it('flags a short strike sitting on the spot in the last days', () => {
    const flags = pinRisk(wasm, [leg({ strike: 100, time: 2 * DAY })], market);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.sigmas).toBe(0);
    expect(flags[0]!.sharesAtRisk).toBe(1000);
    expect(flags[0]!.message).toContain('1000 shares');
  });

  it('leaves a long position alone', () => {
    // A long option at the strike is the holder's decision to make. A short
    // one is a decision made for them, after the close.
    const flags = pinRisk(wasm, [leg({ strike: 100, time: 2 * DAY, quantity: 10 })], market);
    expect(flags).toEqual([]);
  });

  it('leaves a strike with a month to run alone, however close it is', () => {
    expect(pinRisk(wasm, [leg({ strike: 100, time: 30 * DAY })], market)).toEqual([]);
  });

  it('measures the distance in remaining sigma, not in percent', () => {
    // The property a fixed band cannot have: two percent away is far on a
    // twelve-vol name and close enough to pin on a ninety-vol one.
    const utility = leg({ strike: 102, time: 2 * DAY, vol: 0.12 });
    const biotech = leg({ strike: 102, time: 2 * DAY, vol: 0.9 });
    expect(strikeSigmas(wasm, utility, market)).toBeCloseTo(1.852, 3);
    expect(strikeSigmas(wasm, biotech, market)).toBeCloseTo(0.247, 3);
    expect(pinRisk(wasm, [utility], market)).toEqual([]);
    expect(pinRisk(wasm, [biotech], market)).toHaveLength(1);
  });

  it('runs away from every strike but the one the spot is on, as expiry arrives', () => {
    const far = strikeSigmas(wasm, leg({ strike: 101, time: 5 * DAY }), market);
    const near = strikeSigmas(wasm, leg({ strike: 101, time: DAY }), market);
    expect(near).toBeGreaterThan(far);
    expect(strikeSigmas(wasm, leg({ strike: 101, time: 0 }), market)).toBe(Infinity);
    expect(strikeSigmas(wasm, leg({ strike: 100, time: 0 }), market)).toBe(0);
  });
});

describe('assignment risk', () => {
  /** The option's own mark, from the engine, so extrinsic is a real number. */
  function mark(l: Leg, m: Market = market): number {
    return wasm.pc_american_exact(
      m.spot,
      l.strike,
      l.time,
      m.rate,
      m.dividend,
      l.vol,
      l.kind === 'call' ? 1 : 0,
    );
  }

  it('never flags a short call on a non-dividend payer, however deep', () => {
    const noDividend: Market = { ...market, dividend: 0 };
    for (const strike of [50, 70, 90]) {
      const l = leg({ strike, time: 0.05 });
      expect(
        assignmentRisk({
          exports: wasm,
          legs: [l],
          market: noDividend,
          marks: [mark(l, noDividend)],
        }),
      ).toEqual([]);
    }
  });

  it('flags a short deep call when the dividend outweighs the time value', () => {
    const fat: Market = { spot: 100, rate: 0.01, dividend: 0.12 };
    const l = leg({ strike: 70, time: 0.08, vol: 0.18 });
    const flags = assignmentRisk({ exports: wasm, legs: [l], market: fat, marks: [mark(l, fat)] });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.carry).toBeGreaterThan(flags[0]!.extrinsic);
    expect(flags[0]!.sharesAtRisk).toBe(1000);
  });

  it('flags a short deep put on the interest in the strike', () => {
    const l = leg({ strike: 150, kind: 'put', time: 0.08, vol: 0.18 });
    const flags = assignmentRisk({ exports: wasm, legs: [l], market, marks: [mark(l)] });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.carry).toBeGreaterThan(0);
  });

  it('never flags a European leg, which cannot be assigned early', () => {
    const fat: Market = { spot: 100, rate: 0.01, dividend: 0.12 };
    const american = leg({ strike: 70, time: 0.08, vol: 0.18 });
    const european = { ...american, style: 'european' as const };
    expect(
      assignmentRisk({ exports: wasm, legs: [american], market: fat, marks: [mark(american, fat)] }),
    ).toHaveLength(1);
    expect(
      assignmentRisk({ exports: wasm, legs: [european], market: fat, marks: [mark(european, fat)] }),
    ).toEqual([]);
  });

  it('never flags an out-of-the-money short, which nobody exercises', () => {
    const fat: Market = { spot: 100, rate: 0.01, dividend: 0.12 };
    const l = leg({ strike: 130, time: 0.08, vol: 0.18 });
    expect(assignmentRisk({ exports: wasm, legs: [l], market: fat, marks: [mark(l, fat)] })).toEqual(
      [],
    );
  });

  it('takes a dated dividend over the yield when it is given one', () => {
    const noYield: Market = { spot: 100, rate: 0.01, dividend: 0 };
    const l = leg({ strike: 70, time: 0.08, vol: 0.18 });
    const marks = [mark(l, noYield)];
    // With no yield and no list, the call cannot be worth exercising.
    expect(assignmentRisk({ exports: wasm, legs: [l], market: noYield, marks })).toEqual([]);
    // A large dividend inside the life changes the answer; one after expiry
    // does not, which is the whole reason the date matters.
    expect(
      assignmentRisk({
        exports: wasm,
        legs: [l],
        market: noYield,
        marks,
        dividends: [{ time: 0.02, amount: 3 }],
      }),
    ).toHaveLength(1);
    expect(
      assignmentRisk({
        exports: wasm,
        legs: [l],
        market: noYield,
        marks,
        dividends: [{ time: 0.5, amount: 3 }],
      }),
    ).toEqual([]);
  });
});

describe('Reg-T margin', () => {
  it('charges a long option its premium and nothing else', () => {
    const l = leg({ quantity: 5 });
    const margin = regTMargin({ legs: [l], market, marks: [7.5] });
    expect(margin.lines[0]!.treatment).toBe('long_premium');
    expect(margin.total).toBe(7.5 * 5 * 100);
  });

  it('charges a naked short twenty percent of spot, less what is out of the money', () => {
    const l = leg({ strike: 110, quantity: -1 });
    const margin = regTMargin({ legs: [l], market, marks: [3] });
    // premium 3 + 20% of 100 = 20, less the 10 out of the money -> 13/share.
    expect(margin.lines[0]!.treatment).toBe('naked_short');
    expect(margin.total).toBeCloseTo(13 * 100, 9);
  });

  it('applies the floor when the strike is far out of the money', () => {
    const l = leg({ strike: 200, quantity: -1 });
    const margin = regTMargin({ legs: [l], market, marks: [0.2] });
    // 0.2 + 20 - 100 is negative; the floor is 0.2 + 10% of spot.
    expect(margin.total).toBeCloseTo((0.2 + 10) * 100, 9);
  });

  it('margins a vertical at its width, less the credit', () => {
    const short = leg({ strike: 100, quantity: -1 });
    const long = leg({ strike: 110, quantity: 1 });
    const margin = regTMargin({ legs: [short, long], market, marks: [8, 3] });
    // The reason anybody trades a spread: ten wide, five credit, five at risk.
    expect(margin.lines.map((l) => l.treatment)).toEqual(['spread']);
    expect(margin.total).toBeCloseTo(5 * 100, 9);
  });

  it('covers what it can and leaves the rest naked', () => {
    const short = leg({ strike: 100, quantity: -3 });
    const long = leg({ strike: 110, quantity: 1 });
    const margin = regTMargin({ legs: [short, long], market, marks: [8, 3] });
    expect(margin.lines.map((l) => l.treatment).sort()).toEqual(['naked_short', 'spread']);
    const spread = margin.lines.find((l) => l.treatment === 'spread')!;
    const naked = margin.lines.find((l) => l.treatment === 'naked_short')!;
    expect(spread.requirement).toBeCloseTo(5 * 100, 9);
    // Two lots left naked: 8 + 20 - 0 out of the money.
    expect(naked.requirement).toBeCloseTo(28 * 2 * 100, 9);
  });

  it('will not cover a call with a put, or a near month with a far one', () => {
    const short = leg({ strike: 100, quantity: -1, kind: 'call' });
    const wrongType = leg({ strike: 100, quantity: 1, kind: 'put' });
    const wrongMonth = leg({ strike: 100, quantity: 1, kind: 'call', time: 1.5 });
    for (const other of [wrongType, wrongMonth]) {
      const margin = regTMargin({ legs: [short, other], market, marks: [8, 8] });
      expect(margin.lines.some((l) => l.treatment === 'spread')).toBe(false);
    }
  });
});

describe('portfolio margin', () => {
  /** A naked short strangle: the book portfolio margin is supposed to punish. */
  const strangle: Leg[] = [
    { strike: 90, time: 0.5, kind: 'put', style: 'european', quantity: -10, multiplier: 100, vol: 0.32 },
    { strike: 110, time: 0.5, kind: 'call', style: 'european', quantity: -10, multiplier: 100, vol: 0.26 },
  ];

  /** The same strangle with the wings bought back: defined risk. */
  const ironCondor: Leg[] = [
    ...strangle,
    { strike: 80, time: 0.5, kind: 'put', style: 'european', quantity: 10, multiplier: 100, vol: 0.36 },
    { strike: 120, time: 0.5, kind: 'call', style: 'european', quantity: 10, multiplier: 100, vol: 0.25 },
  ];

  const wide = { spotSteps: 31, spotRange: PORTFOLIO_MARGIN_RANGE, volSteps: 5, volRange: 0.1 };

  it('is the worst loss across the prescribed range', () => {
    const result = pricer.reprice(strangle, market, wide);
    const margin = portfolioMargin(result, market);
    expect(margin.requirement).toBeGreaterThan(0);
    // The worst cell is a real cell, not an interpolation.
    const worst = margin.scenarios.reduce((a, b) => (b.pnl < a.pnl ? b : a));
    expect(margin.requirement).toBeCloseTo(-worst.pnl, 9);
    expect(Math.abs(margin.worstSpotShift)).toBeLessThanOrEqual(PORTFOLIO_MARGIN_RANGE + 1e-12);
    expect(margin.shortfall).toBeUndefined();
  });

  it('charges far less for the hedged book than Reg-T does', () => {
    const condor = portfolioMargin(pricer.reprice(ironCondor, market, wide), market);
    const naked = portfolioMargin(pricer.reprice(strangle, market, wide), market);
    // Buying the wings caps the loss, and a scenario sweep sees that where a
    // per-position formula cannot.
    expect(condor.requirement).toBeLessThan(naked.requirement);

    const marks = ironCondor.map((l) =>
      wasm.pc_price(market.spot, l.strike, l.time, market.rate, market.dividend, l.vol, l.kind === 'call' ? 1 : 0),
    );
    const regT = regTMargin({ legs: ironCondor, market, marks });
    expect(condor.requirement).toBeLessThan(regT.total);
  });

  it('says so when the grid is narrower than the rule', () => {
    const narrow = { spotSteps: 11, spotRange: 0.05, volSteps: 3, volRange: 0.05 };
    const margin = portfolioMargin(pricer.reprice(strangle, market, narrow), market);
    // A margin number produced by guessing past the edge of what was priced is
    // the kind of number that gets believed.
    expect(margin.shortfall).toContain('5.0%');
    expect(margin.shortfall).toContain('15%');
  });
});
