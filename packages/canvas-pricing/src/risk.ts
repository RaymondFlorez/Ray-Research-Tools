/**
 * Pin risk, assignment risk and margin (PRD 5.4).
 *
 * Two sentences, and each names something the rest of this package computes
 * around rather than computes:
 *
 * > **`StrategyNode`:** ... Pin risk and assignment risk are computed and
 * > flagged.
 *
 * > **Portfolio-level:** ... margin estimation under Reg-T and portfolio
 * > margin; scenario P&L across a user-defined grid with the entire book
 * > repriced per cell.
 *
 * ## Pin risk is measured in standard deviations, not percent
 *
 * A short strike "near the money at expiry" cannot be a fixed band. Two
 * percent away is far on a 12-vol utility with two days to run and close
 * enough to pin on a 90-vol biotech, so a percentage band flags the wrong book
 * in both directions. The measure here is the distance to the strike in units
 * of the move the underlier still has left in it, `|ln(S/K)| / (sigma*sqrt(T))`,
 * which goes to infinity as expiry approaches for every strike but the one the
 * spot is actually sitting on — which is what pinning means.
 *
 * Only short positions pin. A long option at the strike is a decision the
 * holder makes; a short one is a decision made *for* them, after the close,
 * and the resulting stock position is carried over a weekend they cannot trade.
 *
 * ## Assignment risk is a comparison, not a threshold
 *
 * Early exercise is rational when what it buys is worth more than the time
 * value it throws away. For an American call that is the dividends captured
 * over the remaining life, less the interest given up by paying the strike
 * early; for a put it is the interest earned on the strike, less the dividends
 * forgone. Flag when that carry exceeds the option's extrinsic value.
 *
 * The comparison degenerates the way the textbook says it should: a call on a
 * non-dividend-paying underlier has negative carry at every strike and every
 * maturity, and is never flagged. A rule written as "deep in the money and
 * close to expiry" would flag it constantly, and an analyst who is warned about
 * something that cannot happen stops reading the warnings.
 *
 * ## The transcendentals stay in the crate
 *
 * Both flags are a number compared against a threshold, which is exactly where
 * a last-place difference between two math libraries becomes visible: the
 * warning appears in the browser and not on the server, or the reverse, and
 * the analyst sees something the export does not carry. So `pin_sigmas` and
 * `early_exercise_carry` live in `pricing-core` with everything else that uses
 * `log`, `sqrt` and `exp`, and this module marshals. The margin arithmetic
 * below is addition, multiplication and `max` on values that already crossed
 * the boundary, which every IEEE-754 implementation agrees on exactly.
 *
 * ## Portfolio margin is the grid, not a second model
 *
 * The regulatory method *is* a scenario sweep: reprice the book across a range
 * of underlier moves and take the worst loss. This package already reprices
 * books across a grid, so portfolio margin reads the answer off a `GridResult`
 * rather than modelling it again. Reg-T is a different thing entirely — a set
 * of per-position formulas that do not know the book is hedged — and the gap
 * between the two is the number an analyst actually wants.
 */

import type { Cell, GridResult, Leg, Market } from './grid.js';
import type { PricingExports } from './module.js';

// ---------------------------------------------------------------------------
// Pin risk
// ---------------------------------------------------------------------------

/**
 * How close to expiry a strike has to be before pinning is the right worry.
 *
 * Three trading days. Past that the sigma measure below is doing all the work
 * and would flag a strike that has a week to move somewhere else.
 */
export const PIN_WINDOW_YEARS = 3 / 252;

/** Inside one remaining standard deviation is "near the money" here. */
export const PIN_SIGMA = 1;

export interface PinFlag {
  legIndex: number;
  strike: number;
  /** Distance to the strike in remaining standard deviations. */
  sigmas: number;
  /** Trading days to expiry, for the message. */
  days: number;
  /** Shares that settle either way, if it pins. */
  sharesAtRisk: number;
  message: string;
}

export function pinRisk(
  exports: PricingExports,
  legs: readonly Leg[],
  market: Market,
  sigmaThreshold = PIN_SIGMA,
  windowYears = PIN_WINDOW_YEARS,
): PinFlag[] {
  const flags: PinFlag[] = [];
  for (const [legIndex, leg] of legs.entries()) {
    // A long option at the strike is the holder's decision to make.
    if (leg.quantity >= 0) continue;
    if (leg.time > windowYears) continue;
    const sigmas = strikeSigmas(exports, leg, market);
    if (sigmas > sigmaThreshold) continue;
    const sharesAtRisk = Math.abs(leg.quantity) * leg.multiplier;
    flags.push({
      legIndex,
      strike: leg.strike,
      sigmas,
      days: leg.time * 252,
      sharesAtRisk,
      message:
        `short ${leg.kind} at ${leg.strike} is ${sigmas.toFixed(2)} sigma from spot with ` +
        `${(leg.time * 252).toFixed(1)} trading days left: ${sharesAtRisk} shares settle either way`,
    });
  }
  return flags;
}

