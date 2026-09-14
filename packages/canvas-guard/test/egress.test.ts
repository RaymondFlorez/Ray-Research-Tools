import { describe, expect, it } from 'vitest';
import {
  EgressProxy,
  PAIR_WINDOW,
  PositionFingerprints,
  checkEgress,
  isDistinctive,
  routerGate,
  type Position,
} from '../src/egress.js';
import { EGRESS_CASES, TENANT_POSITIONS, runEgressFamily } from '../src/redteam.js';

const book: readonly Position[] = TENANT_POSITIONS;
const proxy = new EgressProxy(new Map([['tenant-a', new PositionFingerprints(book)]]));

function check(payload: string) {
  return proxy.check({ tenantId: 'tenant-a', payload, destination: 'https://vendor.example' });
}

describe('the router gate', () => {
  it('refuses tenant-bound context to an off-premises model', () => {
    const decision = routerGate({
      modelId: 'frontier-a',
      placement: 'vendor',
      contextClasses: ['public', 'positions'],
      tenantId: 'tenant-a',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.control).toBe('router');
  });

  it('allows the same context to a self-hosted model', () => {
    expect(
      routerGate({
        modelId: 'open-70b',
        placement: 'self_hosted',
        contextClasses: ['positions', 'mnpi_risk'],
        tenantId: 'tenant-a',
      }).allowed,
    ).toBe(true);
  });

  // Tested on the placement, never on the vendor's name: an allowlist of
  // approved vendors is a list somebody eventually adds to.
  it('allows public context off-premises', () => {
    expect(
      routerGate({
        modelId: 'frontier-a',
        placement: 'vendor',
        contextClasses: ['public', 'licensed'],
        tenantId: 'tenant-a',
      }).allowed,
    ).toBe(true);
  });
});

describe('what counts as a fingerprint', () => {
  // 100 shares of AAPL is the most common position size in the world.
  it('excludes round lots, which would take the proxy offline within a day', () => {
    expect(isDistinctive(100)).toBe(false);
    expect(isDistinctive(1000)).toBe(false);
    expect(isDistinctive(2400)).toBe(false);
    expect(isDistinctive(12_450)).toBe(true);
    expect(isDistinctive(-3_817)).toBe(true);
  });
});

describe('the proxy', () => {
  it('blocks on a single distinctive holding stated in the payload', () => {
    const decision = check('The fund holds 12,450 shares of NVDA.');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.control).toBe('proxy');
  });

  it('matches a short position by magnitude, because a short is as identifying as a long', () => {
    expect(check('SOXL exposure of 3,817 units').allowed).toBe(false);
  });

  it('passes public commentary that mentions the same tickers', () => {
    expect(
      check('NVDA fell 4.1% to 118.50 and SOXL slid 9.6% while MSFT was flat at 412.30.').allowed,
    ).toBe(true);
  });

  it('passes a round lot mentioned near its ticker', () => {
    expect(check('A retail investor holding 100 shares of AAPL saw a 4% move.').allowed).toBe(true);
  });

  // In a long document every ticker would otherwise pair with every number,
  // and a filing with two hundred numbers would match something by chance.
  it('does not pair a symbol with a number on the far side of the document', () => {
    const far = `NVDA leads the sector.${' filler.'.repeat(PAIR_WINDOW)} and 12,450 of something else`;
    expect(check(far).allowed).toBe(true);
  });

  it('blocks a dump of round lots once three of them appear together', () => {
    const roundBook = new EgressProxy(
      new Map([
        [
          'tenant-a',
          new PositionFingerprints([
            { symbol: 'AAPL', quantity: 100 },
            { symbol: 'MSFT', quantity: 2400 },
            { symbol: 'NVDA', quantity: 500 },
          ]),
        ],
      ]),
    );
    const decision = roundBook.check({
      tenantId: 'tenant-a',
      payload: 'Holdings: AAPL 100, MSFT 2,400, NVDA 500.',
      destination: 'x',
    });
    expect(decision.allowed).toBe(false);
  });

  it('knows nothing about tenants it holds no book for', () => {
    expect(
      proxy.check({ tenantId: 'tenant-z', payload: 'NVDA 12,450', destination: 'x' }).allowed,
    ).toBe(true);
  });
});

describe('the two controls are independent', () => {
  const report = runEgressFamily();
  const shouldBlock = EGRESS_CASES.filter((c) => c.expect !== 'allowed');

  it('decides every case the way the deployment intends', () => {
    expect(report.wrong).toEqual([]);
  });

  // The argument for two controls is that each covers the other's blind spot.
  // If either alone covered everything, the second would be decoration.
  it('leaves neither control able to cover the set alone', () => {
    expect(report.routerCatchesWithBlindProxy).toBeLessThan(shouldBlock.length);
    expect(report.proxyCatchesWithCompromisedRouter).toBeLessThan(shouldBlock.length);
  });

  it('covers the whole set between them', () => {
    expect(report.correct).toBe(EGRESS_CASES.length);
  });

  // A wrong stamp is reachable, because agents influence what gets assembled.
  it('stops a mislabelled position dump at the wire', () => {
    const decision = checkEgress(
      {
        modelId: 'frontier-a',
        placement: 'vendor',
        contextClasses: ['public'],
        tenantId: 'tenant-a',
      },
      proxy,
      'Context: NVDA 12,450 shares, TSM 6,233 shares.',
      'https://vendor.example',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.control).toBe('proxy');
  });

  // A scanner that only sees base64 sees nothing. The stamp is what is left.
  it('stops an encoded dump at the stamp', () => {
    const encoded = Buffer.from('NVDA 12450 SOXL -3817').toString('base64');
    expect(check(`blob: ${encoded}`).allowed).toBe(true);
    const decision = checkEgress(
      {
        modelId: 'frontier-a',
        placement: 'vendor',
        contextClasses: ['positions'],
        tenantId: 'tenant-a',
      },
      proxy,
      `blob: ${encoded}`,
      'https://vendor.example',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.control).toBe('router');
  });
});
