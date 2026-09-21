import { describe, expect, it } from 'vitest';
import {
  DuplicateIdentifier,
  InstrumentRegistry,
  InvalidIdentifier,
  isValidCusip,
  isValidFigi,
  isValidIsin,
  type Instrument,
} from '../src/instruments.js';

/** Real identifiers, so the check digits are checked against the world. */
const APPLE: Instrument = {
  id: 'eq:aapl',
  assetClass: 'equity',
  name: 'Apple Inc',
  figi: 'BBG000B9XRY4',
  isin: 'US0378331005',
  cusip: '037833100',
  listings: [{ mic: 'XNAS', ticker: 'AAPL', currency: 'USD' }],
};

const MICRON: Instrument = {
  id: 'eq:mu',
  assetClass: 'equity',
  name: 'Micron Technology',
  listings: [
    { mic: 'XNAS', ticker: 'MU', currency: 'USD' },
    { mic: 'XFRA', ticker: 'MU', currency: 'EUR' },
  ],
};

describe('check digits', () => {
  it('accept real ISINs and reject a mutated one', () => {
    for (const isin of ['US0378331005', 'GB0002634946', 'US5949181045', 'DE0005557508']) {
      expect(isValidIsin(isin), isin).toBe(true);
    }
    expect(isValidIsin('US0378331004')).toBe(false);
    // Shape, not just the digit.
    expect(isValidIsin('US037833100')).toBe(false);
    expect(isValidIsin('0S0378331005')).toBe(false);
    expect(isValidIsin('us0378331005')).toBe(false);
  });

  it('accept real CUSIPs and reject a mutated one', () => {
    for (const cusip of ['037833100', '594918104', '67066G104']) {
      expect(isValidCusip(cusip), cusip).toBe(true);
    }
    expect(isValidCusip('037833101')).toBe(false);
    expect(isValidCusip('03783310')).toBe(false);
  });

  it('accept real FIGIs and reject a mutated one', () => {
    for (const figi of ['BBG000B9XRY4', 'BBG000BPH459', 'BBG000BBJQV0']) {
      expect(isValidFigi(figi), figi).toBe(true);
    }
    expect(isValidFigi('BBG000B9XRY5')).toBe(false);
    // `G` must sit in the third position.
    expect(isValidFigi('BBB000B9XRY4')).toBe(false);
    // Prefixes reserved so a FIGI can never be read as the head of an ISIN.
    expect(isValidFigi('GBG000B9XRY4')).toBe(false);
    expect(isValidFigi('KYG000B9XRY4')).toBe(false);
  });

  // A check digit catches a transcription error, not a mix-up. Worth pinning,
  // because it is the limit of what this layer can promise.
  it('cannot tell that a valid identifier names the wrong security', () => {
    expect(isValidIsin('US5949181045')).toBe(true); // Microsoft
    expect(isValidIsin('US0378331005')).toBe(true); // Apple
    // Both valid. Nothing here knows which one the caller meant.
  });
});

describe('registration', () => {
  it('refuses an identifier that fails its own check digit', () => {
    const registry = new InstrumentRegistry();
    expect(() => registry.register({ ...APPLE, isin: 'US0378331004' })).toThrow(InvalidIdentifier);
    expect(() => registry.register({ ...APPLE, cusip: '037833101' })).toThrow(InvalidIdentifier);
    expect(() => registry.register({ ...APPLE, figi: 'BBG000B9XRY5' })).toThrow(InvalidIdentifier);
    // And nothing was half-stored.
    expect(registry.size).toBe(0);
  });

  it('refuses an identifier already held by something else', () => {
    const registry = new InstrumentRegistry();
    registry.register(APPLE);
    expect(() =>
      registry.register({ ...APPLE, id: 'eq:other', name: 'Not Apple' }),
    ).toThrow(DuplicateIdentifier);
    expect(() => registry.register(APPLE)).toThrow(DuplicateIdentifier);
  });

  it('normalizes what a caller may spell either way', () => {
    const registry = new InstrumentRegistry();
    const token = registry.register({
      id: 'crypto:weth',
      assetClass: 'crypto',
      name: 'Wrapped Ether',
      listings: [{ mic: 'xnas', ticker: 'weth', currency: 'USD' }],
      chain: { chainId: 1, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    });
    expect(token.listings[0]?.ticker).toBe('WETH');
    expect(token.listings[0]?.mic).toBe('XNAS');
    // Checksummed and lower-case spellings of an address are the same address.
    expect(token.chain?.address).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(
      registry.resolveChain(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')[0]?.instrument.id,
    ).toBe('crypto:weth');
  });

  it('keys a token by chain and address together', () => {
    const registry = new InstrumentRegistry();
    registry.register({
      id: 'crypto:usdc-eth',
      assetClass: 'crypto',
      name: 'USDC on Ethereum',
      listings: [],
      chain: { chainId: 1, address: '0xa0b8' },
    });
    // The same address on another chain is another instrument, and must be.
    registry.register({
      id: 'crypto:usdc-arb',
      assetClass: 'crypto',
      name: 'USDC on Arbitrum',
      listings: [],
      chain: { chainId: 42161, address: '0xa0b8' },
    });
    expect(registry.resolveChain(1, '0xa0b8')[0]?.instrument.id).toBe('crypto:usdc-eth');
    expect(registry.resolveChain(42161, '0xa0b8')[0]?.instrument.id).toBe('crypto:usdc-arb');
  });
});

describe('resolution', () => {
  function registry(): InstrumentRegistry {
    const r = new InstrumentRegistry();
    r.register(APPLE);
    r.register(MICRON);
    return r;
  }

  it('resolves a unique identifier to one candidate', () => {
    const r = registry();
    expect(r.resolveIdentifier('isin', 'US0378331005')[0]?.instrument.id).toBe('eq:aapl');
    expect(r.resolveIdentifier('cusip', '037833100')[0]?.instrument.id).toBe('eq:aapl');
    expect(r.resolveIdentifier('figi', 'BBG000B9XRY4')[0]?.instrument.id).toBe('eq:aapl');
    expect(r.resolveIdentifier('isin', 'US5949181045')).toEqual([]);
  });

  // A bare ticker is ambiguous across venues, and they are different securities
  // with different currencies and different closing times.
  it('returns every venue for a cross-listed ticker rather than picking one', () => {
    const candidates = registry().resolveTicker('MU', '2026-01-01');
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.listing?.mic).sort()).toEqual(['XFRA', 'XNAS']);
    expect(new Set(candidates.map((c) => c.instrument.id))).toEqual(new Set(['eq:mu']));
  });

  it('narrows to a venue when one is given', () => {
    const candidates = registry().resolveTicker('MU', '2026-01-01', 'XNAS');
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.listing?.currency).toBe('USD');
  });

  it('is case insensitive on both the ticker and the venue', () => {
    expect(registry().resolveTicker('mu', '2026-01-01', 'xnas').length).toBe(1);
  });
});

