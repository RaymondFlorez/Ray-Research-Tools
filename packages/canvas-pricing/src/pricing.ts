/**
 * The scalar surface: one option, priced.
 *
 * PRD 5.4. Everything here is a thin typed wrapper over a WASM call, and
 * deliberately so — the moment this file starts doing arithmetic of its own,
 * the bit-identity guarantee between client and server (PRD 7.1) stops holding,
 * because the server has no copy of this file.
 */

import type { PricingExports } from './module.js';

export type OptionKind = 'call' | 'put';

export interface OptionInputs {
  spot: number;
  strike: number;
  /** Years to expiry. */
  time: number;
  /** Continuously compounded risk-free rate. */
  rate: number;
  /** Continuous dividend yield. */
  dividend: number;
  /** Annualized volatility. */
  vol: number;
  kind: OptionKind;
}

/** PRD 5.4's ten. `price` rides along because the Greeks share its transcendentals. */
export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  vanna: number;
  volga: number;
  charm: number;
  speed: number;
}

const GREEK_ORDER = [
  'price', 'delta', 'gamma', 'vega', 'theta',
  'rho', 'vanna', 'volga', 'charm', 'speed',
] as const satisfies readonly (keyof Greeks)[];

/** Why a volatility could not be implied. Mirrors the crate's `SolveFailure`. */
export type ImpliedVolFailure =
  | 'below_intrinsic'
  | 'above_upper_bound'
  | 'degenerate'
  | 'no_convergence'
  | 'not_identifiable';

export type ImpliedVolResult =
  | { ok: true; vol: number }
  | { ok: false; reason: ImpliedVolFailure; display: string };

const FAILURES: readonly ImpliedVolFailure[] = [
  'below_intrinsic', 'above_upper_bound', 'degenerate',
  'no_convergence', 'not_identifiable',
];

/**
 * What a chain cell shows when there is no vol to show.
 *
 * Not one message for all five: an analyst who sees `--` learns the market
 * stopped quoting information, and one who sees "below intrinsic" learns the
 * quote is wrong. Collapsing them loses the distinction that matters.
 */
const DISPLAY: Record<ImpliedVolFailure, string> = {
  below_intrinsic: 'below intrinsic',
  above_upper_bound: 'above bound',
  degenerate: 'expired',
  no_convergence: 'no solution',
  not_identifiable: '--',
};

/** The pricing core, bound to one instantiated module. */
export class Pricer {
  constructor(readonly exports: PricingExports) {}

  private args(i: OptionInputs): [number, number, number, number, number, number, number] {
    return [i.spot, i.strike, i.time, i.rate, i.dividend, i.vol, i.kind === 'call' ? 1 : 0];
  }

  /** European, Black-Scholes-Merton. */
  price(inputs: OptionInputs): number {
    return this.exports.pc_price(...this.args(inputs));
  }

  /**
   * All ten Greeks.
   *
   * Ten boundary crossings rather than one, because the alternative is a
   * scratch buffer in linear memory and the grid path already exists for
   * anything where ten calls is the wrong shape.
   */
  greeks(inputs: OptionInputs): Greeks {
    const a = this.args(inputs);
    const out = {} as Greeks;
    for (let i = 0; i < GREEK_ORDER.length; i += 1) {
      out[GREEK_ORDER[i] as keyof Greeks] = this.exports.pc_greek(...a, i);
    }
    return out;
  }

  /** Bjerksund-Stensland 1993. Fast, and the guard measures how fast costs. */
  americanFast(inputs: OptionInputs): number {
    return this.exports.pc_american_fast(...this.args(inputs));
  }

  /** Leisen-Reimer lattice. The reference the guard checks against. */
  americanExact(inputs: OptionInputs): number {
    return this.exports.pc_american_exact(...this.args(inputs));
  }

  /** The 255-step lattice, for a position the analyst pinned as exact. */
  americanDetail(inputs: OptionInputs): number {
    return this.exports.pc_american_detail(...this.args(inputs));
  }

  /**
   * Implied volatility, or the reason there isn't one.
   *
   * `vol` on the input is ignored: it is what we are solving for. The signature
   * takes the full `OptionInputs` anyway so a caller can hand across the same
   * record it prices with, rather than assembling a second one that drifts.
   */
  impliedVol(inputs: Omit<OptionInputs, 'vol'>, marketPrice: number): ImpliedVolResult {
    const vol = this.exports.pc_implied_vol(
      inputs.spot, inputs.strike, inputs.time, inputs.rate, inputs.dividend,
      marketPrice, inputs.kind === 'call' ? 1 : 0,
    );
    if (!Number.isNaN(vol)) return { ok: true, vol };

    // Read the reason immediately: it is the module's record of the call just
    // made, and any other call into the module may overwrite it.
    const code = this.exports.pc_implied_vol_reason();
    const reason = FAILURES[code - 1] ?? 'no_convergence';
    return { ok: false, reason, display: DISPLAY[reason] };
  }

  /** Exported for the parity harness: the primitive most likely to differ. */
  normalCdf(x: number): number {
    return this.exports.pc_norm_cdf(x);
  }
}
