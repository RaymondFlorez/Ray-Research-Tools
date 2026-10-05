/**
 * The cost model (PRD 5.8).
 *
 * "Commissions, spread (from historical quoted spread where available, modeled
 * where not), market impact (square-root law with a calibrated coefficient),
 * borrow cost for shorts, and financing."
 *
 * Every one of these is a reason a backtest beats live trading, and the
 * square-root impact term is the one that separates a strategy that scales from
 * one that only works on paper — cost per share rises with the square root of
 * participation, so ten times the size costs about three times as much per
 * share and thirty times in total.
 */

export interface CostModel {
  /** Per share, in currency. */
  commissionPerShare: number;
  /** Minimum ticket charge. */
  commissionMinimum: number;
  /** Fraction of the quoted spread paid on a marketable order. Half is fair. */
  spreadCapture: number;
  /**
   * Square-root impact coefficient, in units of daily volatility.
   *
   * Impact = coefficient x volatility x sqrt(shares / daily volume). Around 1 is
   * the usual calibration; the point of exposing it is that the analyst can see
   * what their result depends on.
   */
  impactCoefficient: number;
  /** Annual borrow rate on short positions. */
  borrowRate: number;
  /** Annual financing rate on gross leverage above one. */
  financingRate: number;
}

export const DEFAULT_COSTS: CostModel = {
  commissionPerShare: 0.005,
  commissionMinimum: 1,
  spreadCapture: 0.5,
  impactCoefficient: 1,
  borrowRate: 0.03,
  financingRate: 0.055,
};

export interface FillContext {
  shares: number;
  price: number;
  /** Quoted spread as a fraction of price. Modeled when not observed. */
  spread: number;
  /** Average daily volume in shares, for the impact term. */
  dailyVolume: number;
  /** Daily return volatility, for the impact term. */
  volatility: number;
}

export interface FillCost {
  commission: number;
  spread: number;
  impact: number;
  total: number;
  /** The price actually paid, including everything but commission. */
  effectivePrice: number;
}

/** What one trade costs, and what it therefore fills at. */
export function fillCost(context: FillContext, model: CostModel = DEFAULT_COSTS): FillCost {
  const shares = Math.abs(context.shares);
  if (shares === 0) {
    return { commission: 0, spread: 0, impact: 0, total: 0, effectivePrice: context.price };
  }

  const commission = Math.max(model.commissionMinimum, shares * model.commissionPerShare);
  const spread = shares * context.price * context.spread * model.spreadCapture;

  // Square-root law. Participation above 100% of a day's volume is not a trade
  // anyone fills in a day, and the model says so by continuing to grow rather
  // than flattering the strategy with a cap.
  const participation = context.dailyVolume > 0 ? shares / context.dailyVolume : 1;
  const impact =
    shares * context.price * model.impactCoefficient * context.volatility * Math.sqrt(participation);

  const total = commission + spread + impact;
  const direction = Math.sign(context.shares);
  return {
    commission,
    spread,
    impact,
    total,
    // A buy pays up and a sell receives less; the sign carries that.
    effectivePrice: context.price + (direction * (spread + impact)) / shares,
  };
}

/** Overnight carry: borrow on shorts, financing on leverage above one. */
export function carryCost(
  positions: ReadonlyMap<string, { shares: number; price: number }>,
  equity: number,
  model: CostModel = DEFAULT_COSTS,
  days = 1,
): number {
  let short = 0;
  let gross = 0;
  for (const { shares, price } of positions.values()) {
    const value = shares * price;
    gross += Math.abs(value);
    if (value < 0) short += -value;
  }
  const borrow = (short * model.borrowRate * days) / 365;
  const leveraged = Math.max(0, gross - Math.max(equity, 0));
  const financing = (leveraged * model.financingRate * days) / 365;
  return borrow + financing;
}

export interface ImpactObservation {
  /** Shares executed, unsigned. */
  shares: number;
  dailyVolume: number;
  /** Daily return volatility at the time. */
  volatility: number;
  /**
   * Measured impact as a fraction of the arrival price: the adverse move
   * beyond half the quoted spread, signed so that paying up is positive.
   */
  impact: number;
}

export interface ImpactCalibration {
  coefficient: number;
  standardError: number;
  observations: number;
  warnings: string[];
}

/** Below this many executions the coefficient is reported with a warning. */
export const MIN_IMPACT_OBSERVATIONS = 30;

/**
 * Fits the square-root law's coefficient to executions: "market impact
 * (square-root law with a calibrated coefficient)".
 *
 * The law is `impact = k * volatility * sqrt(shares / dailyVolume)` with no
 * intercept — no trade, no impact — so `k` is least squares through the
 * origin on `x = volatility * sqrt(participation)`.
 *
 * The standard error is White's (HC1), not the textbook `s^2 / sum(x^2)`.
 * Impact noise grows with the trade — a fill at 10% of volume is noisier than
 * one at 0.01% — and under that noise the textbook interval covered the true
 * coefficient 64% of the time at a nominal 95% (measured in
 * `test/costs.test.ts`). Calibrating needs the analyst's own fills;
 * nothing here supplies them, and `DEFAULT_COSTS` keeps a coefficient of 1
 * until someone does.
 */
export function calibrateImpact(observations: readonly ImpactObservation[]): ImpactCalibration {
  const warnings: string[] = [];
  const usable = observations.filter(
    (o) => o.shares > 0 && o.dailyVolume > 0 && o.volatility > 0 && Number.isFinite(o.impact),
  );
  if (usable.length < observations.length) {
    warnings.push(`${observations.length - usable.length} executions dropped: zero size, volume or volatility, or a non-finite impact.`);
  }
  if (usable.length < 2) {
    return { coefficient: Number.NaN, standardError: Number.NaN, observations: usable.length, warnings: [...warnings, 'fewer than two usable executions'] };
  }
  const xs = usable.map((o) => o.volatility * Math.sqrt(o.shares / o.dailyVolume));
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const sxy = usable.reduce((a, o, i) => a + xs[i]! * o.impact, 0);
  const coefficient = sxy / sxx;
  const n = usable.length;
  const meat = usable.reduce((a, o, i) => a + (xs[i]! * (o.impact - coefficient * xs[i]!)) ** 2, 0);
  const standardError = Math.sqrt((n / (n - 1)) * meat) / sxx;
  if (usable.length < MIN_IMPACT_OBSERVATIONS) {
    warnings.push(`${usable.length} executions; the coefficient is fitted but not yet worth trusting.`);
  }
  if (coefficient <= 0) {
    warnings.push('a non-positive coefficient says these fills improved with size, which the square-root law cannot express.');
  }
  return { coefficient, standardError, observations: usable.length, warnings };
}
