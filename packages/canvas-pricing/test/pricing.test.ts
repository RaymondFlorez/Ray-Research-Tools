import { beforeAll, describe, expect, it } from 'vitest';
import { Pricer, type OptionInputs } from '../src/pricing.js';
import { loadPricing } from './load.js';

let pricer: Pricer;

beforeAll(async () => {
  pricer = new Pricer(await loadPricing());
});

const atm: OptionInputs = {
  spot: 100, strike: 100, time: 0.5, rate: 0.045, dividend: 0.017, vol: 0.28, kind: 'call',
};

describe('the scalar surface', () => {
  it('prices a European call', () => {
    const price = pricer.price(atm);
    // Sanity, not a fixture: an ATM half-year call at 28 vol is worth roughly
    // 0.4 * S * vol * sqrt(T), which is about 7.9.
    expect(price).toBeGreaterThan(7);
    expect(price).toBeLessThan(9);
  });

  it('returns all ten Greeks, with price consistent with the price call', () => {
    const g = pricer.greeks(atm);
    expect(Object.keys(g)).toHaveLength(10);
    // Same inputs, same transcendentals: this is an equality, not an epsilon.
    expect(g.price).toBe(pricer.price(atm));
    expect(g.delta).toBeGreaterThan(0.5);
    expect(g.delta).toBeLessThan(0.65);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.vega).toBeGreaterThan(0);
    // A long call decays.
    expect(g.theta).toBeLessThan(0);
  });

  it('puts and calls satisfy parity', () => {
    const call = pricer.price(atm);
    const put = pricer.price({ ...atm, kind: 'put' });
    const forward = atm.spot * Math.exp(-atm.dividend * atm.time);
    const strikePv = atm.strike * Math.exp(-atm.rate * atm.time);
    expect(call - put).toBeCloseTo(forward - strikePv, 10);
  });

  it('an American call on a dividend payer is worth at least the European', () => {
    const euro = pricer.price(atm);
    const american = pricer.americanExact(atm);
    // The guard's lattice runs at 51 steps and carries about 5.6e-4 of
    // discretisation error of its own, so the early-exercise premium can only
    // be asserted to that. Asserting tighter tests the lattice's step count,
    // not the inequality.
    expect(american).toBeGreaterThanOrEqual(euro - 6e-4);
    // The detail lattice, at 255 steps, is 25x closer and clears it outright.
    expect(pricer.americanDetail(atm)).toBeGreaterThanOrEqual(euro - 3e-5);
  });
});

describe('implied vol says why, not just no', () => {
  it('recovers the vol it was priced with', () => {
    const price = pricer.price(atm);
    const solved = pricer.impliedVol(atm, price);
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(solved.vol).toBeCloseTo(atm.vol, 8);
  });

  it('refuses a price below intrinsic rather than inventing a vol', () => {
    // A 60-strike call with spot at 100 is worth at least 40; nothing quotes 5.
    const result = pricer.impliedVol({ ...atm, strike: 60 }, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('below_intrinsic');
      // Distinct from the "--" case: this quote is wrong, not uninformative.
      expect(result.display).not.toBe('--');
    }
  });

  it('shows "--" where the price carries no information about vol', () => {
    // Deep in the money, days from expiry: vega has collapsed and every vol in
    // a wide band reproduces the price to the last bit of a double.
    const deep = { ...atm, strike: 20, time: 0.004 };
    const price = pricer.price({ ...deep, vol: 0.28 });
    const result = pricer.impliedVol(deep, price);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_identifiable');
      expect(result.display).toBe('--');
    }
  });

  it('reports the reason for the call just made, not a stale one', () => {
    const bad = pricer.impliedVol({ ...atm, strike: 60 }, 5);
    expect(bad.ok).toBe(false);
    // A successful solve in between must not leave the previous reason readable
    // as if it belonged to it.
    const good = pricer.impliedVol(atm, pricer.price(atm));
    expect(good.ok).toBe(true);
    expect(pricer.exports.pc_implied_vol_reason()).toBe(0);
  });
});

describe('discrete dividends (PRD 5.4)', () => {
  const name: OptionInputs = { spot: 100, strike: 95, time: 0.5, rate: 0.05, dividend: 0, vol: 0.3, kind: 'call' };
  const exDate = [{ time: 0.45, amount: 4 }];

  it('prices a European as Black-Scholes on the escrowed spot', () => {
    const escrowed = 100 - 4 * Math.exp(-0.05 * 0.45);
    // The escrowed spot is computed here with Math.exp, so the comparison is
    // to rounding rather than to the bit.
    expect(pricer.priceWithDividends(name, exDate, { style: 'european' })).toBeCloseTo(pricer.price({ ...name, spot: escrowed }), 12);
  });

  it('values the early exercise a dividend makes worth having', () => {
    const european = pricer.priceWithDividends(name, exDate, { style: 'european' });
    const american = pricer.priceWithDividends(name, exDate, { style: 'american' });
    // Roll-Geske-Whaley puts this call at 11.5847 (computed in the crate's
    // suite); the default 1,000-step tree lands 0.0032 under it.
    expect(Math.abs(american - 11.5847)).toBeLessThan(0.004);
    // 1.78 of the value is the right to exercise the day before the ex-date.
    expect(american - european).toBeCloseTo(1.776, 3);
    // With no dividend the tree agrees with Andersen-Lake to 0.0003, and both
    // with Black-Scholes: a call on a non-payer is never exercised early.
    const plain = pricer.priceWithDividends(name, [], { style: 'american' });
    expect(Math.abs(plain - pricer.americanDetail(name))).toBeLessThan(0.0005);
  });

  it('refuses dividends worth more than the stock', () => {
    expect(pricer.priceWithDividends(name, [{ time: 0.1, amount: 150 }], { style: 'american' })).toBeNaN();
  });
});
