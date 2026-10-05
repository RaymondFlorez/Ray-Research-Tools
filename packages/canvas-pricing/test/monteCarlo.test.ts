import { beforeAll, describe, expect, it } from 'vitest';
import {
  CorrelationRejected,
  DEFAULT_COST_CEILING,
  DependenceRejected,
  HistoryRejected,
  gbmFromHistory,
  runResampled,
  type ResampleSpec,
  EmptySimulation,
  ResultSuperseded,
  SimulationTooLarge,
  estimateCost,
  runMonteCarlo,
  type GbmAsset,
  type McSpec,
  type PricingExports,
} from '../src/index.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;
beforeAll(async () => {
  wasm = await loadPricing();
});

/** A GBM asset. The other processes carry different parameters and are built inline. */
function asset(overrides: Partial<GbmAsset> = {}): GbmAsset {
  return { id: 'a', spot: 100, weight: 1, vol: 0.25, rate: 0.03, dividend: 0, ...overrides };
}

function spec(overrides: Partial<McSpec> = {}): McSpec {
  return {
    assets: [asset()],
    correlation: { kind: 'independent' },
    time: 1,
    paths: 8_000,
    steps: 32,
    seed: 0xc0ffee,
    ...overrides,
  };
}

describe('the distribution port', () => {
  it('carries moments, percentiles, CVaR and a drawdown distribution', () => {
    const result = runMonteCarlo(wasm, spec());

    expect(result.paths).toBe(8_000);
    expect(result.steps).toBe(32);
    expect(result.assets).toBe(1);

    // A GBM's terminal expectation is S0 * exp((r - q) T), and the standard
    // error says how close this run should have got.
    const expected = 100 * Math.exp(0.03);
    expect(Math.abs(result.moments.mean - expected)).toBeLessThan(
      4 * Math.max(result.moments.standardError, 1e-9),
    );
    // Lognormal: right-skewed, fat-tailed.
    expect(result.moments.skewness).toBeGreaterThan(0.5);
    expect(result.moments.excessKurtosis).toBeGreaterThan(0.3);

    const levels = Object.keys(result.percentiles).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i += 1) {
      expect(result.percentiles[String(levels[i])]).toBeGreaterThan(
        result.percentiles[String(levels[i - 1])] as number,
      );
    }

    for (const level of ['0.01', '0.05', '0.1']) {
      expect(result.cvar[level]).toBeLessThanOrEqual(result.percentiles['0.05'] as number);
    }
    expect(result.cvar['0.01']).toBeLessThan(result.cvar['0.1'] as number);

    expect(result.drawdown['0.5']).toBeGreaterThan(0);
    expect(result.drawdown['0.95']).toBeGreaterThan(result.drawdown['0.5'] as number);
  });

  it('returns a path sample, not a snapshot', () => {
    const result = runMonteCarlo(wasm, spec({ samplePaths: 12 }));
    expect(result.sample.length).toBe(12);
    for (const path of result.sample) {
      expect(path.length).toBe(33);
      expect(path[0]).toBeCloseTo(100, 10);
      expect(path.some((v) => Math.abs(v - 100) > 1e-9)).toBe(true);
    }
  });

  // PRD 5.8: "so the browser never loads a 4GB array". The engine refuses to
  // build the cube; this asserts the refusal survives the boundary.
  it('reports what it retained against the cube it never built', () => {
    const result = runMonteCarlo(wasm, spec({ assets: [asset(), asset({ id: 'b', spot: 60 })] }));
    expect(result.cubeValues).toBe(8_000 * 32 * 2);
    expect(result.compression).toBeGreaterThan(20);
    expect(result.retainedValues).toBeLessThan(result.cubeValues);
  });

  // The full vectors are functions rather than fields: 100,000 doubles is
  // 800KB, and a node reading five percentiles should not pay for it.
  it('hands back the full vectors only when asked', () => {
    const result = runMonteCarlo(wasm, spec());
    const terminal = result.terminal();
    expect(terminal.length).toBe(8_000);
    for (let i = 1; i < terminal.length; i += 1) {
      expect(terminal[i]).toBeGreaterThanOrEqual(terminal[i - 1] as number);
    }
    expect(result.drawdownPaths().length).toBe(8_000);
  });

  // The hazard laziness across a one-slot boundary creates, and the reason the
  // accessors carry a run number. Before this check, a `terminal()` after a
  // second run returned the *second* run's values under the first result's
  // name — same length, plausible numbers, wrong answer — and this test is
  // what found it.
  it('refuses a lazy read once another run has overwritten the slot', () => {
    const first = runMonteCarlo(wasm, spec({ seed: 1 }));
    const copy = first.terminal();

    const second = runMonteCarlo(wasm, spec({ seed: 7 }));
    expect(second.paths).toBe(8_000);

    expect(() => first.terminal()).toThrow(ResultSuperseded);
    expect(() => first.drawdownPaths()).toThrow(ResultSuperseded);
    // The copy taken in time is still the first run's, and still correct.
    expect(copy.length).toBe(8_000);
    expect(copy[0]).not.toBe(second.terminal()[0]);
  });
});

