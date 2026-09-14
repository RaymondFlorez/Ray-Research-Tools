/**
 * The event-driven backtest (PRD 5.8).
 *
 * "Event-driven, not vectorized, because vectorized backtests hide too many
 * sins."
 *
 * The sins in question are all versions of the same one: a vectorized backtest
 * computes signals over the whole history at once, so nothing stops a signal at
 * bar t from having been computed with data from bar t+1. Here the strategy is
 * called once per bar, with a view that cannot read past it, and the order it
 * places fills on the *next* bar. Look-ahead becomes something you have to
 * work at rather than something you have to remember not to do.
 */

import { carryCost, fillCost, DEFAULT_COSTS, type CostModel } from './costs.js';
import { AsOfView, type History } from './pointInTime.js';
import { maxDrawdown, sharpe, deflatedSharpe, type DeflatedSharpe, type Drawdown } from './statistics.js';

export interface Order {
  symbol: string;
  /** Target position in shares. Signed; negative is short. */
  targetShares: number;
}

/**
 * The strategy: given what was knowable on this bar, what should be held?
 *
 * Targets rather than trades, so the engine owns the arithmetic of getting
 * there and the strategy cannot accidentally double up.
 */
export type Strategy = (view: AsOfView, state: BacktestState) => Order[];

export interface BacktestState {
  date: string;
  cash: number;
  positions: ReadonlyMap<string, number>;
  equity: number;
}

export interface Trade {
  date: string;
  symbol: string;
  shares: number;
  price: number;
  cost: number;
}

export interface BacktestOptions {
  symbols: readonly string[];
  /** Key in the history holding each symbol's price, as `price:SYMBOL`. */
  initialCash?: number;
  costs?: CostModel;
  /** Average daily volume per symbol, for the impact term. */
  dailyVolume?: ReadonlyMap<string, number>;
  /** Quoted spread as a fraction of price, per symbol. */
  spread?: ReadonlyMap<string, number>;
  /**
   * How many strategies the analyst has tried on this canvas.
   *
   * "The trial counter is tracked automatically, which is uncomfortable and
   * correct." Passed in here because the canvas owns the count; the backtest
   * only has to refuse to ignore it.
   */
  trials?: number;
  periodsPerYear?: number;
}

export interface BacktestResult {
  dates: string[];
  /** Portfolio value at each bar. */
  equity: number[];
  /** Bar-over-bar returns. */
  returns: number[];
  trades: Trade[];
  /** Gross exposure over equity, per bar. */
  exposure: number[];
  totalCosts: number;
  sharpe: number;
  deflated: DeflatedSharpe;
  drawdown: Drawdown;
}

const VOL_WINDOW = 20;

/** Realised volatility from a price window, for the impact term. */
function volatilityOf(prices: readonly number[]): number {
  if (prices.length < 3) return 0.02;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const previous = prices[i - 1] as number;
    if (previous > 0) returns.push((prices[i] as number) / previous - 1);
  }
  if (returns.length < 2) return 0.02;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Runs the strategy bar by bar.
 *
 * Orders placed on bar `t` fill at bar `t+1`'s price. That one-bar delay is the
 * difference between a backtest and a wish: a strategy that decides on a
 * closing price cannot also trade at it.
 */
export function backtest(
  history: History,
  strategy: Strategy,
  options: BacktestOptions,
): BacktestResult {
  const costs = options.costs ?? DEFAULT_COSTS;
  const dates = history.dates();
  const positions = new Map<string, number>();
  let cash = options.initialCash ?? 1_000_000;

  const equity: number[] = [];
  const exposure: number[] = [];
  const trades: Trade[] = [];
  let totalCosts = 0;
  let pending: Order[] = [];

  for (let bar = 0; bar < dates.length; bar += 1) {
    const date = dates[bar] as string;
    const priceOf = (symbol: string) => history.actualAt(`price:${symbol}`, date);

    // 1. Fill what the previous bar decided, at this bar's price.
    for (const order of pending) {
      const price = priceOf(order.symbol);
      if (price === undefined || price <= 0) continue;
      const held = positions.get(order.symbol) ?? 0;
      const delta = order.targetShares - held;
      if (delta === 0) continue;

      const view = history.viewAt(date);
      const cost = fillCost(
        {
          shares: delta,
          price,
          spread: options.spread?.get(order.symbol) ?? 0.0005,
          dailyVolume: options.dailyVolume?.get(order.symbol) ?? 1e7,
          volatility: volatilityOf(view.window(`price:${order.symbol}`, VOL_WINDOW)),
        },
        costs,
      );
      cash -= delta * price + cost.total;
      totalCosts += cost.total;
      positions.set(order.symbol, order.targetShares);
      trades.push({ date, symbol: order.symbol, shares: delta, price, cost: cost.total });
    }
    pending = [];

    // 2. Mark the book.
    let gross = 0;
    let marked = cash;
    const held = new Map<string, { shares: number; price: number }>();
    for (const [symbol, shares] of positions) {
      const price = priceOf(symbol);
      if (price === undefined) continue;
      marked += shares * price;
      gross += Math.abs(shares * price);
      held.set(symbol, { shares, price });
    }

    // 3. Carry, charged on what was actually held overnight.
    if (bar > 0) {
      const carry = carryCost(held, marked, costs);
      cash -= carry;
      marked -= carry;
      totalCosts += carry;
    }

    equity.push(marked);
    exposure.push(marked !== 0 ? gross / Math.abs(marked) : 0);

    // 4. Decide, against a view that cannot see past this bar.
    if (bar < dates.length - 1) {
      pending = strategy(history.viewAt(date), {
        date,
        cash,
        positions: new Map(positions),
        equity: marked,
      });
    }
  }

  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const previous = equity[i - 1] as number;
    returns.push(previous !== 0 ? (equity[i] as number) / previous - 1 : 0);
  }

  const periodsPerYear = options.periodsPerYear ?? 252;
  return {
    dates,
    equity,
    returns,
    trades,
    exposure,
    totalCosts,
    sharpe: sharpe(returns, periodsPerYear),
    deflated: deflatedSharpe(returns, options.trials ?? 1, periodsPerYear),
    drawdown: maxDrawdown(equity),
  };
}
