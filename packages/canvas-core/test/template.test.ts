import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_PARAMS,
  bindingsSatisfy,
  instantiate,
  toTemplate,
} from '../src/template.js';
import { addNode, createDocument } from '../src/document.js';
import type { CanvasDocument, Edge } from '../src/types.js';
import { node, port } from './fixtures.js';

/** A completed analysis: a chart on NVDA feeding a regression and a note. */
function analysed(): CanvasDocument {
  const doc = createDocument('post-q4');

  addNode(
    doc,
    node({
      id: 'chart',
      kind: 'ChartNode',
      binding: 'wired',
      x: 40,
      y: 60,
      params: { instrument: 'eq:nvda:us', metrics: ['gross_margin', 'rev_growth'], frequency: 'quarterly' },
      outputs: [port('out', 'series')],
      status: 'ready',
      cacheKey: 'ck-nvda-9912',
    }),
  );
  addNode(
    doc,
    node({
      id: 'regress',
      kind: 'TransformNode',
      binding: 'wired',
      x: 380,
      y: 60,
      params: { method: 'ols', window: 60 },
      inputs: [port('in', 'series')],
      outputs: [port('out', 'scalar')],
      status: 'ready',
      cacheKey: 'ck-regress-771',
    }),
  );
  addNode(
    doc,
    node({
      id: 'note',
      kind: 'TextPad',
      binding: 'loose',
      x: 380,
      y: 300,
      params: { text: 'margin compression is the whole story' },
    }),
  );

  // Provenance and entitlements, as a canvas that has actually run carries.
  for (const id of ['chart', 'regress']) {
    const n = doc.nodes.get(id)!;
    n.provenance = { datasetSnapshots: { fundamentals: 'snap-9912' }, asof: '2026-03-11', verified: true };
    n.entitlementTags = ['vendor-x'];
  }

  const edge: Edge = {
    id: 'chart->regress',
    from: { nodeId: 'chart', portId: 'out' },
    to: { nodeId: 'regress', portId: 'in' },
    class: 'data',
  };
  doc.edges.set(edge.id, edge);
  return doc;
}

describe('taking a template', () => {
  it('keeps the structure', () => {
    const template = toTemplate(analysed(), 'margin study');
    expect(template.name).toBe('margin study');
    expect(template.sourceCanvas).toBe('post-q4');
    expect(template.nodes.map((n) => n.id)).toEqual(['chart', 'note', 'regress']);
    expect(template.edges.map((e) => e.id)).toEqual(['chart->regress']);
    // Method parameters are structure and stay.
    expect(template.nodes.find((n) => n.id === 'regress')?.params).toEqual({
      method: 'ols',
      window: 60,
    });
  });

  // The spatial arrangement *is* the analysis in a way a list of nodes is not.
  it('keeps the layout', () => {
    const template = toTemplate(analysed(), 't');
    const chart = template.nodes.find((n) => n.id === 'chart')!;
    expect(chart.position).toEqual({ x: 40, y: 60 });
    expect(chart.size.w).toBeGreaterThan(0);
    expect(template.nodes.find((n) => n.id === 'note')?.position).toEqual({ x: 380, y: 300 });
  });

  it('strips the instrument and records that it needs one back', () => {
    const template = toTemplate(analysed(), 't');
    const chart = template.nodes.find((n) => n.id === 'chart')!;
    expect(chart.params).not.toHaveProperty('instrument');
    expect(chart.bindings).toEqual(['instrument']);
    expect(template.required).toEqual(['instrument']);
    // And the metrics, which are method rather than subject, survive.
    expect(chart.params.metrics).toEqual(['gross_margin', 'rev_growth']);
  });

  it('recognizes every name an instrument travels under', () => {
    const doc = createDocument('c');
    const params: Record<string, string> = {};
    for (const name of INSTRUMENT_PARAMS) params[name] = `bound-${name}`;
    params.method = 'ols';
    addNode(doc, node({ id: 'n', params }));

    const template = toTemplate(doc, 't');
    expect(template.required).toEqual([...INSTRUMENT_PARAMS].sort());
    expect(template.nodes[0]?.params).toEqual({ method: 'ols' });
  });

  it('is a value, so two templates of the same canvas compare equal', () => {
    expect(toTemplate(analysed(), 't')).toEqual(toTemplate(analysed(), 't'));
  });
});

