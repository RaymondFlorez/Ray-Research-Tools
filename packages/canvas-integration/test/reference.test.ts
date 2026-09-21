/**
 * The reference layer, driving the things that were resolving against nothing.
 *
 * > Everything resolves through a canonical instrument model keyed by an
 * > internal ID. — PRD 5.1
 *
 * `canvas-ink`'s semantic pass takes a `ReferenceResolver` and its contract is
 * that an ambiguous mention produces a chip rather than a chart. `canvas-data`'s
 * registry returns candidates and never picks. Those two contracts were written
 * to meet and had never been introduced: every suite so far supplied a
 * hand-written resolver that returned whatever the test wanted.
 *
 * This is the introduction. What it checks is not that the resolver compiles
 * against the registry but that the *refusals line up*: the case the registry
 * calls ambiguous has to be the case the sketch refuses to promote, and the
 * date the registry resolves against has to be the date the canvas is scrubbed
 * to — because a sketch accepted on a canvas pinned to 2019 that bound to
 * today's holder of the ticker would be the look-ahead both layers exist to
 * prevent, arriving through the seam between them.
 */

import { describe, expect, it } from 'vitest';
import { InstrumentRegistry, type Instrument } from '@picasso/canvas-data';
import {
  ProposalNotAcceptable,
  accept,
  propose,
  recognizeShape,
  type Candidate,
  type ReferenceResolver,
} from '@picasso/canvas-ink';
import { handDrawnBox, mulberry32 } from './strokes.js';

const INSTRUMENTS: Instrument[] = [
  {
    id: 'eq:nvda',
    assetClass: 'equity',
    name: 'NVIDIA Corp',
    figi: 'BBG000BBJQV0',
    cusip: '67066G104',
    listings: [{ mic: 'XNAS', ticker: 'NVDA', currency: 'USD' }],
  },
  {
    id: 'eq:mu',
    assetClass: 'equity',
    name: 'Micron Technology',
    listings: [
      { mic: 'XNAS', ticker: 'MU', currency: 'USD' },
      { mic: 'XFRA', ticker: 'MU', currency: 'EUR' },
    ],
  },
  {
    id: 'eq:old-holder',
    assetClass: 'equity',
    name: 'The Original Holder',
    listings: [{ mic: 'XNYS', ticker: 'RLET', currency: 'USD', until: '2020-03-01' }],
  },
  {
    id: 'eq:new-holder',
    assetClass: 'equity',
    name: 'The Later Holder',
    listings: [{ mic: 'XNYS', ticker: 'RLET', currency: 'USD', from: '2023-07-01' }],
  },
];

function registry(): InstrumentRegistry {
  const r = new InstrumentRegistry();
  for (const instrument of INSTRUMENTS) r.register(instrument);
  return r;
}

/**
 * The adapter the PRD implies and neither package had.
 *
 * `asOf` is a required argument rather than a default, which is the whole
 * point: the canvas is scrubbed to a date and the resolver has to resolve at
 * that date. A resolver that closed over "now" would quietly bind a sketch on a
 * 2019 canvas to today's holder of the symbol.
 */
function resolverFor(r: InstrumentRegistry, asOf: string): ReferenceResolver {
  const metrics: Record<string, Candidate> = {
    'rev growth': { id: 'm:revenue_growth', label: 'Revenue growth' },
    GM: { id: 'm:gross_margin', label: 'Gross margin' },
  };
  return (mention, kind) => {
    if (kind === 'metric') {
      const metric = metrics[mention];
      return metric ? [metric] : [];
    }
    return r
      .resolveTicker(mention, asOf)
      .map(({ instrument, listing }) => ({
        id: instrument.id,
        label: listing ? `${instrument.name} (${listing.mic})` : instrument.name,
      }));
  };
}

const BOX = handDrawnBox(mulberry32(11));
const BOUNDS = {
  minX: Math.min(...BOX.map((p) => p.x)),
  minY: Math.min(...BOX.map((p) => p.y)),
  maxX: Math.max(...BOX.map((p) => p.x)),
  maxY: Math.max(...BOX.map((p) => p.y)),
};

function sketchOf(subject: string, asOf: string, r = registry()) {
  return propose({
    shape: recognizeShape(BOX),
    text: `${subject} rev growth`,
    raw: { kind: 'chart', subject, metrics: ['rev growth'] },
    resolve: resolverFor(r, asOf),
    strokeIds: ['s1'],
    bounds: BOUNDS,
  });
}

describe('the registry resolves what the sketch asks about', () => {
  it('binds an unambiguous ticker to its internal id, not to the ticker', () => {
    const proposal = sketchOf('NVDA', '2026-01-01');
    expect(proposal.acceptable).toBe(true);

    const { node } = accept(proposal, 'chart-1', 'maya');
    // The internal id is what the cache key and the entitlement will be keyed
    // on. Binding to the ticker would key them to a lease.
    expect(node.params.instrument).toBe('eq:nvda');
  });

  // The two contracts meeting: the registry calls this ambiguous, the sketch
  // refuses to promote it, and the analyst gets a chip rather than a chart.
  it('refuses a cross-listed ticker rather than choosing a venue', () => {
    const proposal = sketchOf('MU', '2026-01-01');
    expect(proposal.acceptable).toBe(false);
    expect(() => accept(proposal, 'chart-1', 'maya')).toThrow(ProposalNotAcceptable);

    const unresolved = proposal.unresolved.find((u) => u.mention === 'MU');
    expect(unresolved?.candidates.length).toBe(2);
    // And the candidates say which venue, which is what makes the chip usable.
    expect(unresolved?.candidates.map((c) => c.label).sort()).toEqual([
      'Micron Technology (XFRA)',
      'Micron Technology (XNAS)',
    ]);
  });

  it('refuses a ticker the registry has never heard of', () => {
    const proposal = sketchOf('ZZZZ', '2026-01-01');
    expect(proposal.acceptable).toBe(false);
    expect(proposal.unresolved.map((u) => u.mention)).toContain('ZZZZ');
  });
});

/**
 * The seam that matters. A canvas scrubbed to a date resolves at that date, and
 * a sketch accepted on it binds to the company that held the symbol then.
 */
describe('a sketch on a scrubbed canvas binds to the right company', () => {
  it('binds a re-let symbol to whoever held it on the canvas date', () => {
    const then = accept(sketchOf('RLET', '2019-05-01'), 'chart-a', 'maya');
    expect(then.node.params.instrument).toBe('eq:old-holder');

    const now = accept(sketchOf('RLET', '2026-05-01'), 'chart-b', 'maya');
    expect(now.node.params.instrument).toBe('eq:new-holder');

    // The same drawing, the same handwriting, two different companies —
    // decided by the canvas date and nothing else.
    expect(then.node.params.instrument).not.toBe(now.node.params.instrument);
  });

  it('refuses the sketch in the gap when nobody held the symbol', () => {
    const proposal = sketchOf('RLET', '2021-06-01');
    expect(proposal.acceptable).toBe(false);
    expect(proposal.unresolved.find((u) => u.mention === 'RLET')?.candidates).toEqual([]);
  });
});
