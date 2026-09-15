/**
 * De-vigging (PRD 5.6, Appendix C.4).
 *
 * C.4's decision is not a method, it is a routing rule, and the routing rule
 * is what makes most of the problem go away:
 *
 * | Market type | Treatment |
 * |---|---|
 * | Binary CLOB (Polymarket, Kalshi) | **No de-vig.** Liquidity-weighted mid with a spread-width confidence band. |
 * | Multi-outcome, prices sum above 1 | Multiplicative by default |
 * | Sportsbook-derived lines | Multiplicative by default, Shin surfaced by the divergence flag |
 *
 * The first row is a correctness fix, not a preference. A Polymarket binary is
 * a collateralized two-outcome order book: YES and NO are the two halves of a
 * dollar, held as collateral, and there is no bookmaker taking a margin out of
 * the middle. The gap between the best bid and the best ask is a *spread*, and
 * treating it as vig and normalizing it away invents a bias that was not
 * there — while hiding the thing that actually is uncertain, which is how wide
 * the book is and how much sits on it.
 *
 * Every method here reports which it used and what it assumed, because the
 * assumption is the whole content of the number: multiplicative assumes the
 * margin is proportional to price, additive assumes it is a flat amount per
 * outcome, and Shin assumes a fraction of the volume is informed.
 */

/** What kind of venue produced the quotes. This decides the treatment. */
export type MarketType = 'binary_clob' | 'multi_outcome' | 'sportsbook';

export type DevigMethod = 'none' | 'multiplicative' | 'additive' | 'shin' | 'power';

export interface Quote {
  outcome: string;
  /** Best bid, in probability units. */
  bid?: number;
  /** Best ask, in probability units. */
  ask?: number;
  /** Last or mid, where a book is not available. */
  price?: number;
  /** Size resting at the bid and ask, for the liquidity weighting. */
  bidSize?: number;
  askSize?: number;
}

export interface Implied {
  outcome: string;
  probability: number;
  /** Half-width of the confidence band, where one is meaningful. */
  band?: number;
}

export interface DevigResult {
  method: DevigMethod;
  /** What the method assumes, in one sentence, for the node's tooltip. */
  assumption: string;
  probabilities: Implied[];
  /** Sum of the raw quotes. 1 means no margin to remove. */
  booksum: number;
  /** Shin's estimated informed-trading fraction, when Shin ran. */
  insiderFraction?: number;
  /** Power method's exponent, when it ran. */
  exponent?: number;
}

/** C.4's alarm threshold, in basis points of probability. */
export const DIVERGENCE_BPS = 150;

export interface Devigged extends DevigResult {
  /**
   * Set when Shin and multiplicative disagree by more than the threshold on
   * any outcome. Carries both numbers and the one-line explanation.
   */
  divergence?: {
    outcome: string;
    multiplicative: number;
    shin: number;
    gapBps: number;
    explanation: string;
  };
}

// ---------------------------------------------------------------------------
// The liquidity-weighted mid, which is what a CLOB actually needs
// ---------------------------------------------------------------------------

/**
 * The microprice: each side weighted by the size resting on the *other* side.
 *
 *     (bid * askSize + ask * bidSize) / (bidSize + askSize)
 *
 * The weighting runs the opposite way to the obvious guess, and the obvious
 * guess is worth naming because it is the one I reached for first. A book
 * showing 0.34 bid for 50,000 against 0.36 ask for 200 does not sit near 0.34
 * "because that is where the depth is". It sits near 0.36, because the thin
 * side is the side about to be consumed: fifty thousand lots of buying
 * interest against two hundred offered is a queue that will lift the ask, and
 * the plain mid at 0.35 understates where the next trade prints.
 *
 * So size on a side pushes the price *away* from that side. This book gives
 * 0.3599.
 */
export function liquidityWeightedMid(quote: Quote): number {
  const { bid, ask, bidSize, askSize } = quote;
  if (bid === undefined || ask === undefined) return quote.price ?? Number.NaN;
  if (bidSize === undefined || askSize === undefined || bidSize + askSize === 0) {
    return (bid + ask) / 2;
  }
  return (bid * askSize + ask * bidSize) / (bidSize + askSize);
}

export function spreadBand(quote: Quote): number {
  const { bid, ask } = quote;
  if (bid === undefined || ask === undefined) return Number.NaN;
  return Math.abs(ask - bid) / 2;
}

