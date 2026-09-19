import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  flyTo,
  fuzzyMatch,
  searchCanvas,
  searchPalette,
  type PaletteEntry,
} from '../src/search.js';
import { addNode, createDocument } from '../src/document.js';
import { clampZoom, type Viewport } from '../src/viewport.js';
import { node } from './fixtures.js';

describe('the fuzzy matcher', () => {
  it('matches a subsequence and reports where', () => {
    const match = fuzzyMatch('esn', 'EventStudyNode');
    expect(match).toBeDefined();
    expect(match?.positions).toEqual([0, 5, 10]);
  });

  it('rejects a query that is not a subsequence', () => {
    expect(fuzzyMatch('zzz', 'EventStudyNode')).toBeUndefined();
    // Right characters, wrong order: there is no `v` after the `d`.
    expect(fuzzyMatch('ndv', 'EventStudyNode')).toBeUndefined();
    // And a subsequence it *is*, so the rejection above is about order rather
    // than about the characters being absent. `nse` picks out the n of Event,
    // the S of Study and the e of Node, which is exactly what fuzzy means and
    // is why the first version of this test asserted the wrong thing.
    expect(fuzzyMatch('nse', 'EventStudyNode')?.positions).toEqual([3, 5, 13]);
  });

  it('is case insensitive in both directions', () => {
    expect(fuzzyMatch('NVDA', 'nvda')).toBeDefined();
    expect(fuzzyMatch('nvda', 'NVDA')).toBeDefined();
  });

  // The three things that make a palette feel like it read your mind.
  it('prefers a contiguous run to the same characters scattered', () => {
    const together = fuzzyMatch('event', 'EventStudyNode')!.score;
    const apart = fuzzyMatch('event', 'ExtraordinaryVenturesEnterNewTerritory')!.score;
    expect(together).toBeGreaterThan(apart);
  });

  it('prefers a match at word starts, which is what makes initialisms work', () => {
    const initials = fuzzyMatch('fen', 'Factor Exposure Node')!.score;
    const buried = fuzzyMatch('fen', 'coefficient_enumeration')!.score;
    expect(initials).toBeGreaterThan(buried);
  });

  it('prefers a match near the front', () => {
    const front = fuzzyMatch('ab', 'abcdefgh')!.score;
    const back = fuzzyMatch('ab', 'zzzzzzab')!.score;
    expect(front).toBeGreaterThan(back);
  });

  it('puts an exact match above a prefix above a subsequence', () => {
    const exact = fuzzyMatch('nvda', 'NVDA')!.score;
    const prefix = fuzzyMatch('nvda', 'NVDA Corp Class A')!.score;
    const scattered = fuzzyMatch('nvda', 'NoVel Data')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('treats an empty query as matching everything with no preference', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });
});

describe('the command palette', () => {
  const entries: PaletteEntry[] = [
    { kind: 'nodeType', label: 'EventStudyNode', value: 'EventStudyNode' },
    { kind: 'nodeType', label: 'FactorExposureNode', value: 'FactorExposureNode' },
    { kind: 'nodeType', label: 'MonteCarloNode', value: 'MonteCarloNode' },
    { kind: 'ticker', label: 'NVDA', aliases: ['NVIDIA Corp'], value: 'eq:nvda:us' },
    { kind: 'ticker', label: 'MU', aliases: ['Micron Technology'], value: 'eq:mu:us' },
    { kind: 'node', label: 'NVDA margin chart', value: 'chart-1' },
    { kind: 'template', label: 'margin study', value: 'tpl-margin' },
  ];

  it('finds a node type from its initials', () => {
    expect(searchPalette(entries, 'esn')[0]?.value).toBe('EventStudyNode');
    expect(searchPalette(entries, 'mcn')[0]?.value).toBe('MonteCarloNode');
  });

  // Matching a company name and displaying the ticker is the whole reason
  // aliases exist: nobody remembers every symbol.
  it('matches an alias and reports which string matched', () => {
    const top = searchPalette(entries, 'micron')[0];
    expect(top?.value).toBe('eq:mu:us');
    expect(top?.label).toBe('MU');
    expect(top?.matchedOn).toBe('Micron Technology');
  });

  it('searches every kind rather than guessing which one was meant', () => {
    const kinds = new Set(searchPalette(entries, 'n', 20).map((r) => r.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  // A node already on the canvas is a thing the analyst can see, and the
  // palette is most often a way of getting back to it.
  it('puts an existing node above a template that matches as well', () => {
    const results = searchPalette(
      [
        { kind: 'template', label: 'margin study', value: 'tpl' },
        { kind: 'node', label: 'margin study', value: 'node-1' },
      ],
      'margin study',
    );
    expect(results[0]?.kind).toBe('node');
  });

  it('honours the limit', () => {
    expect(searchPalette(entries, 'n', 2).length).toBe(2);
  });

  it('returns nothing for a query nothing matches', () => {
    expect(searchPalette(entries, 'qqqqqq')).toEqual([]);
  });

  it('is deterministic when scores tie', () => {
    const tied: PaletteEntry[] = [
      { kind: 'ticker', label: 'AAA', value: '1' },
      { kind: 'ticker', label: 'AAB', value: '2' },
    ];
    expect(searchPalette(tied, 'aa').map((r) => r.value)).toEqual(
      searchPalette(tied, 'aa').map((r) => r.value),
    );
  });
});

describe('spatial search', () => {
  function canvas() {
    const doc = createDocument('c');
    addNode(doc, node({
      id: 'chart',
      kind: 'ChartNode',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      params: { instrument: 'eq:nvda:us', metrics: ['gross_margin', 'rev_growth'] },
    }));
    addNode(doc, node({
      id: 'study',
      kind: 'BacktestNode',
      x: 400,
      y: 300,
      w: 200,
      h: 100,
      params: { events: { source: 'earnings', window: 11 }, benchmark: 'ff3' },
    }));
    addNode(doc, node({
      id: 'pad',
      kind: 'TextPad',
      x: -300,
      y: -200,
      w: 200,
      h: 100,
      params: { text: 'NVDA guidance language changed' },
    }));
    return doc;
  }

  it('searches values and not just keys', () => {
    const hits = searchCanvas(canvas(), 'nvda');
    expect(hits.map((h) => h.nodeId)).toContain('chart');
    expect(hits.map((h) => h.nodeId)).toContain('pad');
    expect(hits.find((h) => h.nodeId === 'chart')?.field).toBe('instrument');
  });

  // A chart's metric list is content. A search that only looked at top-level
  // strings would miss it.
  it('reaches into nested arrays and objects', () => {
    const byMetric = searchCanvas(canvas(), 'gross_margin');
    expect(byMetric[0]?.nodeId).toBe('chart');
    expect(byMetric[0]?.field).toBe('metrics[0]');

    const byNested = searchCanvas(canvas(), 'earnings');
    expect(byNested[0]?.nodeId).toBe('study');
    expect(byNested[0]?.field).toBe('events.source');
  });

  it('finds a node by its kind too', () => {
    const hits = searchCanvas(canvas(), 'backtest');
    expect(hits[0]?.nodeId).toBe('study');
    expect(hits[0]?.field).toBe('kind');
  });

  // Somebody searching a canvas is usually looking for a subject, not a type.
  it('ranks a content match above a kind match', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'by-kind', kind: 'ChartNode', params: {} }));
    addNode(doc, node({ id: 'by-content', kind: 'TextPad', params: { text: 'ChartNode' } }));
    expect(searchCanvas(doc, 'chartnode')[0]?.nodeId).toBe('by-content');
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchCanvas(canvas(), '')).toEqual([]);
    expect(searchCanvas(canvas(), '   ')).toEqual([]);
  });
});

