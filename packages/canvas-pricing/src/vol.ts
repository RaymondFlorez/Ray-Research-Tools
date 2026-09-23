/**
 * Volatility analytics (PRD 5.4).
 *
 * > **Vol analytics:** term structure, skew and its history, realized vs
 * > implied spread, variance risk premium, and event-implied moves backed out
 * > of the straddle around a known date.
 *
 * Five figures, and four of them are a subtraction once the inputs are right.
 * Getting the inputs right is the work, and three of those decisions are the
 * ones this module exists to make.
 *
 * ## A variance risk premium compares two windows that are the same window
 *
 * Implied variance is forward-looking: the number quoted today is about the
 * next thirty days. Realized variance is backward-looking. Differencing
 * today's implied against the *last* thirty days' realized is the common
 * version and it is a different quantity — it is a statement about whether
 * volatility rose or fell, not about whether it was overpriced. The premium
 * needs the realized window that the implied quote was about, which means the
 * premium for a given date cannot be computed until that window has closed.
 *
 * So `variancePremium` takes the quote's expiry and the realized window's
 * dates, and refuses when the window does not cover the quote. A number that
 * cannot be computed yet is not the same as one that can be computed from the
 * data lying nearest to hand.
 *
 * ## Skew is read in delta space, through the engine
 *
 * "Skew" quoted on a desk is a risk reversal: the implied vol at the 25-delta
 * put less the one at the 25-delta call. A slope in strike space is a
 * different number that moves when spot moves and when time passes, even with
 * the smile unchanged, so a *history* of it — which the PRD asks for —
 * measures the underlier as much as the smile.
 *
 * The strikes are quoted, the deltas are not, so each quote's delta comes from
 * the same engine that prices everything else and the smile is interpolated in
 * delta rather than in strike.
 *
 * ## Where the arithmetic happens
 *
 * The log returns, the forward variance and the event split are in
 * `pricing-core`, with the rest of this repo's `log` and `exp`. `Math.sqrt`
 * stays here: IEEE-754 requires it to be correctly rounded, so it is the same
 * number everywhere, which `Math.log` is not.
 *
 * ## The event move is not the straddle
 *
 * "Backed out of the straddle around a known date" is the requirement, and the
 * straddle's own implied move includes the ordinary diffusion over the same
 * days. Over five trading days on a thirty-vol name that diffusion is 4.2
 * percent by itself, which is most of what a naive reading calls the earnings
 * move. Two expiries bracketing the event separate them: the quiet one gives
 * the diffusive rate, and what is left in the event expiry's total variance is
 * the event.
 */

import type { PricingExports } from './module.js';

/** Trading days in a year: the unit an implied volatility is quoted in. */
export const TRADING_DAYS = 252;

// ---------------------------------------------------------------------------
// Realized
// ---------------------------------------------------------------------------

/**
 * Annualized realized volatility over a close series.
 *
 * Close-to-close log returns without subtracting the sample mean, computed in
 * `pricing-core`: over a twenty- or sixty-day window the sample mean is a drift
 * estimate whose standard error is several times the drift, so subtracting it
 * removes more signal than bias — and an implied volatility is a zero-drift
 * parameter, so a centred realized number would be differenced against
 * something it does not match.
 *
 * NaN for fewer than two closes or a non-positive one. A zero would read as a
 * calm market rather than as missing data.
 */
export function realizedVol(
  exports: PricingExports,
  closes: readonly number[],
  periodsPerYear = TRADING_DAYS,
): number {
  load(exports, closes);
  return exports.pc_realized_vol(periodsPerYear);
}

/** The same window as a variance, because squaring a rounded vol is a different number. */
export function realizedVariance(
  exports: PricingExports,
  closes: readonly number[],
  periodsPerYear = TRADING_DAYS,
): number {
  load(exports, closes);
  return exports.pc_realized_variance(periodsPerYear);
}

function load(exports: PricingExports, closes: readonly number[]): void {
  exports.pc_vol_reset();
  for (const close of closes) exports.pc_vol_observe(close);
}

// ---------------------------------------------------------------------------
// Term structure
// ---------------------------------------------------------------------------

export interface AtmQuote {
  /** Years to expiry. */
  time: number;
  /** The at-the-money implied volatility. */
  vol: number;
  /** Expiry date, for the label. */
  expiry?: string;
}

export interface TermPoint extends AtmQuote {
  /** Volatility of the period between this expiry and the previous one. */
  forwardVol?: number;
  /** Set when the forward variance is negative, which is a calendar arbitrage. */
  arbitrage?: string;
}

/**
 * The ATM term structure, with the forward volatility between each pair.
 *
 * A negative forward variance is not smoothed away. PRD 5.4 asks for "an
 * explicit flag when the constraints cannot be satisfied, which is itself
 * information", and a near expiry carrying more total variance than a far one
 * is exactly that: the quotes are inconsistent, and a term structure that
 * clamped the forward to zero would show a flat patch that looks like a market
 * view.
 */