describe('correlation across assets', () => {
  const two = [asset({ id: 'a' }), asset({ id: 'b' })];

  /** Read off three variances, since the terminals come back sorted. */
  function impliedCorrelation(correlation: McSpec['correlation']): number {
    const run = (wa: number, wb: number) =>
      runMonteCarlo(
        wasm,
        spec({
          assets: [
            { ...(two[0] as GbmAsset), weight: wa },
            { ...(two[1] as GbmAsset), weight: wb },
          ],
          correlation,
          paths: 40_000,
          steps: 32,
          antithetic: false,
        }),
      ).moments.variance;

    const va = run(1, 0);
    const vb = run(0, 1);
    const vp = run(0.5, 0.5);
    return (2 * (vp - 0.25 * va - 0.25 * vb)) / Math.sqrt(va * vb);
  }

  it('leaves independent assets uncorrelated', () => {
    expect(Math.abs(impliedCorrelation({ kind: 'independent' }))).toBeLessThan(0.03);
  });

  it('induces what the equicorrelated shorthand asks for', () => {
    // Correlating the Brownian increments at rho does not correlate the prices
    // at rho: the exponential pulls it toward zero by a factor closed form
    // gives exactly, and 0.25 vol over a year is a 0.5% pull.
    const rho = 0.8;
    const sigma = 0.25;
    const expected =
      (Math.exp(rho * sigma * sigma) - 1) / (Math.exp(sigma * sigma) - 1);
    expect(impliedCorrelation({ kind: 'equicorrelated', rho })).toBeCloseTo(expected, 1);
  });

  it('takes an explicit matrix', () => {
    const rho = -0.5;
    const sigma = 0.25;
    const expected =
      (Math.exp(rho * sigma * sigma) - 1) / (Math.exp(sigma * sigma) - 1);
    expect(
      impliedCorrelation({ kind: 'matrix', values: [1, rho, rho, 1] }),
    ).toBeCloseTo(expected, 1);
  });
});

describe('what it refuses', () => {
  // The failure an analyst actually causes: correlations assembled pairwise
  // until they describe no joint distribution at all.
  it('refuses a correlation matrix that is not positive definite', () => {
    const three = [asset({ id: 'a' }), asset({ id: 'b' }), asset({ id: 'c' })];
    expect(() =>
      runMonteCarlo(
        wasm,
        spec({
          assets: three,
          correlation: { kind: 'equicorrelated', rho: -0.9 },
          paths: 100,
          steps: 8,
        }),
      ),
    ).toThrow(CorrelationRejected);
  });

  it('refuses a matrix of the wrong size before it reaches the engine', () => {
    expect(() =>
      runMonteCarlo(
        wasm,
        spec({
          assets: [asset({ id: 'a' }), asset({ id: 'b' })],
          correlation: { kind: 'matrix', values: [1, 0, 0] },
          paths: 100,
          steps: 8,
        }),
      ),
    ).toThrow(CorrelationRejected);
  });

  it('refuses an asymmetric matrix', () => {
    expect(() =>
      runMonteCarlo(
        wasm,
        spec({
          assets: [asset({ id: 'a' }), asset({ id: 'b' })],
          correlation: { kind: 'matrix', values: [1, 0.3, 0.9, 1] },
          paths: 100,
          steps: 8,
        }),
      ),
    ).toThrow(CorrelationRejected);
  });

  it('refuses an empty simulation rather than returning an empty answer', () => {
    expect(() => runMonteCarlo(wasm, spec({ assets: [] }))).toThrow(EmptySimulation);
    expect(() => runMonteCarlo(wasm, spec({ paths: 0 }))).toThrow(EmptySimulation);
    expect(() => runMonteCarlo(wasm, spec({ steps: 0 }))).toThrow(EmptySimulation);
  });

  // The PRD puts 100k x 252 x 40 on a cluster; single-core native it is 30
  // seconds. A browser asking for it is asking for a frozen tab, and a preview
  // that hangs is worse than no preview.
  it('refuses a run past the cost ceiling, and says what it would have cost', () => {
    const assets = Array.from({ length: 40 }, (_, i) => asset({ id: `a${i}` }));
    const prd = spec({ assets, paths: 100_000, steps: 252 });
    expect(estimateCost(prd)).toBe(100_000 * 252 * 40);
    expect(estimateCost(prd)).toBeGreaterThan(DEFAULT_COST_CEILING);

    let thrown: unknown;
    try {
      runMonteCarlo(wasm, prd);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SimulationTooLarge);
    expect((thrown as SimulationTooLarge).assetSteps).toBe(1_008_000_000);
    expect((thrown as Error).message).toMatch(/cluster/);
  });

  it('lets a caller raise the ceiling deliberately', () => {
    const assets = Array.from({ length: 4 }, (_, i) => asset({ id: `a${i}` }));
    const result = runMonteCarlo(
      wasm,
      spec({ assets, paths: 2_000, steps: 32, maxAssetSteps: 1_000_000 }),
    );
    expect(result.assets).toBe(4);
  });
});

