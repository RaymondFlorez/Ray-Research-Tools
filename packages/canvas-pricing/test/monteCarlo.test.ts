import { beforeAll, describe, expect, it } from 'vitest';
import {
  CorrelationRejected,
  DEFAULT_COST_CEILING,
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
