/**
 * Yield curves on the canvas (PRD 5.3).
 *
 * A `CurveNode` gets its curve one of two ways, and they are different kinds of
 * object. A bootstrap *reproduces* its inputs — every instrument it was built
 * from reprices to par off it — and `residuals` is how a node proves that
 * rather than asserting it. A Nelson-Siegel-Svensson fit *approximates* its
 * inputs, and the residuals are the point: six parameters through thirty bonds
 * will miss, and a chart that hides by how much is what the PRD calls a smooth
 * lie.
 *
 * Both run in the Rust core, not here — a curve feeds prices, and PRD 7.1 wants
 * the client's number and the server's to agree bit for bit.
 */

import { readUtf8, type PricingExports } from './module.js';

/** Instruments a curve is bootstrapped from. */
export type Instrument =
  | { kind: 'deposit'; maturity: number; rate: number }
  | {
      kind: 'future';
      start: number;
      end: number;
      rate: number;
      /** Subtracted from the quote. A futures rate sits above the forward one. */
      convexityBps?: number;
    }
  | { kind: 'swap'; maturity: number; rate: number; frequency?: number };

/** The key-rate buckets the engine works in, in years. */
export const STANDARD_TENORS = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30] as const;

export type ShockShape = 'parallel' | 'steepener' | 'flattener' | 'butterfly';

const SHAPE_CODE: Record<ShockShape, number> = {
  parallel: 0,
  steepener: 1,
  flattener: 2,
  butterfly: 3,
};

export interface CurveShock {
  shape: ShockShape;
  bps: number;
  /** The rotation point, or the belly of a butterfly. Ignored by `parallel`. */
  pivot?: number;
}

/**
 * A built curve, readable at any tenor.
 *
 * Reads go straight back into WASM rather than caching a sampled copy here: the
 * curve between pins is piecewise-constant forwards, and a JavaScript
 * re-interpolation of sampled points would quietly be a different curve.
 */
export class Curve {
  constructor(
    private readonly exports: PricingExports,
    readonly pins: number,
    readonly instruments: readonly Instrument[],
    readonly shock?: CurveShock,
  ) {}

  /** Continuously compounded zero rate. */
  zero(t: number): number {
    return this.exports.pc_curve_zero(t);
  }

  discount(t: number): number {
    return this.exports.pc_curve_discount(t);
  }

  forward(t1: number, t2: number): number {
    return this.exports.pc_curve_forward(t1, t2);
  }

  /** Zero rates at the standard buckets, as a curve chart plots them. */
  tenorRates(): Array<{ tenor: number; rate: number }> {
    return STANDARD_TENORS.map((tenor) => ({ tenor, rate: this.zero(tenor) }));
  }

  /**
   * How far the curve is from repricing each instrument it was built from.
   *
   * A bootstrap should leave these at the noise floor. A `CurveNode` shows them
   * because "this curve reproduces the market" is a claim, and an analyst
   * should be able to check it rather than take it on trust.
   */
  residuals(): number[] {
    return this.instruments.map((_, i) => this.exports.pc_curve_residual(i));
  }

  /** The worst instrument residual, in basis points of par. */
  worstResidualBps(): number {
    return Math.max(...this.residuals().map((r) => Math.abs(r))) * 10_000;
  }
}

export interface NssFit {
  beta0: number;
  beta1: number;
  beta2: number;
  beta3: number;
  tau1: number;
  tau2: number;
  rmseBps: number;
  maxAbsBps: number;
  /** The tenor the fit misses by the most. */
  worstTenor: number;
  residuals: number[];
  /** Present when the fit is too loose to present as the curve. */
  warning?: string;
  /** The fitted rate at any tenor, including ones that were not observed. */
  zero(t: number): number;
}

/**
 * The curve engine, bound to one instantiated module.
 *
 * Stateful, because the module is: building a curve replaces the one before it.
 * One builder per module, and a caller that needs two curves at once reads the
 * first before building the second.
 */
export class CurveEngine {
  constructor(readonly exports: PricingExports) {}

  /** Bootstraps a curve that reprices every instrument to par. */
  bootstrap(instruments: readonly Instrument[]): Curve {
    if (instruments.length === 0) {
      throw new Error('cannot bootstrap from no instruments: a curve needs at least one quote');
    }
    const w = this.exports;
    w.pc_curve_reset();
    for (const instrument of instruments) {
      switch (instrument.kind) {
        case 'deposit':
          w.pc_curve_add_deposit(instrument.maturity, instrument.rate);
          break;
        case 'future':
          w.pc_curve_add_future(
            instrument.start,
            instrument.end,
            instrument.rate,
            instrument.convexityBps ?? 0,
          );
          break;
        case 'swap':
          w.pc_curve_add_swap(instrument.maturity, instrument.rate, instrument.frequency ?? 2);
          break;
      }
    }
    const pins = w.pc_curve_bootstrap();
    if (pins < 0) {
      throw new Error(
        'these instruments do not build a curve — check that maturities increase and rates are sane',
      );
    }
    return new Curve(w, pins, [...instruments]);
  }

  /**
   * Rebuilds and shocks in one step.
   *
   * Rebuilt rather than shocked in place, because the module holds one curve
   * and shocking twice would compound: a caller asking for +50bp twice means
   * two scenarios, not +100bp.
   */
  shocked(instruments: readonly Instrument[], shock: CurveShock): Curve {
    const base = this.bootstrap(instruments);
    const pins = this.exports.pc_curve_shock(
      SHAPE_CODE[shock.shape],
      shock.bps,
      shock.pivot ?? 0,
    );
    if (pins < 0) throw new Error('no curve to shock');
    return new Curve(this.exports, pins, base.instruments, shock);
  }

  /**
   * Fits Nelson-Siegel-Svensson to observed zero rates.
   *
   * Returns `undefined` only when the fit is refused outright — fewer
   * observations than parameters. A fit that simply misses comes back with a
   * `warning`, because that is information rather than a failure.
   */
  fitNss(observations: ReadonlyArray<{ tenor: number; rate: number }>): NssFit | undefined {
    const w = this.exports;
    w.pc_nss_reset();
    for (const { tenor, rate } of observations) w.pc_nss_observe(tenor, rate);

    const status = w.pc_nss_fit();
    if (status === 0) return undefined;

    const warning =
      status === -1 ? readUtf8(w.memory, w.pc_nss_warning_ptr(), w.pc_nss_warning_len()) : undefined;

    return {
      beta0: w.pc_nss_param(0),
      beta1: w.pc_nss_param(1),
      beta2: w.pc_nss_param(2),
      beta3: w.pc_nss_param(3),
      tau1: w.pc_nss_param(4),
      tau2: w.pc_nss_param(5),
      rmseBps: w.pc_nss_stat(0),
      maxAbsBps: w.pc_nss_stat(1),
      worstTenor: w.pc_nss_stat(2),
      residuals: observations.map((_, i) => w.pc_nss_residual(i)),
      ...(warning !== undefined ? { warning } : {}),
      zero: (t: number) => w.pc_nss_zero(t),
    };
  }
}