/**
 * Distance from spot to the strike in units of the move that is still to come.
 *
 * `pricing-core`'s, not a second copy: infinite at expiry for any strike the
 * spot is not sitting on, and infinite for a zero-vol leg, both of which are
 * the right answer, and both of which this module would have to get right
 * again if it computed them here.
 */
export function strikeSigmas(exports: PricingExports, leg: Leg, market: Market): number {
  return exports.pc_pin_sigmas(market.spot, leg.strike, leg.vol, leg.time);
}

// ---------------------------------------------------------------------------
// Assignment risk
// ---------------------------------------------------------------------------

/** A discrete dividend inside the option's life. */
export interface Dividend {
  /** Years from now to the ex-date. */
  time: number;
  amount: number;
}

export interface AssignmentFlag {
  legIndex: number;
  strike: number;
  /** What exercising early is worth: dividends captured less interest given up, or the reverse. */
  carry: number;
  /** The time value the holder throws away by exercising. */
  extrinsic: number;
  sharesAtRisk: number;
  message: string;
}

export interface AssignmentInput {
  exports: PricingExports;
  legs: readonly Leg[];
  market: Market;
  /** The current mark of each leg, per share. Required: extrinsic is price minus intrinsic. */
  marks: readonly number[];
  /**
   * Discrete dividends before expiry. Omitted, the market's continuous yield is
   * used, which is the same statement made less precisely — and precision is
   * exactly what decides this comparison in the last week before an ex-date.
   */
  dividends?: readonly Dividend[];
}

export function assignmentRisk(input: AssignmentInput): AssignmentFlag[] {
  const { legs, market } = input;
  const flags: AssignmentFlag[] = [];

  for (const [legIndex, leg] of legs.entries()) {
    if (leg.quantity >= 0) continue;
    // European legs cannot be assigned before expiry. Nothing to flag.
    if (leg.style !== 'american') continue;
    const mark = input.marks[legIndex];
    if (mark === undefined) continue;

    const intrinsic =
      leg.kind === 'call'
        ? Math.max(market.spot - leg.strike, 0)
        : Math.max(leg.strike - market.spot, 0);
    if (intrinsic <= 0) continue; // Nobody exercises out of the money.
    const extrinsic = Math.max(mark - intrinsic, 0);

    const carry = carryFor(input, leg);
    if (carry <= extrinsic) continue;

    const sharesAtRisk = Math.abs(leg.quantity) * leg.multiplier;
    flags.push({
      legIndex,
      strike: leg.strike,
      carry,
      extrinsic,
      sharesAtRisk,
      message:
        `short American ${leg.kind} at ${leg.strike} carries ${carry.toFixed(3)} against ` +
        `${extrinsic.toFixed(3)} of time value: exercising early is worth more than holding, ` +
        `and ${sharesAtRisk} shares may be assigned`,
    });
  }
  return flags;
}

/**
 * The carry on one leg, from the crate.
 *
 * With no dividend list this is one call. With a list, the dated dividends
 * replace the continuous yield: each is discounted by the crate's own factor
 * and the difference from the yield-based figure is added, so the sum is
 * arithmetic on values that already crossed the boundary rather than a second
 * implementation of the same formula.
 */