describe('the same seed gives the same answer', () => {
  it('reproduces a run exactly', () => {
    const a = runMonteCarlo(wasm, spec({ paths: 2_000 }));
    const b = runMonteCarlo(wasm, spec({ paths: 2_000 }));
    expect(a.moments).toEqual(b.moments);
    expect(a.percentiles).toEqual(b.percentiles);
    expect(a.sample).toEqual(b.sample);
  });

  it('a different seed gives a different one', () => {
    const a = runMonteCarlo(wasm, spec({ paths: 2_000, seed: 1 }));
    const b = runMonteCarlo(wasm, spec({ paths: 2_000, seed: 2 }));
    expect(a.moments.mean).not.toBe(b.moments.mean);
  });
});

// ---------------------------------------------------------------------------
// Processes beyond GBM (PRD 5.8's list), and the one that is refused.
// ---------------------------------------------------------------------------

describe('a calibrated Heston can drive the simulation', () => {
  // The composition PRD 5.8 implies and nothing exercised until the boundary
  // widened: fit the surface, then simulate under what the fit produced.
  const heston = {
    id: 'nvda',
    process: 'heston' as const,
    spot: 100,
    weight: 1,
    rate: 0.03,
    dividend: 0.01,
    v0: 0.042,
    theta: 0.058,
    kappa: 1.8,
    sigma: 0.55,
    rho: -0.68,
  };

  it('produces a fatter left tail than the GBM at the same starting vol', () => {
    const common = { correlation: { kind: 'independent' as const }, time: 1, paths: 40_000, steps: 64, seed: 0xc0ffee };
    const stochastic = runMonteCarlo(wasm, { ...common, assets: [heston] });
    const flat = runMonteCarlo(wasm, {
      ...common,
      assets: [asset({ id: 'nvda', spot: 100, vol: Math.sqrt(heston.v0), rate: 0.03, dividend: 0.01 })],
    });

    // A negative rho makes a down move raise volatility, which is the whole
    // reason to simulate Heston rather than GBM: the 1% quantile is lower.
    expect(stochastic.percentiles['0.01']).toBeLessThan(flat.percentiles['0.01'] as number);
    expect(stochastic.cvar['0.01']).toBeLessThan(flat.cvar['0.01'] as number);
    // And the means stay close — the skew moves the tails, not the forward.
    expect(stochastic.moments.mean).toBeCloseTo(flat.moments.mean, 0);
  });

  it('correlates across assets through the spot shocks', () => {
    const pair = (rho: number) => {
      const run = (wa: number, wb: number) =>
        runMonteCarlo(wasm, {
          assets: [
            { ...heston, id: 'a', weight: wa },
            { ...heston, id: 'b', weight: wb },
          ],
          correlation: { kind: 'equicorrelated', rho },
          time: 1,
          paths: 20_000,
          steps: 48,
          antithetic: false,
          seed: 0xc0ffee,
        }).moments.variance;
      const va = run(1, 0);
      const vb = run(0, 1);
      const vp = run(0.5, 0.5);
      return (2 * (vp - 0.25 * va - 0.25 * vb)) / Math.sqrt(va * vb);
    };

    expect(Math.abs(pair(0))).toBeLessThan(0.05);
    // Below the requested 0.8 because each asset carries its own independent
    // variance shock, which dilutes the terminal correlation. That is the
    // model, not a defect, so the assertion is on substance rather than target.
    expect(pair(0.8)).toBeGreaterThan(0.55);
    // Six Heston runs of twenty thousand paths, which is seconds through WASM.
  }, 60_000);
});

