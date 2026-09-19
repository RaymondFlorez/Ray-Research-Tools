/**
 * Egress control (PRD 7.2).
 *
 * "The AI router refuses to dispatch `positions` or `mnpi_risk` content to any
 * external endpoint. Independently, an egress proxy in front of all outbound
 * vendor calls scans payloads for tenant position fingerprints and blocks on
 * match. Two independent controls, because the router runs code that agents
 * can influence and the proxy does not."
 *
 * The word doing the work is *independently*, and it is not satisfied by
 * calling the same function from two places. The two controls here fail
 * differently on purpose:
 *
 * - The **router gate** reads the classification stamp. It cannot be fooled by
 *   encoding, obfuscation or paraphrase, because it never looks at the bytes.
 *   It can be fooled by a wrong stamp — and agents influence what gets
 *   assembled into a prompt, so a wrong stamp is reachable.
 * - The **proxy** reads the bytes and knows nothing about stamps. It cannot be
 *   fooled by a wrong stamp. It can be fooled by encoding, because a scanner
 *   that only sees base64 sees nothing.
 *
 * Each covers the other's blind spot, which is the only sense in which two
 * controls are worth more than one. The tests assert both directions: a
 * compromised router that dispatches anyway is still stopped at the wire, and
 * an encoded payload that walks past the scanner is still stopped by the stamp.
 */

import type { Model } from '@picasso/canvas-router';
import { combine, mustStayInTenant, type Classification } from './classification.js';

export type EgressDecision =
  | { allowed: true }
  | { allowed: false; control: 'router' | 'proxy'; reason: string; detail?: string[] };

// ---------------------------------------------------------------------------
// Control one: the router gate
// ---------------------------------------------------------------------------

export interface DispatchRequest {
  modelId: string;
  /** Where the model runs. `vendor` crosses the tenant boundary. */
  placement: Model['placement'];
  /** Classification of every piece of context assembled into the prompt. */
  contextClasses: readonly Classification[];
  tenantId: string;
}

/**
 * Placements that are inside the tenant boundary.
 *
 * An allowlist, and the distinction is not pedantry. The first version asked
 * `placement !== 'vendor'` and allowed everything else, which reads the same
 * until a placement arrives that is neither — a new deployment mode, a stale
 * record, a field from a service built against a different version of this
 * enum. Allow-by-negation says yes to all of them. The two names below are the
 * two machines we actually control, and anything not on this list crosses the
 * boundary until someone adds it here deliberately.
 *
 * This is not the per-vendor allowlist the note used to warn about: that would
 * be a list of counterparties trusted with position data, which grows. This is
 * a list of places the data physically sits, which does not.
 */
const INSIDE_BOUNDARY: ReadonlySet<string> = new Set<string>(['on_device', 'self_hosted']);

/**
 * Refuse tenant-bound content to anything off-premises.
 *
 * The test is on the placement, never on the vendor's name.
 */
export function routerGate(request: DispatchRequest): EgressDecision {
  const worst = combine(request.contextClasses);
  if (INSIDE_BOUNDARY.has(request.placement)) return { allowed: true };
  if (!mustStayInTenant(worst)) return { allowed: true };
  return {
    allowed: false,
    control: 'router',
    reason: `context is classified ${worst} and ${request.modelId} runs at placement ${request.placement}, outside the tenant boundary`,
  };
}

// ---------------------------------------------------------------------------
// Control two: the proxy
// ---------------------------------------------------------------------------

export interface Position {
  symbol: string;
  /** Signed; a short is as identifying as a long. */
  quantity: number;
}

/**
 * A quantity is distinctive when knowing it would identify the holder.
 *
 * 100 shares of AAPL is not a fingerprint — it is the most common position
 * size in the world, and blocking every payload that mentions AAPL near 100
 * would take the proxy offline within a day. 12,450 shares is a fingerprint.
 * The line is three or more significant digits and not a round multiple.
 */
export function isDistinctive(quantity: number): boolean {
  const q = Math.abs(quantity);
  if (!Number.isFinite(q) || q === 0) return false;
  if (q % 100 === 0 && q <= 100_000) return false;
  if (q % 1000 === 0) return false;
  return significantDigits(q) >= 3;
}

function significantDigits(q: number): number {
  const s = String(q).replace(/[^0-9]/g, '').replace(/0+$/, '');
  return s.length;
}

/** FNV-1a. Not a privacy boundary — see the note on `PositionFingerprints`. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** How close a symbol and a number must be to count as a pair, in characters. */
export const PAIR_WINDOW = 80;

/** Non-distinctive pair matches needed before the payload is a portfolio dump. */
export const WEAK_MATCH_THRESHOLD = 3;

export interface Match {
  symbol: string;
  quantity: number;
  distinctive: boolean;
  at: number;
}