function rawPrice(quote: Quote): number {
  if (quote.price !== undefined) return quote.price;
  if (quote.bid !== undefined && quote.ask !== undefined) return (quote.bid + quote.ask) / 2;
  return quote.bid ?? quote.ask ?? Number.NaN;
}

// ---------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------

export function multiplicative(prices: readonly number[]): number[] {
  const sum = prices.reduce((a, b) => a + b, 0);
  return prices.map((p) => p / sum);
}

/**
 * Subtract the margin equally across outcomes.
 *
 * Can produce a negative probability on a long enough longshot, which is not a
 * rounding problem but the method telling you its assumption does not hold:
 * a flat per-outcome margin larger than the longshot's own price cannot be
 * subtracted from it. Clamping silently would hide that, so this returns the
 * negative and `devig` refuses to route to it by default.
 */
export function additive(prices: readonly number[]): number[] {
  const sum = prices.reduce((a, b) => a + b, 0);
  const margin = (sum - 1) / prices.length;
  return prices.map((p) => p - margin);
}

/**
 * Raise each price to a common power until they sum to one.
 *
 * The exponent is found by bisection: the sum is monotone decreasing in `k`
 * for prices below 1, so the bracket is safe and the control flow depends
 * only on the sign of a difference.
 */
export function power(prices: readonly number[]): { probabilities: number[]; exponent: number } {
  const sumAt = (k: number) => prices.reduce((total, p) => total + p ** k, 0);
  let low = 1;
  let high = 1;
  while (sumAt(high) > 1 && high < 64) high *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (sumAt(mid) > 1) low = mid;
    else high = mid;
  }
  const exponent = (low + high) / 2;
  return { probabilities: prices.map((p) => p ** exponent), exponent };
}

/**
 * Shin (1992, 1993): a fraction `z` of the volume is informed.
 *
 *     p_i = ( sqrt( z^2 + 4(1-z) * pi_i^2 / Pi ) - z ) / ( 2(1-z) )
 *
 * with `z` solved so the probabilities sum to one. The model says the
 * bookmaker widens each price to cover the losses it expects to insiders, and
 * that this widening is proportionally largest on the outcomes insiders most
 * often know about — which is where the favourite-longshot bias comes from.
 *
 * `z` is solved by bisection on [0, 1). The sum is monotone in `z`, and the
 * alternative — Newton on a square root — buys nothing here and costs the
 * property that the same input takes the same branches everywhere.
 */
export function shin(prices: readonly number[]): { probabilities: number[]; insiderFraction: number } {
  const booksum = prices.reduce((a, b) => a + b, 0);
  const at = (z: number): number[] => {
    if (z <= 0) return prices.map((p) => p / booksum);
    const denominator = 2 * (1 - z);
    return prices.map((p) => (Math.sqrt(z * z + (4 * (1 - z) * p * p) / booksum) - z) / denominator);
  };
  const sumAt = (z: number) => at(z).reduce((a, b) => a + b, 0);

  let low = 0;
  let high = 0.999_999;
  // With a booksum at or below 1 there is no margin for insiders to explain,
  // and z solves to zero, which is the multiplicative answer.
  if (booksum <= 1) return { probabilities: at(0), insiderFraction: 0 };
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (sumAt(mid) > 1) low = mid;
    else high = mid;
  }
  const z = (low + high) / 2;
  return { probabilities: at(z), insiderFraction: z };
}

// ---------------------------------------------------------------------------
// The routing rule
// ---------------------------------------------------------------------------

const ASSUMPTIONS: Record<DevigMethod, string> = {
  none: 'no bookmaker margin to remove; the spread is the uncertainty',
  multiplicative: 'the margin is proportional to each price',
  additive: 'the margin is a flat amount per outcome',
  shin: 'a fraction of the volume is informed, and the book widens to cover it',
  power: 'the margin compresses prices by a common exponent',
};

export interface DevigInput {
  marketType: MarketType;
  quotes: readonly Quote[];
  /** Override the routing. The node offers this; nothing selects it by default. */
  method?: DevigMethod;
}