export function termStructure(
  exports: PricingExports,
  quotes: readonly AtmQuote[],
): TermPoint[] {
  const sorted = [...quotes].sort((a, b) => a.time - b.time);
  const points: TermPoint[] = [];
  for (const [index, quote] of sorted.entries()) {
    const point: TermPoint = { ...quote };
    const previous = sorted[index - 1];
    if (previous) {
      const forward = exports.pc_forward_vol(previous.time, previous.vol, quote.time, quote.vol);
      if (Number.isNaN(forward)) {
        point.arbitrage =
          `${label(previous)} carries more total variance than ${label(quote)}: ` +
          'the forward variance between them is negative, which no diffusion can produce';
      } else {
        point.forwardVol = forward;
      }
    }
    points.push(point);
  }
  return points;
}

function label(quote: AtmQuote): string {
  return quote.expiry ?? `${(quote.time * TRADING_DAYS).toFixed(0)}d`;
}

// ---------------------------------------------------------------------------
// Skew
// ---------------------------------------------------------------------------

export interface SmileQuote {
  strike: number;
  vol: number;
  kind: 'call' | 'put';
}

export interface SkewInput {
  exports: PricingExports;
  quotes: readonly SmileQuote[];
  spot: number;
  time: number;
  rate: number;
  dividend: number;
  /** The delta the risk reversal is quoted at. 25 is the convention. */
  delta?: number;
}

export interface Skew {
  /** Implied vol at the put delta. */
  putVol: number;
  /** Implied vol at the call delta. */
  callVol: number;
  /** The risk reversal: put vol less call vol. Positive is the equity case. */
  riskReversal: number;
  /** The butterfly: the two wings against the middle. */
  butterfly: number;
  atmVol: number;
  delta: number;
}

export class SmileTooNarrow extends Error {
  constructor(readonly side: 'put' | 'call', readonly reached: number, target: number) {
    super(
      `the quoted strikes do not reach ${target.toFixed(2)} delta on the ${side} side ` +
        `(nearest is ${reached.toFixed(3)}); a risk reversal read off an extrapolation is not a quote`,
    );
    this.name = 'SmileTooNarrow';
  }
}

/**
 * The risk reversal and butterfly, interpolated in delta space.
 *
 * Every quote's delta comes from the engine at that quote's own volatility,
 * which is what makes this a smile in delta rather than a smile in strike
 * relabelled. Interpolation is linear between the two quotes bracketing the
 * target delta; extrapolation is refused, because a 25-delta risk reversal read
 * off strikes that stop at 35 delta is a number about the interpolation rather
 * than about the market.
 */
export function skew(input: SkewInput): Skew {
  const target = input.delta ?? 0.25;
  const points = input.quotes.map((quote) => ({
    quote,
    delta: input.exports.pc_greek(
      input.spot,
      quote.strike,
      input.time,
      input.rate,
      input.dividend,
      quote.vol,
      quote.kind === 'call' ? 1 : 0,
      1,
    ),
  }));

  const calls = points
    .filter((p) => p.quote.kind === 'call' && p.delta > 0 && p.delta < 1)
    .sort((a, b) => a.delta - b.delta);
  const puts = points
    .filter((p) => p.quote.kind === 'put' && p.delta < 0 && p.delta > -1)
    .map((p) => ({ ...p, delta: -p.delta }))
    .sort((a, b) => a.delta - b.delta);

  const callVol = interpolate(calls, target, 'call');
  const putVol = interpolate(puts, target, 'put');
  const atmVol = atTheMoneyVol(input.quotes, input.spot);

  return {
    putVol,
    callVol,
    riskReversal: putVol - callVol,
    butterfly: (putVol + callVol) / 2 - atmVol,
    atmVol,
    delta: target,
  };
}

/**
 * The at-the-money volatility: the quoted strike nearest spot.
 *
 * Not the fifty-delta point, which is what the delta-space reading above might
 * suggest. A fifty-delta put does not exist on an equity smile — carry puts the
 * at-the-money put nearer forty-five — so interpolating to 0.5 on both sides
 * asks the quotes for a strike that is not there, and refuses on a perfectly
 * ordinary smile. When a call and a put are quoted at that strike, both are
 * used: they should agree, and where they do not the average is the honest
 * reading of two quotes rather than a choice between them.
 */
function atTheMoneyVol(quotes: readonly SmileQuote[], spot: number): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const quote of quotes) {
    const distance = Math.abs(quote.strike - spot);
    if (distance < nearest) nearest = distance;
  }
  const atTheMoney = quotes.filter((q) => Math.abs(Math.abs(q.strike - spot) - nearest) < 1e-12);
  return atTheMoney.reduce((a, q) => a + q.vol, 0) / atTheMoney.length;
}