/**
 * The tenant's holdings, reduced to digests.
 *
 * The proxy sits in front of vendor calls and should not hold the position
 * book, so it holds hashes of `SYMBOL|quantity` instead. This is a blast-radius
 * measure, not a privacy guarantee: the preimage space of a ticker and a share
 * count is small enough to enumerate, and anyone claiming otherwise has not
 * tried. What it buys is that a proxy log, a heap dump or a config leak does
 * not hand over the book in readable form.
 */
export class PositionFingerprints {
  private readonly symbols = new Set<string>();
  private readonly pairs = new Map<string, boolean>();

  constructor(positions: readonly Position[]) {
    for (const position of positions) {
      const symbol = position.symbol.toUpperCase();
      this.symbols.add(digest(symbol));
      const quantity = Math.abs(position.quantity);
      this.pairs.set(digest(`${symbol}|${quantity}`), isDistinctive(quantity));
    }
  }

  get size(): number {
    return this.pairs.size;
  }

  /**
   * Every holding of this tenant that the payload states.
   *
   * Symbols and numbers are read out of the text and paired inside a window,
   * rather than crossed globally: in a long document every ticker would
   * otherwise pair with every number, and a 200-number filing would match
   * something by chance.
   */
  scan(payload: string): Match[] {
    // Case-insensitive, and folded before the digest. The constructor
    // upper-cases on ingest, so matching had to as well — it did not, and an
    // all-lowercase dump was invisible: `\b[A-Z]{1,6}\b` never matched `nvda`,
    // `symbols` came back empty, and the scan returned before the number pass
    // ever ran. `Nvda` failed for the same reason.
    //
    // The cost is that a ticker which is also an ordinary word — IT, ALL, KEY,
    // ON — now matches in lowercase prose. That is the right side to err on:
    // a match still needs the ticker *and* an exact holding quantity within
    // the pairing window, so prose alone does not trip it, while a reformatted
    // position dump no longer walks through.
    const symbols = [...payload.matchAll(/\b[A-Za-z]{1,6}(?:[.-][A-Za-z]{1,3})?\b/g)]
      .map((m) => ({ text: m[0].toUpperCase(), at: m.index }))
      .filter((s) => this.symbols.has(digest(s.text)));
    if (symbols.length === 0) return [];

    const numbers = [...payload.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)].map((m) => ({
      value: Math.abs(Number.parseFloat(m[0].replace(/,/g, ''))),
      at: m.index,
    }));

    const matches: Match[] = [];
    const seen = new Set<string>();
    for (const symbol of symbols) {
      for (const number of numbers) {
        if (Math.abs(number.at - symbol.at) > PAIR_WINDOW) continue;
        const key = digest(`${symbol.text}|${number.value}`);
        const distinctive = this.pairs.get(key);
        if (distinctive === undefined) continue;
        const dedupe = `${symbol.text}|${number.value}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        matches.push({ symbol: symbol.text, quantity: number.value, distinctive, at: symbol.at });
      }
    }
    return matches;
  }
}

export interface ProxyRequest {
  tenantId: string;
  /** The serialized body, exactly as it would go on the wire. */
  payload: string;
  /** For the audit record. The proxy does not consult it. */
  destination: string;
}

/**
 * The egress proxy.
 *
 * It deliberately takes no classification, no model id and no task class. The
 * argument for two controls collapses the moment the second one starts reading
 * the first one's inputs: a bad stamp would then defeat both.
 */
export class EgressProxy {
  constructor(private readonly fingerprints: ReadonlyMap<string, PositionFingerprints>) {}

  check(request: ProxyRequest): EgressDecision {
    const book = this.fingerprints.get(request.tenantId);
    if (!book) return { allowed: true };
    const matches = book.scan(request.payload);
    if (matches.length === 0) return { allowed: true };

    const distinctive = matches.filter((m) => m.distinctive);
    if (distinctive.length === 0 && matches.length < WEAK_MATCH_THRESHOLD) {
      return { allowed: true };
    }
    return {
      allowed: false,
      control: 'proxy',
      reason:
        distinctive.length > 0
          ? `payload states ${distinctive.length} distinctive position${distinctive.length === 1 ? '' : 's'} held by ${request.tenantId}`
          : `payload states ${matches.length} positions held by ${request.tenantId}`,
      detail: matches.map((m) => `${m.symbol} ${m.quantity}`),
    };
  }
}

/**
 * Both controls, in the order they sit on the path.
 *
 * Reported separately so an audit record can say which one fired. A request
 * both would refuse is attributed to the router, because that is where it is
 * actually stopped, and a record saying otherwise would misdescribe the
 * deployment.
 */
export function checkEgress(
  dispatch: DispatchRequest,
  proxy: EgressProxy,
  payload: string,
  destination: string,
): EgressDecision {
  const gate = routerGate(dispatch);
  if (!gate.allowed) return gate;
  return proxy.check({ tenantId: dispatch.tenantId, payload, destination });
}