function carryFor(input: AssignmentInput, leg: Leg): number {
  const { exports, market } = input;
  const isCall = leg.kind === 'call' ? 1 : 0;
  if (input.dividends === undefined) {
    return exports.pc_early_exercise_carry(
      market.spot,
      leg.strike,
      market.rate,
      market.dividend,
      leg.time,
      isCall,
    );
  }
  // The yield-free carry, then the dated dividends on top.
  const withoutDividends = exports.pc_early_exercise_carry(
    market.spot,
    leg.strike,
    market.rate,
    0,
    leg.time,
    isCall,
  );
  let pv = 0;
  for (const dividend of input.dividends) {
    if (dividend.time < 0 || dividend.time > leg.time) continue;
    pv += dividend.amount * exports.pc_discount(market.rate, dividend.time);
  }
  return leg.kind === 'call' ? withoutDividends + pv : withoutDividends - pv;
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

/** Reg-T: 20 percent of the underlier for a naked short, less what is out of the money. */
export const REG_T_RATE = 0.2;
/** The floor for a naked short call: 10 percent of the underlier. */
export const REG_T_CALL_FLOOR = 0.1;
/** The floor for a naked short put: 10 percent of the strike. */
export const REG_T_PUT_FLOOR = 0.1;

export interface MarginLine {
  legIndex: number;
  /** How this position was treated. */
  treatment: 'long_premium' | 'naked_short' | 'spread';
  requirement: number;
  note: string;
}

export interface RegTMargin {
  total: number;
  lines: MarginLine[];
}

export interface RegTInput {
  legs: readonly Leg[];
  market: Market;
  /** The current mark of each leg, per share. */
  marks: readonly number[];
}

/**
 * Reg-T margin, with verticals recognised.
 *
 * A long option is paid for in full. A naked short is 20 percent of the
 * underlier plus the premium, less the amount the strike is out of the money,
 * floored. A short that is covered by a long of the same type and expiry is a
 * vertical and is margined at its maximum loss, which is the whole reason
 * anybody trades one.
 *
 * Matching is greedy by nearest strike within a type and expiry, because that
 * is the pairing that produces the tightest spread and therefore the treatment
 * the account would actually be given. It does not attempt the full set of
 * recognised strategies — butterflies, condors, boxes and calendars all reduce
 * further under the real rules, and this reports the more conservative number
 * for them. `README` says so; a margin estimate that quietly under-reports is
 * worse than one that is visibly rough.
 */
export function regTMargin(input: RegTInput): RegTMargin {
  const { legs, market } = input;
  const lines: MarginLine[] = [];
  const shortsRemaining = legs.map((leg) => (leg.quantity < 0 ? -leg.quantity : 0));
  const longsRemaining = legs.map((leg) => (leg.quantity > 0 ? leg.quantity : 0));

  // Pass one: pair each short with the closest eligible long.
  for (const [i, leg] of legs.entries()) {
    while (shortsRemaining[i]! > 0) {
      const j = closestCover(legs, longsRemaining, i);
      if (j === undefined) break;
      const lots = Math.min(shortsRemaining[i]!, longsRemaining[j]!);
      shortsRemaining[i]! -= lots;
      longsRemaining[j]! -= lots;
      const other = legs[j]!;
      const width = Math.abs(leg.strike - other.strike);
      // A debit vertical's maximum loss is the premium, already paid; a credit
      // vertical's is the width less the credit. The conservative reading of
      // both is the width, less any net credit received.
      const netCredit = (input.marks[i] ?? 0) - (input.marks[j] ?? 0);
      const requirement = Math.max(width - Math.max(netCredit, 0), 0) * lots * leg.multiplier;
      lines.push({
        legIndex: i,
        treatment: 'spread',
        requirement,
        note: `${lots} lot(s) covered by leg ${j} at ${other.strike}: max loss on a ${width.toFixed(2)}-wide vertical`,
      });
    }
  }

  // Pass two: whatever is left is naked, or paid for.
  for (const [i, leg] of legs.entries()) {
    const shortLots = shortsRemaining[i]!;
    if (shortLots > 0) {
      const mark = input.marks[i] ?? 0;
      const outOfTheMoney =
        leg.kind === 'call'
          ? Math.max(leg.strike - market.spot, 0)
          : Math.max(market.spot - leg.strike, 0);
      const standard = mark + REG_T_RATE * market.spot - outOfTheMoney;
      const floor =
        leg.kind === 'call'
          ? mark + REG_T_CALL_FLOOR * market.spot
          : mark + REG_T_PUT_FLOOR * leg.strike;
      const perShare = Math.max(standard, floor);
      lines.push({
        legIndex: i,
        treatment: 'naked_short',
        requirement: perShare * shortLots * leg.multiplier,
        note: `${shortLots} naked lot(s): max(20% of spot less ${outOfTheMoney.toFixed(2)} out-of-the-money, the floor) plus premium`,
      });
    }
    const longLots = longsRemaining[i]!;
    if (longLots > 0) {
      lines.push({
        legIndex: i,
        treatment: 'long_premium',
        requirement: (input.marks[i] ?? 0) * longLots * leg.multiplier,
        note: `${longLots} long lot(s) paid for in full`,
      });
    }
  }

  return { total: lines.reduce((a, line) => a + line.requirement, 0), lines };
}

/** The long leg that covers a short: same type and expiry, nearest strike. */
function closestCover(
  legs: readonly Leg[],
  longsRemaining: readonly number[],
  shortIndex: number,
): number | undefined {
  const short = legs[shortIndex]!;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [j, leg] of legs.entries()) {
    if (j === shortIndex || longsRemaining[j]! <= 0) continue;
    if (leg.kind !== short.kind || leg.time !== short.time) continue;
    // A long strike on the wrong side does not cover: a short 100 call is not
    // covered by a long 110 call unless the long is the nearer one, which the
    // distance test decides on its own.
    const distance = Math.abs(leg.strike - short.strike);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = j;
    }
  }
  return best;
}

