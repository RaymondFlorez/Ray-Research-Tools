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