function interpolate(
  points: ReadonlyArray<{ delta: number; quote: SmileQuote }>,
  target: number,
  side: 'put' | 'call',
): number {
  if (points.length === 0) throw new SmileTooNarrow(side, Number.NaN, target);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (target < first.delta) throw new SmileTooNarrow(side, first.delta, target);
  if (target > last.delta) throw new SmileTooNarrow(side, last.delta, target);
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1]!;
    const hi = points[i]!;
    if (target > hi.delta) continue;
    const span = hi.delta - lo.delta;
    if (span === 0) return lo.quote.vol;
    const weight = (target - lo.delta) / span;
    return lo.quote.vol + weight * (hi.quote.vol - lo.quote.vol);
  }
  return last.quote.vol;
}

// ---------------------------------------------------------------------------
// Realized versus implied, and the variance risk premium
// ---------------------------------------------------------------------------

export interface PremiumWindow {
  /** When the implied quote was taken. */
  quotedAt: string;
  /** The quote's expiry: the end of the window it is a statement about. */
  expiry: string;
  /** Implied volatility at that quote. */
  impliedVol: number;
  /** Closes covering the window, first at or before `quotedAt`. */
  closes: readonly number[];
  /** The date of each close, aligned with `closes`. */
  dates: readonly string[];
  periodsPerYear?: number;
}

export class WindowNotClosed extends Error {
  constructor(readonly expiry: string, readonly lastClose: string) {
    super(
      `the quote runs to ${expiry} and the closes stop at ${lastClose}: a variance premium ` +
        'compares the implied window with the realized one, and that window is still open',
    );
    this.name = 'WindowNotClosed';
  }
}

export interface VariancePremium {
  impliedVariance: number;
  realizedVariance: number;
  /** Implied less realized. Positive is the usual sign: volatility is sold. */
  premium: number;
  /** The same in volatility points, which is what a desk quotes. */
  volSpread: number;
  observations: number;
}

/**
 * Implied variance against the variance that actually happened over the same
 * window.
 *
 * Refuses a window that has not closed. The tempting alternative — difference
 * today's implied against the trailing realized — is a different quantity: it
 * says whether volatility rose or fell, not whether it was overpriced, and the
 * two have opposite signs often enough that nobody would notice the swap.
 */
export function variancePremium(
  exports: PricingExports,
  input: PremiumWindow,
): VariancePremium {
  const lastClose = input.dates[input.dates.length - 1];
  if (lastClose === undefined || lastClose < input.expiry) {
    throw new WindowNotClosed(input.expiry, lastClose ?? 'nothing');
  }
  const window: number[] = [];
  for (const [index, date] of input.dates.entries()) {
    if (date < input.quotedAt || date > input.expiry) continue;
    window.push(input.closes[index]!);
  }
  const periodsPerYear = input.periodsPerYear ?? TRADING_DAYS;
  const realized = realizedVariance(exports, window, periodsPerYear);
  const implied = input.impliedVol * input.impliedVol;
  return {
    impliedVariance: implied,
    realizedVariance: realized,
    premium: implied - realized,
    volSpread: input.impliedVol - Math.sqrt(realized),
    observations: window.length,
  };
}

// ---------------------------------------------------------------------------
// The event-implied move
// ---------------------------------------------------------------------------

export interface EventMoveInput {
  exports: PricingExports;
  /** An expiry that ends before the event: the quiet diffusion. */
  before: AtmQuote;
  /** The first expiry after the event. */
  after: AtmQuote;
}

export interface EventMove {
  /** The event's own move, as a fraction of spot. */
  move: number;
  /** What a straddle over the same expiry implies in total, diffusion included. */
  straddleImplied: number;
  /** The part of that which is ordinary diffusion. */
  diffusion: number;
}

export class NoEventPremium extends Error {
  constructor() {
    super(
      'the expiry spanning the event carries no more variance rate than the quiet one: ' +
        'these quotes do not price an event, which is not the same as pricing no move',
    );
    this.name = 'NoEventPremium';
  }
}

/**
 * The move the market attributes to a dated event.
 *
 * The straddle's implied move over the same expiry is reported next to it,
 * because the difference is the point: the straddle includes the diffusion that
 * would have happened anyway.
 */
export function eventImpliedMove(input: EventMoveInput): EventMove {
  const { before, after } = input;
  const move = input.exports.pc_event_move(before.time, before.vol, after.time, after.vol);
  if (Number.isNaN(move)) throw new NoEventPremium();
  return {
    move,
    straddleImplied: after.vol * Math.sqrt(after.time),
    diffusion: before.vol * Math.sqrt(after.time),
  };
}