describe('Merton jumps', () => {
  it('fattens both tails relative to its own diffusion', () => {
    const common = { correlation: { kind: 'independent' as const }, time: 1, paths: 40_000, steps: 128, seed: 0xb0b };
    const jumpy = runMonteCarlo(wasm, {
      ...common,
      assets: [{
        id: 'x', process: 'merton' as const, spot: 100, weight: 1, rate: 0.03, dividend: 0,
        vol: 0.22, intensity: 1.5, jumpMean: -0.08, jumpVol: 0.15,
      }],
    });
    const smooth = runMonteCarlo(wasm, {
      ...common,
      assets: [asset({ id: 'x', spot: 100, vol: 0.22, rate: 0.03, dividend: 0 })],
    });

    expect(jumpy.moments.excessKurtosis).toBeGreaterThan(smooth.moments.excessKurtosis);
    // Downward-mean jumps push the left tail out further than the diffusion.
    expect(jumpy.percentiles['0.01']).toBeLessThan(smooth.percentiles['0.01'] as number);
  });
});

describe('t-copula dependence (PRD 5.8, and 6.2\'s semis cluster)', () => {
  const pair = (dependence?: McSpec['dependence']) =>
    runMonteCarlo(wasm, spec({
      assets: [asset({ id: 'a', vol: 0.3 }), asset({ id: 'b', vol: 0.3 })],
      correlation: { kind: 'equicorrelated', rho: 0.7 },
      paths: 100_000,
      steps: 64,
      cvarLevels: [0.01, 0.002],
      ...(dependence ? { dependence } : {}),
    }));

  it('deepens the joint left tail without moving the middle', () => {
    const g = pair();
    const t = pair({ kind: 't', nu: 4 });
    expect(g.dependence).toEqual({ kind: 'gaussian' });
    expect(t.dependence).toEqual({ kind: 't', nu: 4 });
    // Measured through WASM. The crate's independent one-step references for
    // the same pair are 95.00 Gaussian and 92.93 t at 1%.
    expect(g.cvar['0.01']).toBeCloseTo(95.57, 2);
    expect(t.cvar['0.01']).toBeCloseTo(92.98, 2);
    // At 0.2%, 83.3 against 79.0: the corner the walkthrough asks about.
    expect(g.cvar['0.002']! - t.cvar['0.002']!).toBeGreaterThan(4);
    // Same marginals, same correlation parameter: the median barely moves.
    expect(Math.abs(g.percentiles['0.5']! - t.percentiles['0.5']!)).toBeLessThan(0.5);
  });

  it('is Gaussian when asked for explicitly, bit for bit', () => {
    expect(pair({ kind: 'gaussian' }).terminal()).toEqual(pair().terminal());
  });

  it('refuses degrees of freedom that are not positive and finite', () => {
    expect(() => pair({ kind: 't', nu: 0 })).toThrow(DependenceRejected);
    expect(() => pair({ kind: 't', nu: Number.NaN })).toThrow(DependenceRejected);
  });
});

describe('the joint historical bootstrap (PRD 5.8)', () => {
  // 400 dates of two correlated daily returns, from a seeded generator.
  const history: number[][] = (() => {
    let seed = 17;
    const uniform = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 0.5) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    return Array.from({ length: 400 }, () => {
      const common = normal();
      return [0.0003 + 0.012 * (0.8 * common + 0.6 * normal()), 0.0001 + 0.015 * (0.8 * common + 0.6 * normal())];
    });
  })();

  const resample = (overrides: Partial<ResampleSpec> = {}) =>
    runResampled(wasm, {
      assets: [{ id: 'a', spot: 100, weight: 1 }, { id: 'b', spot: 100, weight: 0 }],
      history,
      meanBlock: 1,
      paths: 40_000,
      steps: 20,
      seed: 0xb007,
      ...overrides,
    });

  it('has the closed-form mean when the draws are iid', () => {
    const r = resample();
    const growth = history.reduce((acc, row) => acc + Math.exp(row[0]!), 0) / history.length;
    expect(Math.abs(r.moments.mean - 100 * growth ** 20)).toBeLessThan(3 * r.moments.standardError);
    expect(r.dependence).toEqual({ kind: 'replayed', meanBlock: 1, observations: 400 });
  });

  it('keeps each date together, and loses the dependence when one column is shuffled', () => {
    const correlation = (h: number[][]) => {
      const v = (wa: number, wb: number) =>
        resample({ history: h, assets: [{ id: 'a', spot: 100, weight: wa }, { id: 'b', spot: 100, weight: wb }] }).moments.variance;
      const [va, vb, vp] = [v(1, 0), v(0, 1), v(0.5, 0.5)];
      return (2 * (vp - 0.25 * va - 0.25 * vb)) / Math.sqrt(va * vb);
    };
    const joint = correlation(history);
    const shuffled = history.map((row, i) => [row[0]!, history[(i * 211) % history.length]![1]!]);
    const broken = correlation(shuffled);
    // Measured: 0.67 joint, against 0.02 once the dates are pulled apart.
    expect(joint).toBeCloseTo(0.666, 2);
    expect(Math.abs(broken)).toBeLessThan(0.05);
  });

  it('refuses a history it cannot line up', () => {
    expect(() => resample({ history: [] })).toThrow(HistoryRejected);
    expect(() => resample({ history: [[0.01, 0.02], [0.01]] })).toThrow(/date 1 has 1 returns for 2 assets/);
    expect(() => resample({ history: [[0.01, Number.NaN]] })).toThrow(HistoryRejected);
  });

  it('shares the one result slot with the parametric runs, and says so', () => {
    const replayed = resample({ paths: 1_000 });
    runMonteCarlo(wasm, spec());
    expect(() => replayed.terminal()).toThrow(ResultSuperseded);
  });
});