describe('flying to a result', () => {
  const viewport: Viewport = { x: 0, y: 0, scale: 1, width: 1600, height: 900 };

  it('centres the target', () => {
    const target = { minX: 1000, minY: 500, maxX: 1200, maxY: 600 };
    const next = flyTo(viewport, target);
    const centreX = next.x + next.width / (2 * next.scale);
    const centreY = next.y + next.height / (2 * next.scale);
    expect(centreX).toBeCloseTo(1100, 6);
    expect(centreY).toBeCloseTo(550, 6);
  });

  it('frames a wide target more loosely than a narrow one', () => {
    const narrow = flyTo(viewport, { minX: 0, minY: 0, maxX: 200, maxY: 100 });
    const wide = flyTo(viewport, { minX: 0, minY: 0, maxX: 4000, maxY: 2000 });
    expect(narrow.scale).toBeGreaterThan(wide.scale);
  });

  // A single small node would otherwise fly to a scale where nothing around it
  // is legible, and a canvas-spanning frame to one where it is a speck.
  it('clamps to the canvas zoom range at both ends', () => {
    const tiny = flyTo(viewport, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    const huge = flyTo(viewport, { minX: 0, minY: 0, maxX: 5_000_000, maxY: 5_000_000 });
    expect(tiny.scale).toBe(clampZoom(tiny.scale));
    expect(huge.scale).toBe(clampZoom(huge.scale));
    expect(tiny.scale).toBeGreaterThan(huge.scale);
  });

  it('bounds a set of nodes for framing several results at once', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'a', x: 0, y: 0, w: 100, h: 50 }));
    addNode(doc, node({ id: 'b', x: 400, y: 200, w: 100, h: 50 }));
    expect(boundsOf(doc, ['a', 'b'])).toEqual({ minX: 0, minY: 0, maxX: 500, maxY: 250 });
    expect(boundsOf(doc, ['a', 'ghost'])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    expect(boundsOf(doc, [])).toBeUndefined();
    expect(boundsOf(doc, ['ghost'])).toBeUndefined();
  });

  it('composes: search, bound, fly', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'far', x: 5000, y: 3000, w: 240, h: 160, params: { instrument: 'NVDA' } }));
    const hits = searchCanvas(doc, 'nvda');
    const bounds = boundsOf(doc, hits.map((h) => h.nodeId))!;
    const next = flyTo(viewport, bounds);
    const centreX = next.x + next.width / (2 * next.scale);
    expect(centreX).toBeCloseTo(5120, 6);
  });
});
