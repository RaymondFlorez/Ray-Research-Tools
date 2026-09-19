/**
 * The two fingerprint scanners, checked against each other.
 *
 * The codebase ships two implementations of "the egress proxy scans payloads
 * for tenant position fingerprints":
 *
 * - `canvas-guard`'s `PositionFingerprints`, which tokenizes the payload into
 *   symbols and numbers and pairs them inside a window.
 * - `canvas-data`'s `scanForFingerprints`, which takes opaque fingerprint
 *   strings and looks for their parts inside a window of a normalized copy.
 *
 * They exist for different callers — one holds the position book, the other
 * holds only hashes handed to it — and neither can be expressed in terms of the
 * other without one of them learning something it deliberately does not know.
 * What they must not do is disagree about whether a payload states a holding,
 * because then the answer depends on which import a caller reached for. A
 * review found exactly that: the same reformatted position dump was blocked by
 * one and waved through by the other, and no test in either package could see
 * it, because each package only tests its own.
 *
 * So this file states the agreement as a test. It is the cheapest thing that
 * would have caught the divergence, and the only one that keeps catching it.
 */

import { describe, expect, it } from 'vitest';
import {
  EGRESS_CASES,
  EgressProxy,
  PositionFingerprints,
  TENANT_POSITIONS,
} from '@picasso/canvas-guard';
import { scanForFingerprints, type Fingerprint } from '@picasso/canvas-data';

const proxy = new EgressProxy(new Map([['tenant-a', new PositionFingerprints(TENANT_POSITIONS)]]));

/**
 * The same book, in the form the other scanner takes.
 *
 * `canvas-data` is handed literal strings rather than a position list, so the
 * book is rendered the way a report would render it. Which spelling is chosen
 * should not matter — that is the property under test.
 */
const fingerprints: Fingerprint[] = TENANT_POSITIONS.map((p) => ({
  label: `position:${p.symbol}`,
  value: `${p.symbol} ${Math.abs(p.quantity).toLocaleString('en-US')}`,
}));

function guardBlocks(payload: string): boolean {
  return !proxy.check({ tenantId: 'tenant-a', payload, destination: 'https://vendor.example' })
    .allowed;
}

function dataBlocks(payload: string): boolean {
  return !scanForFingerprints(payload, fingerprints).clean;
}

describe('the two fingerprint scanners agree', () => {
  // Only the cases the red-team corpus expects the *proxy* to catch. The ones
  // it expects the router to catch are stopped by the stamp, which neither
  // scanner reads, and the ones expected to pass are asserted separately below.
  const proxyCases = EGRESS_CASES.filter((c) => c.expect === 'proxy');

  it('has cases to compare', () => {
    expect(proxyCases.length).toBeGreaterThanOrEqual(6);
  });

  for (const testCase of proxyCases) {
    it(`both block ${testCase.id}`, () => {
      expect(guardBlocks(testCase.payload), 'canvas-guard').toBe(true);
      expect(dataBlocks(testCase.payload), 'canvas-data').toBe(true);
    });
  }

  // The agreement is one-directional, and the direction is the safe one:
  // nothing the guard proxy blocks may be passed by the data scanner. The
  // reverse is allowed, and one corpus case exercises it.
  //
  // `round_lot_only` — "a retail investor holding 100 shares of AAPL" — is
  // passed by the guard proxy on purpose: 100 shares is the most common
  // position size there is, and blocking every payload that mentions AAPL near
  // 100 takes the proxy offline within a day. The data scanner blocks it,
  // because it cannot know that the `100` in the fingerprint `AAPL 100` is a
  // share count. Its fingerprints are opaque strings — an account number, an
  // option label, a fund name — and in `NVDA Jan 1400 C` the round number is a
  // strike, where discarding it would be the bypass rather than the fix. One
  // scanner is handed the position book and can judge a quantity; the other is
  // handed hashes and cannot. That is the difference, and it resolves toward
  // over-blocking, which is the side to be wrong on for a control of last
  // resort that is not the one actually deployed in front of vendor calls.
  const STRICTER_IN_DATA_SCANNER = new Set(['round_lot_only']);

  for (const testCase of EGRESS_CASES.filter((c) => c.expect === 'allowed')) {
    it(`the guard proxy passes ${testCase.id}`, () => {
      expect(guardBlocks(testCase.payload)).toBe(false);
    });

    it(`the data scanner ${STRICTER_IN_DATA_SCANNER.has(testCase.id) ? 'is stricter on' : 'also passes'} ${testCase.id}`, () => {
      expect(dataBlocks(testCase.payload)).toBe(STRICTER_IN_DATA_SCANNER.has(testCase.id));
    });
  }

  // The safety direction, as a property over the whole corpus rather than case
  // by case: whatever the guard proxy stops, the other scanner stops too.
  it('never passes in the data scanner what the guard proxy blocks', () => {
    for (const testCase of EGRESS_CASES) {
      if (!guardBlocks(testCase.payload)) continue;
      expect(dataBlocks(testCase.payload), testCase.id).toBe(true);
    }
  });

  // The reformattings that got past one of them. Stated separately from the
  // corpus so the list can grow without the corpus having to.
  const holding = TENANT_POSITIONS[0]!;
  const symbol = holding.symbol;
  const qty = Math.abs(holding.quantity);
  const formatted = qty.toLocaleString('en-US');

  const spellings = [
    `${symbol} ${formatted}`,
    `${symbol.toLowerCase()} ${formatted}`,
    `${symbol[0]}${symbol.slice(1).toLowerCase()} ${formatted}`,
    `{"symbol":"${symbol}","qty":${qty}}`,
    `| ${symbol} | ${formatted} |`,
    `${symbol}: ${formatted} shares`,
    `${symbol}/${qty}`,
    `<td>${symbol}</td><td>${qty}</td>`,
    `symbol=${symbol};qty=${qty}`,
    `"quantity": ${qty}, "ticker": "${symbol}"`,
  ];

  for (const payload of spellings) {
    it(`both block ${JSON.stringify(payload)}`, () => {
      expect(guardBlocks(payload), 'canvas-guard').toBe(true);
      expect(dataBlocks(payload), 'canvas-data').toBe(true);
    });
  }

  it('neither blocks prose that states no quantity', () => {
    const prose = `${symbol} rallied into the print and the desk was constructive on it.`;
    expect(guardBlocks(prose), 'canvas-guard').toBe(false);
    expect(dataBlocks(prose), 'canvas-data').toBe(false);
  });
});
