/**
 * The instrument reference layer (PRD 5.1).
 *
 * > Everything resolves through a canonical instrument model keyed by an
 * > internal ID, with mappings to figi, isin, cusip, ticker+mic, and
 * > chain-native identifiers (contract address + chain ID).
 *
 * "Everything resolves through" is the load-bearing phrase. Several packages
 * already take a `ReferenceResolver` and hand it a mention; this is the thing
 * they were all resolving against, and it has two jobs that pull against each
 * other.
 *
 * ## It refuses identifiers that cannot be right
 *
 * ISIN, CUSIP and FIGI carry check digits. An identifier that fails its own
 * check digit is a transcription error, and admitting one means every series,
 * every position and every entitlement keyed to it is keyed to a security that
 * does not exist. The check is cheap and it is at the door: `register` throws
 * rather than storing it.
 *
 * What it cannot check is whether a *valid* identifier names the security the
 * caller meant. A check digit catches a typo, not a mix-up.
 *
 * ## It resolves tickers as of a date, because tickers are reused
 *
 * This is the one that matters and it is invisible until it bites. A ticker is
 * a lease, not a name. `FB` became `META` — a rename, which is the easy case,
 * because the internal id carries through. The hard case is a symbol freed and
 * re-let to a different issuer: a backtest resolving it as of 2019 must get the
 * company that held it in 2019, and a registry that resolves tickers against
 * "now" hands back whoever holds it today. That is a look-ahead of exactly the
 * kind the bitemporal layer exists to prevent, arriving through the reference
 * layer instead of through the price series, and it is silent.
 *
 * So a ticker listing carries a validity window and `resolveTicker` takes an
 * as-of. Resolving without one is not forbidden — an analyst typing in a search
 * box means today — but it is a different call, `resolveTickerNow`, so the
 * choice is made rather than defaulted into.
 *
 * ## Ambiguity produces candidates, never a guess
 *
 * A bare ticker is ambiguous across venues: `MU` is Micron on XNAS and Micron
 * on XFRA, and they are different listings of the same issuer with different
 * currencies and different closing times. Resolution returns every match and
 * the caller disambiguates — which is the same contract `canvas-ink`'s semantic
 * pass already has, where an ambiguous mention produces a chip and not a chart.
 */

import type { Instant } from './bitemporal.js';

export type AssetClass =
  | 'equity'
  | 'etf'
  | 'option'
  | 'future'
  | 'bond'
  | 'fx'
  | 'crypto'
  | 'index';

/** A listing: one venue's quotation of an instrument, with its validity window. */
export interface Listing {
  /** ISO 10383 Market Identifier Code, e.g. `XNAS`. */
  mic: string;
  ticker: string;
  currency: string;
  /** Inclusive. Absent means "since before the registry's history". */
  from?: Instant;
  /** Exclusive. Absent means current. */
  until?: Instant;
}

/** A token, keyed the way a chain keys it. */
export interface ChainRef {
  chainId: number;
  /** Contract address, lower-cased on ingest so a checksum spelling matches. */
  address: string;
}

export interface Instrument {
  /** The internal id everything else keys on. Opaque and permanent. */
  id: string;
  assetClass: AssetClass;
  name: string;
  figi?: string;
  isin?: string;
  cusip?: string;
  listings: Listing[];
  chain?: ChainRef;
}

// ---------------------------------------------------------------------------
// Check digits
// ---------------------------------------------------------------------------

function characterValue(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  // CUSIP admits three punctuation characters in its body.
  if (ch === '*') return 36;
  if (ch === '@') return 37;
  if (ch === '#') return 38;
  return -1;
}

/**
 * The double-add-double sum CUSIP and FIGI share.
 *
 * Positions are doubled from the *second* character, and a doubled value above
 * nine contributes its digit sum rather than itself.
 */
function doubleAddDouble(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = characterValue(body[i] as string);
    if (value < 0) return Number.NaN;
    const weighted = i % 2 === 1 ? value * 2 : value;
    sum += Math.floor(weighted / 10) + (weighted % 10);
  }
  return (10 - (sum % 10)) % 10;
}

