import { describe, expect, it } from 'vitest';
import {
  FAMA_FRENCH_5,
  FF5_PLUS_QUALITY,
  HIGH_VIF,
  WEAK_FIT_R2,
  factorExposure,
  varianceInflation,
  type FactorSeries,
} from '../src/factors.js';
import { ols } from '../src/ols.js';

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

const N = 500;

function independentFactors(seed: number): FactorSeries[] {
  const next = rng(seed);
  return FAMA_FRENCH_5.map((name) => ({
    name,
    values: Array.from({ length: N }, () => 0.01 * normal(next)),
  }));
}

describe('OLS', () => {
  it('recovers coefficients it was given', () => {
    const next = rng(3);
    const x1 = Array.from({ length: N }, () => normal(next));
    const x2 = Array.from({ length: N }, () => normal(next));
    const y = x1.map((a, i) => 0.5 + 2 * a - 1.5 * (x2[i] ?? 0) + 0.01 * normal(next));
    const fit = ols(y, [x1, x2]);
    expect(fit.coefficients[0]).toBeCloseTo(0.5, 2);
    expect(fit.coefficients[1]).toBeCloseTo(2, 2);
    expect(fit.coefficients[2]).toBeCloseTo(-1.5, 2);
    expect(fit.rSquared).toBeGreaterThan(0.99);
  });

  it('refuses a rank-deficient design rather than returning a number', () => {
    const next = rng(5);
    const x = Array.from({ length: 50 }, () => normal(next));
    // A perfect duplicate column: there is no unique fit.
    const fit = ols(x, [x, x.map((v) => v * 2)]);
    expect(fit.warning).toContain('collinear');
    expect(fit.coefficients.every(Number.isNaN)).toBe(true);
  });

  it('refuses to fit more parameters than observations', () => {
    expect(ols([1, 2, 3], [[1, 2, 3], [4, 5, 6], [7, 8, 9]]).warning).toContain('cannot fit');
  });
});

describe('factor exposures', () => {
  it('recover the loadings a return series was built from', () => {
    // Separate seeds. Drawing the factors and the noise from one stream makes
    // the "noise" a linear combination of the factor draws, which showed up as
    // a beta of 1.6 where 1.2 was set and an R-squared of exactly 1 on a
    // return series that was supposed to be pure noise.
    const next = rng(101);
    const factors = independentFactors(11);
    const loadings = [1.2, -0.4, 0.3, 0.1, -0.2];
    const returns = Array.from({ length: N }, (_, i) =>
      factors.reduce((total, f, j) => total + (loadings[j] ?? 0) * (f.values[i] ?? 0), 0.0002) +
      0.004 * normal(next),
    );
    const result = factorExposure(returns, factors);
    for (const [i, loading] of loadings.entries()) {
      expect(result.exposures[i]?.beta).toBeCloseTo(loading, 1);
    }
    expect(result.rSquared).toBeGreaterThan(0.5);
    expect(result.warnings).toEqual([]);
  });

  // An exposure of 1.4 on an R-squared of 0.06 is a number, not an exposure.
  it('warn when the loadings explain almost none of the return series', () => {
    const next = rng(103);
    const factors = independentFactors(13);
    const returns = Array.from({ length: N }, () => 0.02 * normal(next));
    const result = factorExposure(returns, factors);
    expect(result.rSquared).toBeLessThan(WEAK_FIT_R2);
    expect(result.warnings.join(' ')).toContain('explain little');
  });

  // HML and CMA are correlated enough in most samples that their individual
  // loadings swing while the fit barely moves.
  it('surface variance inflation when two factors are nearly the same thing', () => {
    const next = rng(107);
    const base = independentFactors(17);
    const hml = base[2]!;
    const nearDuplicate: FactorSeries = {
      name: 'cma',
      values: hml.values.map((v) => v * 0.95 + 0.0008 * normal(next)),
    };
    const factors = [base[0]!, base[1]!, hml, base[3]!, nearDuplicate];
    const returns = Array.from({ length: N }, (_, i) => 1.0 * (base[0]!.values[i] ?? 0) + 0.004 * normal(next));
    const result = factorExposure(returns, factors);

    const cma = result.exposures.find((e) => e.factor === 'cma')!;
    expect(cma.vif).toBeGreaterThan(HIGH_VIF);
    expect(result.warnings.join(' ')).toContain('largely determined by the other factors');
    // The market loading, which is orthogonal to the pair, is unaffected.
    expect(result.exposures[0]?.vif).toBeLessThan(2);
  });

  it('report VIF of 1 for orthogonal factors', () => {
    const factors = independentFactors(19);
    for (const vif of varianceInflation(factors.map((f) => f.values))) {
      expect(vif).toBeLessThan(1.1);
    }
  });

  it('report VIF of exactly 1 for a single regressor, with nothing to be collinear with', () => {
    expect(varianceInflation([[1, 2, 3]])).toEqual([1]);
  });

  // Infinity, not NaN: NaN would make the column drop silently out of the
  // high-VIF check precisely when it is most broken.
  it('report infinite VIF for an exactly duplicated column', () => {
    const next = rng(127);
    const a = Array.from({ length: 60 }, () => normal(next));
    const vifs = varianceInflation([a, a.map((v) => v * 2)]);
    expect(vifs.every((v) => v === Number.POSITIVE_INFINITY)).toBe(true);
  });

  // A custom factor gets no special treatment: an analyst who builds "quality"
  // out of the same inputs as RMW will see a VIF that says so.
  it('treat a custom factor exactly like a standard one', () => {
    const next = rng(109);
    const base = independentFactors(23);
    const rmw = base[3]!;
    const custom: FactorSeries = {
      name: 'my quality',
      values: rmw.values.map((v) => v * 0.98 + 0.0005 * normal(next)),
    };
    const returns = Array.from({ length: N }, () => 0.01 * normal(next));
    const result = factorExposure(returns, [...base, custom]);
    const mine = result.exposures.find((e) => e.factor === 'my quality')!;
    expect(mine.vif).toBeGreaterThan(HIGH_VIF);
  });

  it('carries the window and the observation count with the result', () => {
    const factors = independentFactors(29);
    const next = rng(113);
    const returns = Array.from({ length: N }, () => 0.01 * normal(next));
    const result = factorExposure(returns, factors, ['2021-01-01', '2026-01-01']);
    expect(result.window).toEqual(['2021-01-01', '2026-01-01']);
    expect(result.observations).toBe(N);
  });

  it('degrades to NaN with a warning rather than throwing on a hopeless fit', () => {
    const result = factorExposure(
      [1, 2],
      [
        { name: 'a', values: [1, 2] },
        { name: 'b', values: [3, 4] },
        { name: 'c', values: [5, 6] },
      ],
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(Number.isNaN(result.alpha)).toBe(true);
  });

  it('names the six columns the PRD asks for', () => {
    expect(FF5_PLUS_QUALITY).toEqual(['mkt', 'smb', 'hml', 'rmw', 'cma', 'quality']);
  });
});