export function devig(input: DevigInput): Devigged {
  const { marketType, quotes } = input;

  // C.4's first row. A collateralized two-outcome book has no margin in it,
  // and normalizing the spread away would introduce a bias where none existed
  // while hiding the thing that is actually uncertain.
  if (marketType === 'binary_clob' && input.method === undefined) {
    const probabilities = quotes.map((q) => ({
      outcome: q.outcome,
      probability: liquidityWeightedMid(q),
      band: spreadBand(q),
    }));
    return {
      method: 'none',
      assumption: ASSUMPTIONS.none,
      probabilities,
      booksum: quotes.reduce((total, q) => total + rawPrice(q), 0),
    };
  }

  const prices = quotes.map(rawPrice);
  const booksum = prices.reduce((a, b) => a + b, 0);
  const method = input.method ?? 'multiplicative';

  let probabilities: number[];
  let insiderFraction: number | undefined;
  let exponent: number | undefined;
  switch (method) {
    case 'none':
      probabilities = [...prices];
      break;
    case 'additive':
      probabilities = additive(prices);
      break;
    case 'power': {
      const result = power(prices);
      probabilities = result.probabilities;
      exponent = result.exponent;
      break;
    }
    case 'shin': {
      const result = shin(prices);
      probabilities = result.probabilities;
      insiderFraction = result.insiderFraction;
      break;
    }
    case 'multiplicative':
    default:
      probabilities = multiplicative(prices);
      break;
  }

  const result: Devigged = {
    method,
    assumption: ASSUMPTIONS[method],
    probabilities: quotes.map((q, i) => ({ outcome: q.outcome, probability: probabilities[i] ?? Number.NaN })),
    booksum,
    ...(insiderFraction !== undefined ? { insiderFraction } : {}),
    ...(exponent !== undefined ? { exponent } : {}),
  };

  const divergence = checkDivergence(quotes, prices);
  return divergence ? { ...result, divergence } : result;
}

/**
 * "Shin is computed silently alongside multiplicative on every de-vigged
 * market. When the two methods differ by more than 150bps ... the node shows
 * both numbers with a one-line explanation of why they differ."
 *
 * Reported on the worst outcome rather than all of them, because the flag is
 * an alarm and an alarm that lists six rows is a table.
 */
export function checkDivergence(
  quotes: readonly Quote[],
  prices: readonly number[],
): Devigged['divergence'] {
  if (prices.length < 2) return undefined;
  const mult = multiplicative(prices);
  const { probabilities: sh } = shin(prices);

  // Fire on the absolute gap, rank on the relative one.
  //
  // In a two-outcome book the absolute gaps are *identical* — both sets sum to
  // one, so whatever Shin takes from one side it gives to the other — and
  // ranking by absolute gap is a coin flip that lands on whichever index comes
  // first. It landed on the favourite, and the flag then explained a
  // favourite-longshot effect while pointing at the favourite.
  //
  // The relative gap is the decision-relevant one anyway. On the book below,
  // 221 basis points is 2.5 percent of the favourite's price and 16.7 percent
  // of the longshot's. The analyst sizing a position off the longshot is the
  // one whose number moved.
  const fires = mult.some((m, i) => Math.abs(m - (sh[i] ?? 0)) * 10_000 > DIVERGENCE_BPS);
  if (!fires) return undefined;

  let worst: { index: number; relative: number } | undefined;
  for (let i = 0; i < prices.length; i += 1) {
    const probability = mult[i] ?? 0;
    if (probability <= 0) continue;
    const relative = Math.abs(probability - (sh[i] ?? 0)) / probability;
    if (!worst || relative > worst.relative) worst = { index: i, relative };
  }
  if (!worst) return undefined;
  const i = worst.index;
  const gap = Math.abs((mult[i] ?? 0) - (sh[i] ?? 0));
  const longshot = (mult[i] ?? 0) < 0.5;
  return {
    outcome: quotes[i]?.outcome ?? `outcome ${i}`,
    multiplicative: mult[i] ?? Number.NaN,
    shin: sh[i] ?? Number.NaN,
    gapBps: Math.round(gap * 10_000),
    explanation: longshot
      ? 'Shin assumes informed traders concentrate on longshots, so it shrinks this price further than a proportional margin would. The gap is the favourite-longshot bias.'
      : 'Shin and a proportional margin disagree on where the book carries its cushion. Neither is a measurement; the gap is the size of the modelling choice.',
  };
}