/** ISIN: expand every character to its numeric value, then Luhn from the right. */
export function isinCheckDigit(body: string): number {
  let digits = '';
  for (const ch of body) {
    const value = characterValue(ch);
    if (value < 0) return Number.NaN;
    digits += String(value);
  }
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Twelve characters: two-letter country, nine alphanumeric, one check digit. */
export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  return isinCheckDigit(isin.slice(0, 11)) === Number(isin[11]);
}

/** Nine characters: eight of body, one check digit. */
export function isValidCusip(cusip: string): boolean {
  if (!/^[A-Z0-9*@#]{8}[0-9]$/.test(cusip)) return false;
  return doubleAddDouble(cusip.slice(0, 8)) === Number(cusip[8]);
}

/**
 * Twelve characters, `G` in third position, and a check digit.
 *
 * The two-character prefix excludes the codes that collide with ISO country
 * codes — the specification reserves them so a FIGI can never be mistaken for
 * the head of an ISIN.
 */
const FIGI_RESERVED_PREFIXES = new Set(['BS', 'BM', 'GG', 'GB', 'GH', 'KY', 'VG']);

export function isValidFigi(figi: string): boolean {
  if (!/^[B-DF-HJ-NP-TV-Z]{2}G[A-Z0-9]{8}[0-9]$/.test(figi)) return false;
  if (FIGI_RESERVED_PREFIXES.has(figi.slice(0, 2))) return false;
  return doubleAddDouble(figi.slice(0, 11)) === Number(figi[11]);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export type IdentifierKind = 'id' | 'figi' | 'isin' | 'cusip' | 'ticker' | 'chain';

export class InvalidIdentifier extends Error {
  constructor(
    readonly kind: IdentifierKind,
    readonly value: string,
    reason: string,
  ) {
    super(`${kind} ${value} is not valid: ${reason}`);
    this.name = 'InvalidIdentifier';
  }
}

export class DuplicateIdentifier extends Error {
  constructor(
    readonly kind: IdentifierKind,
    readonly value: string,
    readonly heldBy: string,
  ) {
    super(`${kind} ${value} is already held by ${heldBy}`);
    this.name = 'DuplicateIdentifier';
  }
}

export interface Candidate {
  instrument: Instrument;
  /** The listing that matched, for a ticker resolution. */
  listing?: Listing;
}

function withinWindow(listing: Listing, at: Instant): boolean {
  if (listing.from !== undefined && at < listing.from) return false;
  if (listing.until !== undefined && at >= listing.until) return false;
  return true;
}

/**
 * The canonical instrument model.
 *
 * Every lookup returns candidates rather than an instrument, including the ones
 * that can only match once. A caller that has to write `[0]` is a caller who
 * has seen that the answer might not be unique; a caller handed an instrument
 * directly has not, and the day a second match appears is the day it silently
 * takes the wrong one.
 */
export class InstrumentRegistry {
  private readonly byId = new Map<string, Instrument>();
  private readonly byFigi = new Map<string, string>();
  private readonly byIsin = new Map<string, string>();
  private readonly byCusip = new Map<string, string>();
  private readonly byChain = new Map<string, string>();
  /** Ticker, upper-cased, to every instrument that has ever listed under it. */
  private readonly byTicker = new Map<string, string[]>();

  get size(): number {
    return this.byId.size;
  }

  /**
   * Add an instrument, refusing anything that fails its own check digit.
   *
   * A valid identifier can still name the wrong security — a check digit
   * catches a typo, not a mix-up — so this is a floor and not a guarantee.
   */
  register(instrument: Instrument): Instrument {
    const { id, figi, isin, cusip, chain } = instrument;
    if (id.trim() === '') throw new InvalidIdentifier('id', id, 'an instrument needs an id');
    if (this.byId.has(id)) throw new DuplicateIdentifier('id', id, id);

    if (figi !== undefined) {
      if (!isValidFigi(figi)) throw new InvalidIdentifier('figi', figi, 'check digit or shape');
      const held = this.byFigi.get(figi);
      if (held !== undefined) throw new DuplicateIdentifier('figi', figi, held);
    }
    if (isin !== undefined) {
      if (!isValidIsin(isin)) throw new InvalidIdentifier('isin', isin, 'check digit or shape');
      const held = this.byIsin.get(isin);
      if (held !== undefined) throw new DuplicateIdentifier('isin', isin, held);
    }
    if (cusip !== undefined) {
      if (!isValidCusip(cusip)) throw new InvalidIdentifier('cusip', cusip, 'check digit or shape');
      const held = this.byCusip.get(cusip);
      if (held !== undefined) throw new DuplicateIdentifier('cusip', cusip, held);
    }

    const stored: Instrument = {
      ...instrument,
      listings: instrument.listings.map((l) => ({ ...l, ticker: l.ticker.toUpperCase(), mic: l.mic.toUpperCase() })),
      ...(chain ? { chain: { chainId: chain.chainId, address: chain.address.toLowerCase() } } : {}),
    };

    this.byId.set(id, stored);
    if (figi !== undefined) this.byFigi.set(figi, id);
    if (isin !== undefined) this.byIsin.set(isin, id);
    if (cusip !== undefined) this.byCusip.set(cusip, id);
    if (stored.chain) {
      const key = chainKey(stored.chain.chainId, stored.chain.address);
      const held = this.byChain.get(key);
      if (held !== undefined) throw new DuplicateIdentifier('chain', key, held);
      this.byChain.set(key, id);
    }
    for (const listing of stored.listings) {
      const existing = this.byTicker.get(listing.ticker) ?? [];
      if (!existing.includes(id)) existing.push(id);
      this.byTicker.set(listing.ticker, existing);
    }
    return stored;
  }

  byInternalId(id: string): Instrument | undefined {
    return this.byId.get(id);
  }

  /** Resolve by a unique identifier. At most one candidate, by construction. */
  resolveIdentifier(kind: 'figi' | 'isin' | 'cusip', value: string): Candidate[] {
    const index =
      kind === 'figi' ? this.byFigi : kind === 'isin' ? this.byIsin : this.byCusip;
    const id = index.get(value.toUpperCase());
    const instrument = id === undefined ? undefined : this.byId.get(id);
    return instrument ? [{ instrument }] : [];
  }

  resolveChain(chainId: number, address: string): Candidate[] {
    const id = this.byChain.get(chainKey(chainId, address.toLowerCase()));
    const instrument = id === undefined ? undefined : this.byId.get(id);
    return instrument ? [{ instrument }] : [];
  }

  /**
   * Resolve a ticker as of a date.
   *
   * The `at` is not optional and it is not defaulted, because a ticker is a
   * lease rather than a name: a symbol freed by one issuer and re-let to
   * another resolves to different companies on different dates, and a backtest
   * that resolved against "now" would be reading the present into the past.
   *
   * `mic` narrows to a venue. Without it a cross-listed name returns every
   * listing, which is the honest answer — they are different securities with
   * different currencies and different closing times.
   */
  resolveTicker(ticker: string, at: Instant, mic?: string): Candidate[] {
    const ids = this.byTicker.get(ticker.toUpperCase()) ?? [];
    const wantedMic = mic?.toUpperCase();
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const instrument = this.byId.get(id);
      if (!instrument) continue;
      for (const listing of instrument.listings) {
        if (listing.ticker !== ticker.toUpperCase()) continue;
        if (wantedMic !== undefined && listing.mic !== wantedMic) continue;
        if (!withinWindow(listing, at)) continue;
        candidates.push({ instrument, listing });
      }
    }
    return candidates;
  }

  /**
   * Resolve a ticker as it stands today.
   *
   * A separate entry point rather than a default, so choosing "now" is a
   * decision somebody made rather than one they fell into. An analyst typing
   * into a search box means today; a backtest does not.
   */
  resolveTickerNow(ticker: string, now: Instant, mic?: string): Candidate[] {
    return this.resolveTicker(ticker, now, mic);
  }

  /**
   * Every ticker an instrument has traded under, oldest window first.
   *
   * The rename case: `FB` and `META` are the same internal id, and an analyst
   * looking at a ten-year chart wants to know the label changed under them.
   */
  historyOf(id: string): Listing[] {
    const instrument = this.byId.get(id);
    if (!instrument) return [];
    return [...instrument.listings].sort((a, b) => (a.from ?? '') < (b.from ?? '') ? -1 : 1);
  }

  /** Every instrument, for a palette or a universe. */
  all(): Instrument[] {
    return [...this.byId.values()];
  }
}

function chainKey(chainId: number, address: string): string {
  return `${chainId}:${address}`;
}