describe('a GBM asset fitted to history (PRD 5.8 calibration)', () => {
  // Seeded closes: zero-drift daily log returns at an annual vol of 30%.
  function closes(n: number, seed: number, draw: (u: () => number) => number): number[] {
    let state = seed >>> 0;
    const uniform = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state + 0.5) / 4294967296;
    };
    const out = [100];
    for (let i = 0; i < n; i++) out.push(out[i]! * Math.exp(draw(uniform)));
    return out;
  }
  const DAILY = 0.3 / Math.sqrt(252);
  const normal = (u: () => number) => DAILY * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  // Student-t with `nu` degrees of freedom, scaled to the same daily variance.
  const student = (nu: number) => (u: () => number) => {
    const z = Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    let chi = 0;
    for (let k = 0; k < nu; k++) {
      const g = Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
      chi += g * g;
    }
    return (DAILY * (z / Math.sqrt(chi / nu))) / Math.sqrt(nu / (nu - 2));
  };

  it('fits the window it was given, priced risk-neutral', () => {
    const series = closes(500, 1, normal);
    const fit = gbmFromHistory(wasm, { id: 'X', closes: series, weight: 1, rate: 0.04, dividend: 0, window: 60 });
    expect(fit.observations).toBe(60);
    expect(fit.asset.spot).toBe(series[series.length - 1]);
    expect(fit.asset.rate).toBe(0.04);
    expect(fit.warnings).toEqual([]);
    expect(Math.abs(fit.asset.vol - 0.3)).toBeLessThan(3 * fit.volStandardError);
    // It drives a run like any hand-set asset.
    const run = runMonteCarlo(wasm, spec({ assets: [fit.asset] }));
    expect(run.paths).toBe(8_000);
  });

  it('carries a standard error from the window, not from an assumption of normal returns', () => {
    // How often the implied 95% interval contains the true 30%, over 400
    // sixty-day windows; and the same for the textbook vol / sqrt(2n).
    const coverage = (draw: (u: () => number) => number) => {
      let fourth = 0;
      let textbook = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const fit = gbmFromHistory(wasm, { id: 'X', closes: closes(60, seed * 7919, draw), weight: 1, rate: 0, dividend: 0 });
        const miss = Math.abs(fit.asset.vol - 0.3);
        if (miss < 1.96 * fit.volStandardError) fourth++;
        if (miss < (1.96 * fit.asset.vol) / Math.sqrt(2 * fit.observations)) textbook++;
      }
      return { fourth: fourth / 400, textbook: textbook / 400 };
    };
    // Normal returns: both are right.
    expect(coverage(normal)).toEqual({ fourth: 0.9525, textbook: 0.965 });
    // Fat tails: the textbook interval collapses; the fourth-moment one holds
    // up better and still falls short, because sixty returns rarely contain
    // the tail that sets the true fourth moment. Better, not solved.
    expect(coverage(student(6))).toEqual({ fourth: 0.885, textbook: 0.825 });
    expect(coverage(student(4))).toEqual({ fourth: 0.7875, textbook: 0.63 });
  });

  it('warns on a short window and refuses to invent a vol from nothing', () => {
    const short = gbmFromHistory(wasm, { id: 'X', closes: closes(10, 3, normal), weight: 1, rate: 0, dividend: 0 });
    expect(short.warnings[0]).toMatch(/10 returns/);
    const none = gbmFromHistory(wasm, { id: 'X', closes: [100], weight: 1, rate: 0, dividend: 0 });
    expect(Number.isNaN(none.asset.vol)).toBe(true);
    expect(none.warnings[0]).toMatch(/fewer than two positive closes/);
  });
});
