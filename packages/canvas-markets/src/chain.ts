/**
 * Crypto: market and on-chain (PRD 5.5).
 *
 * The section's own statement of what matters:
 *
 * "Ingested via node RPC plus an indexer, **normalized into the same `series`
 * type as everything else, which is the point: a crypto on-chain series and an
 * equity fundamental series wire into the same regression node.**"
 *
 * That is a claim about types, not about plumbing, and it is checkable. The
 * nodes here emit ordinary `series` ports with ordinary `PortMetadata`, and
 * `test/chain.test.ts` wires a `ChainMetricNode` into the same `TransformNode`
 * input that accepts a quarterly fundamental series, through canvas-core's
 * real `connect`. If the claim were false the connection would be rejected,
 * and no amount of prose here would fix it.
 *
 * The one place crypto genuinely differs is frequency: an on-chain metric is
 * per-block, a fundamental is quarterly. `canvas-core` does not paper over
 * that — it rejects the connection and hands back a named `resample` fix for
 * the analyst to accept, because aggregating daily gas prices to a quarter is
 * a choice between mean, last and sum that nobody else can make. So these
 * nodes declare their real frequency and let the rejection happen, rather than
 * pre-aggregating to something convenient and calling it a series.
 *
 * I had this backwards first, and wrote that the lattice would silently insert
 * the adapter. The only implicit coercion in the whole type lattice is
 * `series -> scalar`, and the comment above it says why: a silent conversion is
 * a silent assumption.
 */

import {
  createNode,
  type Frequency,
  type PicassoNode,
  type Port,
  type PortMetadata,
} from '@picasso/canvas-core';

// ---------------------------------------------------------------------------
// Market structure
// ---------------------------------------------------------------------------

export interface PerpQuote {
  venue: string;
  /** Perpetual mark. */
  perp: number;
  /** Spot reference on the same venue or an index. */
  spot: number;
  /** Funding paid per interval, as a rate. */
  fundingRate: number;
  /** Hours between funding payments. Venues differ, and it matters. */
  fundingIntervalHours: number;
  openInterest?: number;
}

export interface BasisReading {
  venue: string;
  /** Perp premium over spot, as a fraction. */
  basis: number;
  /** Funding annualized at the venue's own interval. */
  fundingAnnualized: number;
  /**
   * Annualized basis minus annualized funding.
   *
   * The number a cash-and-carry trade actually earns, and the reason both
   * legs have to be annualized on the venue's own schedule: an eight-hour
   * venue pays three times a day and a one-hour venue pays twenty-four, so
   * comparing raw funding rates across venues compares different things.
   */
  carry: number;
}

export const HOURS_PER_YEAR = 24 * 365;

export function basis(quote: PerpQuote): BasisReading {
  const premium = quote.spot === 0 ? Number.NaN : quote.perp / quote.spot - 1;
  const periodsPerYear = HOURS_PER_YEAR / quote.fundingIntervalHours;
  const fundingAnnualized = quote.fundingRate * periodsPerYear;
  return {
    venue: quote.venue,
    basis: premium,
    fundingAnnualized,
    carry: premium - fundingAnnualized,
  };
}

// ---------------------------------------------------------------------------
// Token unlocks as dated events
// ---------------------------------------------------------------------------

export interface VestingTranche {
  /** Cliff or linear release date. */
  at: string;
  tokens: number;
  recipient: 'team' | 'investors' | 'treasury' | 'community' | 'ecosystem';
}

export interface UnlockEvent {
  at: string;
  tokens: number;
  recipient: VestingTranche['recipient'];
  /** Unlocked supply as a fraction of circulating supply on that date. */
  shareOfFloat: number;
  /** Days of average volume the unlock represents. */
  daysOfVolume?: number;
}

/**
 * "`TokenUnlockNode` (vesting schedules as dated `event` outputs)".
 *
 * The output is an `event` port rather than a `series` because that is what it
 * is: a schedule of dated things, not a sampled quantity. Emitting it as a
 * daily series of mostly zeros would let it wire into a regression node, and
 * regressing a return on a column of zeros with occasional spikes is a way to
 * get a confident coefficient out of four observations.
 *
 * `shareOfFloat` is the number that means anything. Ten million tokens is not
 * a fact about anything until it is ten million against a float of forty.
 */