/** CBOE portfolio margin for an equity: plus or minus 15 percent, in ten points. */
export const PORTFOLIO_MARGIN_RANGE = 0.15;
export const PORTFOLIO_MARGIN_POINTS = 10;

export interface PortfolioMargin {
  requirement: number;
  /** The spot that produced the worst loss, as a fraction of today's. */
  worstSpotShift: number;
  worstVolShift: number;
  /** Every point that was evaluated, so the sweep is inspectable. */
  scenarios: Array<{ spotShift: number; volShift: number; pnl: number }>;
  /** Set when the grid does not reach the full range the rule prescribes. */
  shortfall?: string;
}

/**
 * The worst loss across the prescribed range, read off a repriced grid.
 *
 * The regulatory method is a scenario sweep and this package already sweeps, so
 * this reads the answer rather than modelling it a second way. The grid may be
 * narrower than the rule's range — an analyst's own grid usually is — and that
 * is reported rather than extrapolated: a margin number produced by guessing
 * past the edge of what was priced is the kind of number that is believed.
 */
export function portfolioMargin(
  result: GridResult,
  market: Market,
  range = PORTFOLIO_MARGIN_RANGE,
): PortfolioMargin {
  const base = result.cell(centreIndex(result.spotCount), centreIndex(result.volCount));
  const scenarios: PortfolioMargin['scenarios'] = [];
  let worst = 0;
  let worstSpotShift = 0;
  let worstVolShift = 0;

  for (let s = 0; s < result.spotCount; s++) {
    const spotShift = (result.spotAxis[s]! - market.spot) / market.spot;
    if (Math.abs(spotShift) > range + 1e-12) continue;
    for (let v = 0; v < result.volCount; v++) {
      const cell: Cell = result.cell(s, v);
      const pnl = cell.value - base.value;
      scenarios.push({ spotShift, volShift: result.volAxis[v]!, pnl });
      if (pnl < worst) {
        worst = pnl;
        worstSpotShift = spotShift;
        worstVolShift = result.volAxis[v]!;
      }
    }
  }

  const reached = Math.max(...scenarios.map((s) => Math.abs(s.spotShift)), 0);
  const margin: PortfolioMargin = {
    requirement: -worst,
    worstSpotShift,
    worstVolShift,
    scenarios,
  };
  if (reached < range - 1e-9) {
    margin.shortfall =
      `the grid spans ${(reached * 100).toFixed(1)}% of spot against the ${(range * 100).toFixed(0)}% ` +
      'the rule prescribes; the requirement is the worst loss that was actually priced, not an extrapolation';
  }
  return margin;
}

function centreIndex(count: number): number {
  return (count - 1) >> 1;
}

// ---------------------------------------------------------------------------
// The book's flags, in one call
// ---------------------------------------------------------------------------

export interface BookRisk {
  pin: PinFlag[];
  assignment: AssignmentFlag[];
  /** What each leg was marked at, so the caller can see what the flags rest on. */
  marks: number[];
}

/**
 * Both flags for a whole book, marking each leg through the engine.
 *
 * Assignment risk is a comparison against a leg's *extrinsic* value, so it
 * needs a mark. Asking the caller for one invites a mark from somewhere else —
 * a stale quote, a mid that has drifted — and then the flag is about a price
 * nothing else on the canvas is using. The marks come from the same engine the
 * grid does, and are returned so the flag can be read against them.
 *
 * American legs are marked with the American solver and European legs with
 * Black-Scholes, because an American leg marked as a European one has too
 * little extrinsic value and will be flagged for assignment when it should not.
 */
export function bookRisk(exports: PricingExports, legs: readonly Leg[], market: Market): BookRisk {
  const marks = legs.map((leg) => {
    const isCall = leg.kind === 'call' ? 1 : 0;
    return leg.style === 'american'
      ? exports.pc_american_exact(
          market.spot,
          leg.strike,
          leg.time,
          market.rate,
          market.dividend,
          leg.vol,
          isCall,
        )
      : exports.pc_price(
          market.spot,
          leg.strike,
          leg.time,
          market.rate,
          market.dividend,
          leg.vol,
          isCall,
        );
  });
  return {
    pin: pinRisk(exports, legs, market),
    assignment: assignmentRisk({ exports, legs, market, marks }),
    marks,
  };
}
