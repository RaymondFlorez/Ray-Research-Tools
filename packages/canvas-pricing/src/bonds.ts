/**
 * Bond analytics on the canvas (PRD 5.3).
 *
 * Two kinds of number here, and the split is the point. *Yield* metrics compress
 * a bond to one figure and describe it in that figure's terms — conventional,
 * and blind to the curve's shape, so a steepener moves the yield with nothing
 * about the bond having changed. *Spread* metrics keep the curve and ask what
 * has to be added to it, which is the question a relative-value analyst is
 * actually asking.
 *
 * For a callable even the spread question is malformed: part of the price is a
 * short option, and a z-spread charges the whole discount to credit. `oas`
 * prices the option on a Hull-White lattice and reports what is left.
 */

import type { Curve, CurveEngine } from './curve.js';
import type { PricingExports } from './module.js';

/** `(time in years, amount)`, in the bond's own units. */
export type CashFlow = readonly [number, number];

export interface YieldMetrics {
  yieldToMaturity: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Currency per basis point, in the flows' units. */
  dv01: number;
}

/** A bond the lattice can price: level coupon, aligned to the lattice's slices. */
export interface LatticeBond {
  /** Paid at every slice after the first. */
  coupon: number;
  redemption: number;
  slices: number;
  /** Slice from which the issuer may redeem. Omit for a straight bond. */
  callFrom?: number;
  callPrice?: number;
}

export interface HullWhiteModel {
  meanReversion: number;
  /** Absolute short-rate volatility, in decimals. */
  vol: number;
}

export class BondAnalytics {
  constructor(
    readonly exports: PricingExports,
    private readonly curves: CurveEngine,
  ) {}

  private load(flows: readonly CashFlow[]): void {
    this.exports.pc_bond_reset();
    for (const [time, amount] of flows) this.exports.pc_bond_add_flow(time, amount);
  }

  /** Price for a given yield, compounded `frequency` times a year. */
  priceAtYield(flows: readonly CashFlow[], y: number, frequency = 2): number {
    this.load(flows);
    return this.exports.pc_bond_price_at_yield(y, frequency);
  }

  /**
   * Yield, duration and convexity, all from one solve.
   *
   * `undefined` when no yield reproduces the price — which happens for a cash
   * flow stream that is not a bond, and is worth reporting rather than
   * approximating.
   */
  yieldMetrics(
    flows: readonly CashFlow[],
    price: number,
    frequency = 2,
  ): YieldMetrics | undefined {
    this.load(flows);
    const w = this.exports;
    const metrics = {
      yieldToMaturity: w.pc_bond_metric(0, price, frequency),
      macaulayDuration: w.pc_bond_metric(1, price, frequency),
      modifiedDuration: w.pc_bond_metric(2, price, frequency),
      convexity: w.pc_bond_metric(3, price, frequency),
      dv01: w.pc_bond_metric(4, price, frequency),
    };
    return Number.isNaN(metrics.yieldToMaturity) ? undefined : metrics;
  }

  /**
   * The constant spread over the curve that reproduces a price.
   *
   * Unlike a yield, this keeps the curve's shape — so the cheapness it reports
   * survives a steepener.
   */
  zSpread(flows: readonly CashFlow[], curve: Curve, price: number): number | undefined {
    this.curves.makeLive(curve);
    this.load(flows);
    const z = this.exports.pc_bond_z_spread(price);
    return Number.isNaN(z) ? undefined : z;
  }

  /**
   * Par-par asset swap spread, as a rate on `notional`.
   *
   * The notional is explicit because the annuity is per unit of it and the
   * price is in the flows' own units; assuming 100 would be right for a bond
   * quoted per hundred and a factor of a hundred wrong for anything else.
   */
  assetSwapSpread(
    flows: readonly CashFlow[],
    curve: Curve,
    price: number,
    frequency = 2,
    notional = 100,
  ): number | undefined {
    this.curves.makeLive(curve);
    this.load(flows);
    const asw = this.exports.pc_bond_asset_swap(price, frequency, notional);
    return Number.isNaN(asw) ? undefined : asw;
  }

  /**
   * Calibrates a Hull-White lattice to a curve.
   *
   * `dt` should divide the bond's coupon dates: a flow landing between slices
   * would be discounted from the wrong place.
   */
  lattice(curve: Curve, model: HullWhiteModel, dt: number, steps: number): Lattice {
    this.curves.makeLive(curve);
    const built = this.exports.pc_hw_calibrate(model.meanReversion, model.vol, dt, steps);
    if (built < 0) throw new Error('no curve to calibrate to');
    return new Lattice(this.exports, built, dt);
  }
}

/** A calibrated short-rate tree. */
export class Lattice {
  constructor(
    private readonly exports: PricingExports,
    readonly steps: number,
    readonly dt: number,
  ) {}

  /**
   * The tree's own zero-coupon bond to a slice.
   *
   * Should equal the curve it was fitted to — that is the calibration
   * condition, and it is readable so a node can show it rather than assert it.
   */
  zeroCoupon(step: number): number {
    return this.exports.pc_hw_zero_coupon(step);
  }

  price(bond: LatticeBond, spread: number): number {
    return this.exports.pc_hw_bond_price(...args(bond), spread);
  }

  /**
   * The spread that makes the lattice reproduce a market price.
   *
   * For a bond with no call schedule this is the z-spread, reached by a
   * completely different route — a backward induction on a fitted tree rather
   * than a discounted sum. That they agree is the check on both.
   */
  optionAdjustedSpread(bond: LatticeBond, price: number): number | undefined {
    const oas = this.exports.pc_hw_oas(...args(bond), price);
    return Number.isNaN(oas) ? undefined : oas;
  }

  /** What the embedded call is worth, in price terms. */
  optionValue(bond: LatticeBond, spread: number): number {
    return this.exports.pc_hw_option_value(...args(bond), spread);
  }
}

/** The lattice ABI is positional; `callFrom < 0` means no call. */
function args(bond: LatticeBond): [number, number, number, number, number] {
  return [
    bond.coupon,
    bond.redemption,
    bond.slices,
    bond.callFrom ?? -1,
    bond.callPrice ?? 0,
  ];
}