/**
 * The failure this layer exists to prevent, and the one that is invisible
 * until it bites: a ticker is a lease, not a name.
 */
describe('tickers are resolved as of a date', () => {
  function withReuse(): InstrumentRegistry {
    const r = new InstrumentRegistry();
    // The rename case. Same issuer, same internal id, two labels.
    r.register({
      id: 'eq:meta',
      assetClass: 'equity',
      name: 'Meta Platforms',
      listings: [
        { mic: 'XNAS', ticker: 'FB', currency: 'USD', until: '2022-06-09' },
        { mic: 'XNAS', ticker: 'META', currency: 'USD', from: '2022-06-09' },
      ],
    });
    // The reuse case. A symbol freed by one issuer and re-let to another.
    r.register({
      id: 'eq:old-holder',
      assetClass: 'equity',
      name: 'The Original Holder',
      listings: [{ mic: 'XNYS', ticker: 'RLET', currency: 'USD', until: '2020-03-01' }],
    });
    r.register({
      id: 'eq:new-holder',
      assetClass: 'equity',
      name: 'The Later Holder',
      listings: [{ mic: 'XNYS', ticker: 'RLET', currency: 'USD', from: '2023-07-01' }],
    });
    return r;
  }

  // The trap. A backtest resolving as of 2019 must get the company that held
  // the symbol in 2019, not whoever holds it today.
  it('resolves a re-let symbol to whoever held it on the date asked for', () => {
    const r = withReuse();
    expect(r.resolveTicker('RLET', '2019-05-01')[0]?.instrument.id).toBe('eq:old-holder');
    expect(r.resolveTicker('RLET', '2026-05-01')[0]?.instrument.id).toBe('eq:new-holder');
  });

  it('resolves to nothing in the gap between the two holders', () => {
    expect(withReuse().resolveTicker('RLET', '2021-06-01')).toEqual([]);
  });

  it('treats the window as inclusive at the start and exclusive at the end', () => {
    const r = withReuse();
    // The rename day itself belongs to the new label, not the old one.
    expect(r.resolveTicker('FB', '2022-06-08')[0]?.instrument.id).toBe('eq:meta');
    expect(r.resolveTicker('FB', '2022-06-09')).toEqual([]);
    expect(r.resolveTicker('META', '2022-06-09')[0]?.instrument.id).toBe('eq:meta');
    expect(r.resolveTicker('META', '2022-06-08')).toEqual([]);
  });

  // The easy half of the same problem: a rename keeps the internal id, so a
  // ten-year chart does not become two charts.
  it('keeps one internal id across a rename', () => {
    const r = withReuse();
    const before = r.resolveTicker('FB', '2019-01-01')[0]?.instrument.id;
    const after = r.resolveTicker('META', '2026-01-01')[0]?.instrument.id;
    expect(before).toBe(after);
    expect(r.historyOf('eq:meta').map((l) => l.ticker)).toEqual(['FB', 'META']);
  });

  // "Now" is a decision, not a default. An analyst in a search box means today;
  // a backtest does not, and the two should not share an entry point.
  it('makes resolving against today a separate call', () => {
    const r = withReuse();
    expect(r.resolveTickerNow('RLET', '2026-05-01')[0]?.instrument.id).toBe('eq:new-holder');
    // Same function underneath, different name at the call site — which is the
    // whole point: `resolveTicker` cannot be called without stating a date.
    expect(r.resolveTickerNow('RLET', '2019-05-01')[0]?.instrument.id).toBe('eq:old-holder');
  });

  it('treats a listing with no window as always current', () => {
    const r = new InstrumentRegistry();
    r.register(APPLE);
    expect(r.resolveTicker('AAPL', '1999-01-01').length).toBe(1);
    expect(r.resolveTicker('AAPL', '2099-01-01').length).toBe(1);
  });
});