export function unlockSchedule(
  tranches: readonly VestingTranche[],
  circulatingSupply: (at: string) => number,
  averageDailyVolume?: (at: string) => number,
): UnlockEvent[] {
  return [...tranches]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((tranche) => {
      const float = circulatingSupply(tranche.at);
      const volume = averageDailyVolume?.(tranche.at);
      return {
        at: tranche.at,
        tokens: tranche.tokens,
        recipient: tranche.recipient,
        shareOfFloat: float > 0 ? tranche.tokens / float : Number.NaN,
        ...(volume !== undefined && volume > 0
          ? { daysOfVolume: tranche.tokens / volume }
          : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// The nodes
// ---------------------------------------------------------------------------

export type ChainMetric =
  | 'exchange_inflow'
  | 'exchange_outflow'
  | 'active_addresses'
  | 'stablecoin_supply'
  | 'fees_paid'
  | 'gas_price'
  | 'staking_queue'
  | 'unstaking_queue'
  | 'bridge_flow'
  | 'mev_extracted';

/** A `series` output port, built the same way any other node builds one. */
function seriesOutput(name: string, emits: PortMetadata): Port {
  return {
    id: 'out',
    name,
    type: 'series',
    cardinality: 'one',
    required: false,
    emits,
  };
}

export interface ChainMetricInput {
  id: string;
  chainId: number;
  metric: ChainMetric;
  /** Per-block data resampled to this frequency by the indexer. */
  frequency: Frequency;
  /** Units the series is denominated in, for the port's currency check. */
  currency?: string;
  history?: number;
}

/**
 * `ChainMetricNode`.
 *
 * Note what is *not* here: a crypto-specific port type, a crypto-specific
 * frequency, or a bespoke metadata shape. The whole value of the section's
 * claim is that this node is boring.
 */
export function chainMetricNode(input: ChainMetricInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'ChainMetricNode',
    binding: 'wired',
    outputs: [
      seriesOutput(input.metric.replace(/_/g, ' '), {
        frequency: input.frequency,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.history !== undefined ? { history: input.history } : {}),
        assetClass: 'crypto',
      }),
    ],
    params: { chainId: input.chainId, metric: input.metric },
  });
}

export interface FundingBasisInput {
  id: string;
  instrument: string;
  venue: string;
  frequency: Frequency;
  history?: number;
}

export function fundingBasisNode(input: FundingBasisInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'ChainMetricNode',
    binding: 'wired',
    outputs: [
      seriesOutput('carry', {
        frequency: input.frequency,
        ...(input.history !== undefined ? { history: input.history } : {}),
        assetClass: 'crypto',
      }),
    ],
    params: { instrument: input.instrument, venue: input.venue, metric: 'funding_basis_carry' },
  });
}

export interface ProtocolRevenueInput {
  id: string;
  protocol: string;
  currency: string;
  frequency: Frequency;
  history?: number;
}

/**
 * `ProtocolRevenueNode`.
 *
 * Denominated in a real currency on purpose. Protocol revenue quoted in the
 * protocol's own token is a quantity that moves when the token moves, which
 * makes every ratio built on it circular — and a currency-stamped port is what
 * lets `canvas-core` reject a mismatched wire and name the conversion, instead
 * of letting two denominations meet silently.
 */
export function protocolRevenueNode(input: ProtocolRevenueInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'ChainMetricNode',
    binding: 'wired',
    outputs: [
      seriesOutput('protocol revenue', {
        frequency: input.frequency,
        currency: input.currency,
        ...(input.history !== undefined ? { history: input.history } : {}),
        assetClass: 'crypto',
      }),
    ],
    params: { protocol: input.protocol, metric: 'protocol_revenue' },
  });
}

export interface TokenUnlockInput {
  id: string;
  token: string;
  tranches: readonly VestingTranche[];
}

export function tokenUnlockNode(input: TokenUnlockInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'ChainMetricNode',
    binding: 'wired',
    outputs: [
      {
        id: 'out',
        name: 'unlocks',
        type: 'event',
        cardinality: 'many',
        required: false,
      },
    ],
    params: { token: input.token, tranches: input.tranches.length },
  });
}
