/**
 * Aggregate Greeks by underlying, sector and expiry bucket (PRD 5.4).
 *
 * > **Portfolio-level:** aggregate Greeks by underlying, sector, and expiry
 * > bucket; ...
 *
 * Summing is the easy part. What is not easy is that half of the Greeks are
 * not summable across underliers in the units they come out of the engine in,
 * and a report that adds them anyway produces a number that looks exactly
 * like exposure and is not.
 *
 * ## Share delta does not add across names
 *
 * A position's delta comes back in shares of its own underlier. Three hundred
 * shares of a $900 stock and three hundred shares of a $9 one are not six
 * hundred of anything. So a row reports **dollar delta** (shares times spot),
 * which does add, and carries share delta only when every position in the row
 * is on one underlier — which is true of every row in an underlier report and
 * of almost none in a sector or expiry report. The rule is expressed as the
 * row's shape rather than as a caveat in a tooltip: a sector row has no
 * `shareDelta` field to misread.
 *
 * Gamma is the same problem squared. Shares per dollar of spot is scaled by
 * spot twice to become dollars of delta per one percent move, and that is what
 * is reported. Vega and theta come out of the engine in dollars already and
 * need only their conventional units: per vol point, per calendar day.
 *
 * ## An unclassified position is a row, not an omission
 *
 * A position with no sector cannot be put in one, and the tempting behaviour
 * is to leave it out of a sector report. That understates every total in the
 * report by whatever the unclassified book carries. It gets its own row.
 *
 * ## Every Greek comes from the grid path
 *
 * Each position is repriced through the same `GridPricer` a StrategyNode uses,
 * at one cell, so an American leg's Greeks are the American ones and the
 * aggregate agrees with the surface the analyst is looking at. Black-Scholes
 * Greeks would be cheaper and would disagree with the surface on every
 * American put, which is the half of an equity book where it matters.
 */

import type { GridPricer, Leg, Market } from './grid.js';

export interface Position {
  id: string;
  /** The underlier's identifier, which is what a market is keyed by. */
  underlier: string;
  sector?: string;
  leg: Leg;
}

export type Grouping = 'underlier' | 'sector' | 'expiry';

/** Calendar-day expiry buckets. Upper bounds inclusive. */
export const EXPIRY_BUCKETS: ReadonlyArray<{ label: string; maxDays: number }> = [
  { label: '0-7d', maxDays: 7 },
  { label: '8-30d', maxDays: 30 },
  { label: '31-90d', maxDays: 90 },
  { label: '91d-1y', maxDays: 365 },
  { label: '>1y', maxDays: Number.POSITIVE_INFINITY },
];

export const UNCLASSIFIED = 'unclassified';

export interface GreekRow {
  key: string;
  positions: string[];
  /** Dollars of exposure per dollar move in every underlier, summed. */
  dollarDelta: number;
  /** Change in dollar delta for a one percent move in every underlier. */
  dollarGammaPerPct: number;
  /** Dollars per one vol point. */
  vegaPerVolPoint: number;
  /** Dollars per calendar day. */
  thetaPerDay: number;
  value: number;
  /**
   * Shares of delta, present only when every position in the row is on one
   * underlier. Absent everywhere else, because it does not add across names.
   */
  shareDelta?: number;
  underliers: string[];
}

export class NoMarketFor extends Error {
  constructor(readonly underlier: string, readonly positionId: string) {
    super(`position ${positionId} is on ${underlier}, and no market was given for it`);
    this.name = 'NoMarketFor';
  }
}

interface Priced {
  position: Position;
  spot: number;
  value: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

/** One cell, no shock: the grid path at the market as it stands. */
const POINT = { spotSteps: 1, spotRange: 0, volSteps: 1, volRange: 0 } as const;

export function priceEach(
  pricer: GridPricer,
  positions: readonly Position[],
  markets: Readonly<Record<string, Market>>,
): Priced[] {
  return positions.map((position) => {
    const market = markets[position.underlier];
    if (!market) throw new NoMarketFor(position.underlier, position.id);
    const cell = pricer.reprice([position.leg], market, POINT).cell(0, 0);
    return {
      position,
      spot: market.spot,
      value: cell.value,
      delta: cell.delta,
      gamma: cell.gamma,
      vega: cell.vega,
      theta: cell.theta,
    };
  });
}

function keyOf(position: Position, by: Grouping): string {
  if (by === 'underlier') return position.underlier;
  if (by === 'sector') return position.sector ?? UNCLASSIFIED;
  const days = position.leg.time * 365;
  return EXPIRY_BUCKETS.find((bucket) => days <= bucket.maxDays)!.label;
}

/**
 * The book's Greeks grouped one way, plus a total row.
 *
 * Rows come back in bucket order for expiry and by descending absolute dollar
 * delta otherwise, so the name carrying the book is the first thing read.
 */
export function aggregateGreeks(
  pricer: GridPricer,
  positions: readonly Position[],
  markets: Readonly<Record<string, Market>>,
  by: Grouping,
): { rows: GreekRow[]; total: GreekRow } {
  const priced = priceEach(pricer, positions, markets);
  const groups = new Map<string, Priced[]>();
  for (const p of priced) {
    const key = keyOf(p.position, by);
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }

  const rows = [...groups.entries()].map(([key, members]) => row(key, members));
  if (by === 'expiry') {
    const order = EXPIRY_BUCKETS.map((b) => b.label);
    rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  } else {
    rows.sort((a, b) => Math.abs(b.dollarDelta) - Math.abs(a.dollarDelta));
  }
  return { rows, total: row('total', priced) };
}

function row(key: string, members: readonly Priced[]): GreekRow {
  const underliers = [...new Set(members.map((m) => m.position.underlier))].sort();
  const out: GreekRow = {
    key,
    positions: members.map((m) => m.position.id),
    dollarDelta: 0,
    dollarGammaPerPct: 0,
    vegaPerVolPoint: 0,
    thetaPerDay: 0,
    value: 0,
    underliers,
  };
  for (const m of members) {
    out.dollarDelta += m.delta * m.spot;
    // Shares per dollar, times the dollar size of a one percent move, times
    // spot again to turn the change in shares into a change in dollars.
    out.dollarGammaPerPct += m.gamma * m.spot * m.spot * 0.01;
    // The engine's vega is per 1.00 of vol and its theta per year.
    out.vegaPerVolPoint += m.vega / 100;
    out.thetaPerDay += m.theta / 365;
    out.value += m.value;
  }
  if (underliers.length === 1) {
    out.shareDelta = members.reduce((a, m) => a + m.delta, 0);
  }
  return out;
}
