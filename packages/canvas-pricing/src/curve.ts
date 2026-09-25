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
 * An arbitrary shape: tenor-point deltas, as the pen-drawn curve arrives
 * (PRD 5.3).
 *
 * The engine interpolates between the points in log tenor and holds the end
 * values flat beyond them. Flat is the right default for a shock somebody
 * typed out to 30y and asked about at 40y, and the wrong one for a stroke that
 * stopped at 12y: the analyst left the long end alone, and flat extrapolation
 * would move it by whatever they drew at 10y. So the points given here are
 * applied exactly as given, and a caller converting a drawing is expected to
 * say where the drawing stopped — `canvas-ink`'s `engineShockPoints` does.
 */
export interface DrawnShock {
  shape: 'custom';
  /** Strictly increasing in tenor. */
  points: ReadonlyArray<{ tenor: number; bps: number }>;
}

export type AnyCurveShock = CurveShock | DrawnShock;

/**
 * A built curve, readable at any tenor.
 *
 * Reads go straight back into WASM rather than caching a sampled copy here: the
 * curve between pins is piecewise-constant forwards, and a JavaScript
 * re-interpolation of sampled points would quietly be a different curve.
 *
 * The module holds one curve at a time, but a `Curve` behaves like a value
 * anyway: it remembers how it was built, and rebuilds itself if something else
 * has taken the slot since. Without that, holding a base curve and a shocked
 * one — which is exactly what a scenario does — would silently give two handles
 * onto the same numbers, and every rate difference would come out zero.
 *
 * The rebuild costs a bootstrap, so alternating reads between two curves is
 * slower than reading each in turn. Correct either way, which is the part worth
 * paying for.
 */
export class Curve {
  constructor(
    private readonly engine: CurveEngine,
    readonly pins: number,
    readonly instruments: readonly Instrument[],
    readonly shock?: AnyCurveShock,
  ) {}

  /** Puts this curve back in the module's slot if something displaced it. */
  private live(): PricingExports {
    this.engine.makeLive(this);
    return this.engine.exports;
  }

  /** Continuously compounded zero rate. */
  zero(t: number): number {
    return this.live().pc_curve_zero(t);
  }

  discount(t: number): number {
    return this.live().pc_curve_discount(t);
  }

  forward(t1: number, t2: number): number {
    return this.live().pc_curve_forward(t1, t2);
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
    const w = this.live();
    return this.instruments.map((_, i) => w.pc_curve_residual(i));
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
  /** Which curve currently occupies the module's single slot. */
  private current: Curve | undefined;

  constructor(readonly exports: PricingExports) {}

  /**
   * Rebuilds `curve` into the module's slot unless it is already there.
   *
   * Identity, not equality: two curves built from the same quotes are still two
   * objects, and re-installing one of them is cheap enough not to be worth
   * comparing instrument lists to avoid.
   */
  makeLive(curve: Curve): void {
    if (this.current === curve) return;
    this.install(curve.instruments, curve.shock);
    this.current = curve;
  }

  /** Builds into the module slot without wrapping the result. */
  private install(instruments: readonly Instrument[], shock?: AnyCurveShock): number {
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
    if (!shock) return pins;
    if (shock.shape === 'custom') {
      w.pc_curve_shock_reset();
      for (const point of shock.points) w.pc_curve_shock_point(point.tenor, point.bps);
      const shocked = w.pc_curve_shock_custom();
      if (shocked === -2) {
        throw new Error('a drawn shock needs at least one point, in strictly increasing tenor');
      }
      if (shocked < 0) throw new Error('no curve to shock');
      return shocked;
    }
    const shocked = w.pc_curve_shock(SHAPE_CODE[shock.shape], shock.bps, shock.pivot ?? 0);
    if (shocked < 0) throw new Error('no curve to shock');
    return shocked;
  }

  /** Bootstraps a curve that reprices every instrument to par. */
  bootstrap(instruments: readonly Instrument[]): Curve {
    if (instruments.length === 0) {
      throw new Error('cannot bootstrap from no instruments: a curve needs at least one quote');
    }
    const pins = this.install(instruments);
    const curve = new Curve(this, pins, [...instruments]);
    this.current = curve;
    return curve;
  }

  /**
   * Rebuilds and shocks in one step.
   *
   * Rebuilt rather than shocked in place, because shocking twice would compound:
   * a caller asking for +50bp twice means two scenarios, not +100bp.
   */
  shocked(instruments: readonly Instrument[], shock: AnyCurveShock): Curve {
    const pins = this.install(instruments, shock);
    const curve = new Curve(this, pins, [...instruments], shock);
    this.current = curve;
    return curve;
  }

  /**
   * Turns a fit into a curve that can be shocked and discounted against.
   *
   * Pinned at the tenors that were observed, because a fit is a shape and the
   * honest place to pin it is where there were quotes. Must follow the `fitNss`
   * call it belongs to — the module holds one fit at a time.
   */
  curveFromFit(): Curve {
    const pins = this.exports.pc_nss_install_curve();
    if (pins < 0) throw new Error('no fit to install — call fitNss first');
    // Built from a fit rather than from quotes, so it has no instruments to
    // rebuild itself from. Reading it after something else takes the slot is a
    // caller error the engine cannot repair, so it holds the slot until then.
    const curve = new Curve(this, pins, []);
    this.current = curve;
    return curve;
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