describe('instantiating it against a new subject', () => {
  it('re-runs the analysis on another ticker in one action', () => {
    const template = toTemplate(analysed(), 'margin study');
    expect(bindingsSatisfy(template, { instrument: 'eq:mu:us' })).toBe(true);

    const { doc, missingBindings } = instantiate(template, { instrument: 'eq:mu:us' }, 'mu-study');
    expect(missingBindings).toEqual([]);
    expect(doc.id).toBe('mu-study');
    expect(doc.nodes.get('chart')?.params.instrument).toBe('eq:mu:us');
    expect(doc.nodes.get('regress')?.params).toEqual({ method: 'ols', window: 60 });
    expect(doc.edges.size).toBe(1);
  });

  // The failure that matters, because it is silent and fast and wrong: a cache
  // key derived against NVDA would let the node instantiated for MU serve
  // NVDA's answer.
  it('carries no cache key from the canvas it came from', () => {
    const source = analysed();
    expect(source.nodes.get('chart')?.state.cacheKey).toBe('ck-nvda-9912');

    const { doc } = instantiate(toTemplate(source, 't'), { instrument: 'eq:mu:us' }, 'c2');
    for (const n of doc.nodes.values()) {
      expect(n.state.cacheKey, n.id).toBeUndefined();
    }
  });

  it('carries no provenance, no snapshot, no as-of and no verification flag', () => {
    const { doc } = instantiate(toTemplate(analysed(), 't'), { instrument: 'eq:mu:us' }, 'c2');
    for (const n of doc.nodes.values()) {
      expect(n.provenance.datasetSnapshots, n.id).toEqual({});
      expect(n.provenance.asof, n.id).toBe('');
      expect(n.provenance.verified, n.id).toBe(false);
      expect(n.entitlementTags, n.id).toEqual([]);
    }
  });

  it('comes back stale, because nothing in it has been computed', () => {
    const { doc } = instantiate(toTemplate(analysed(), 't'), { instrument: 'eq:mu:us' }, 'c2');
    expect(doc.nodes.get('chart')?.state.status).toBe('stale');
    expect(doc.nodes.get('regress')?.state.status).toBe('stale');
    // A loose object never enters the scheduler, so it is idle and not stale.
    expect(doc.nodes.get('note')?.state.status).toBe('idle');
  });

  // A template that silently half-binds is worse than one that refuses.
  it('names every binding the caller did not supply', () => {
    const template = toTemplate(analysed(), 't');
    expect(bindingsSatisfy(template, {})).toBe(false);

    const { doc, missingBindings } = instantiate(template, {}, 'c2');
    expect(missingBindings).toEqual(['chart.instrument']);
    expect(doc.nodes.get('chart')?.params).not.toHaveProperty('instrument');
    // And it is still stale rather than looking complete and computing nothing.
    expect(doc.nodes.get('chart')?.state.status).toBe('stale');
  });

  it('drops an edge whose endpoints did not both survive a hand-edited template', () => {
    const template = toTemplate(analysed(), 't');
    template.nodes = template.nodes.filter((n) => n.id !== 'regress');
    const { doc } = instantiate(template, { instrument: 'eq:mu:us' }, 'c2');
    expect(doc.nodes.has('regress')).toBe(false);
    expect(doc.edges.size).toBe(0);
  });

  it('does not alias the template, so instantiating twice is independent', () => {
    const template = toTemplate(analysed(), 't');
    const a = instantiate(template, { instrument: 'eq:mu:us' }, 'a');
    const b = instantiate(template, { instrument: 'eq:amd:us' }, 'b');

    a.doc.nodes.get('chart')!.position.x = 9999;
    expect(b.doc.nodes.get('chart')?.position.x).toBe(40);
    expect(template.nodes.find((n) => n.id === 'chart')?.position.x).toBe(40);
    expect(a.doc.nodes.get('chart')?.params.instrument).toBe('eq:mu:us');
    expect(b.doc.nodes.get('chart')?.params.instrument).toBe('eq:amd:us');
  });
});
