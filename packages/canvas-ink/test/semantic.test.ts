import { describe, expect, it } from 'vitest';
import type { Rect } from '@picasso/canvas-core';
import { RECOGNITION_FLOOR, type Recognition } from '../src/recognize.js';
import {
  ProposalNotAcceptable,
  SchemaViolation,
  accept,
  propose,
  validate,
  type RawReading,
  type ReferenceResolver,
} from '../src/semantic.js';

const bounds: Rect = { minX: 100, minY: 200, maxX: 460, maxY: 440 };

function shape(kind: Recognition['kind'], confidence: number): Recognition {
  return {
    kind,
    confidence,
    scores: { line: 0, rectangle: confidence, ellipse: 0, arrow: 0, bracket: 0 },
  };
}

const resolver: ReferenceResolver = (mention, kind) => {
  if (kind === 'instrument' && mention === 'NVDA') {
    return [{ id: 'eq:nvda:us', label: 'NVIDIA Corp' }];
  }
  if (kind === 'instrument' && mention === 'MU') {
    return [
      { id: 'eq:mu:us', label: 'Micron', hint: 'NASDAQ' },
      { id: 'eq:mu:de', label: 'Micron', hint: 'Frankfurt' },
    ];
  }
  if (kind === 'metric' && mention === 'rev growth') return [{ id: 'm:revenue_growth', label: 'Revenue growth' }];
  if (kind === 'metric' && mention === 'GM') return [{ id: 'm:gross_margin', label: 'Gross margin' }];
  return [];
};

/** The PRD's own example sketch. */
function nvdaChart(): RawReading {
  return { kind: 'chart', subject: 'NVDA', metrics: ['rev growth', 'GM'], frequency: 'quarterly' };
}

function proposal(raw: RawReading, confidence = 0.92, kind: Recognition['kind'] = 'rectangle') {
  return propose({
    shape: shape(kind, confidence),
    text: 'NVDA rev growth vs GM, quarterly',
    raw,
    resolve: resolver,
    strokeIds: ['s1', 's2'],
    bounds,
  });
}

describe('the strict output schema', () => {
  it('accepts each of the four kinds', () => {
    expect(validate(nvdaChart()).kind).toBe('chart');
    expect(validate({ kind: 'formula', expression: 'a / b', inputs: ['a', 'b'] }).kind).toBe('formula');
    expect(
      validate({ kind: 'scenario', name: 'hawkish', shocks: [{ factor: 'rates', magnitude: '+50bp' }] }).kind,
    ).toBe('scenario');
    expect(validate({ kind: 'note', text: 'watch the March expiry' }).kind).toBe('note');
  });

  it('rejects a fifth kind', () => {
    expect(() => validate({ kind: 'backtest' })).toThrow(SchemaViolation);
    expect(() => validate({})).toThrow(SchemaViolation);
  });

  it('rejects a chart reading missing the fields a chart needs', () => {
    expect(() => validate({ kind: 'chart', metrics: ['GM'] })).toThrow(SchemaViolation);
    expect(() => validate({ kind: 'chart', subject: 'NVDA', metrics: [] })).toThrow(SchemaViolation);
    expect(() => validate({ kind: 'chart', subject: 'NVDA', metrics: 'GM' })).toThrow(SchemaViolation);
  });

  it('rejects a frequency that is not one', () => {
    expect(() => validate({ ...nvdaChart(), frequency: 'fortnightly' })).toThrow(SchemaViolation);
  });

  it('rejects malformed scenario shocks', () => {
    expect(() => validate({ kind: 'scenario', name: 'x', shocks: [{ factor: 'rates' }] })).toThrow(
      SchemaViolation,
    );
  });
});

describe('a reading that fails the schema', () => {
  // A malformed chart downgraded to a chart with guessed metrics is a proposal
  // the analyst accepts without noticing what was invented.
  it('becomes a note, which is the one kind that asserts nothing', () => {
    const result = proposal({ kind: 'chart', subject: 'NVDA' });
    expect(result.reading.kind).toBe('note');
    expect(result.downgradedFrom).toContain('no metrics');
    expect(result.nodeKind).toBe('TextPad');
  });

  it('keeps the recognized text, so nothing the analyst wrote is lost', () => {
    const result = proposal({ kind: 'nonsense' });
    expect(result.reading).toMatchObject({ kind: 'note', text: 'NVDA rev growth vs GM, quarterly' });
  });
});

describe('resolution against the reference layer', () => {
  it('resolves the PRD\'s example sketch to real ids', () => {
    const result = proposal(nvdaChart());
    expect(result.resolved.map((r) => r.id)).toEqual([
      'eq:nvda:us',
      'm:revenue_growth',
      'm:gross_margin',
    ]);
    expect(result.acceptable).toBe(true);
  });

  // Same rule as the QueryNode's chip. A proposal that silently picked one
  // would be accepted by an analyst looking at their own handwriting.
  it('refuses to pick between two candidates', () => {
    const result = proposal({ kind: 'chart', subject: 'MU', metrics: ['GM'] });
    expect(result.unresolved[0]).toMatchObject({ mention: 'MU', reason: 'ambiguous' });
    expect(result.unresolved[0]?.candidates).toHaveLength(2);
    expect(result.acceptable).toBe(false);
    expect(result.blockedBy).toContain('does not resolve');
  });

  it('reports a mention nothing knows about', () => {
    const result = proposal({ kind: 'chart', subject: 'NVDA', metrics: ['vibes'] });
    expect(result.unresolved[0]).toMatchObject({ mention: 'vibes', reason: 'unknown' });
  });
});

describe('the confidence on a proposal', () => {
  // A model's stated confidence in its own reading is a number it generated.
  // What predicts whether this sketch is a chart is whether the recognizer is
  // sure it is a rectangle, which is measured.
  it('is the geometric pass\'s, not the model\'s', () => {
    const result = propose({
      shape: shape('rectangle', 0.71),
      text: 'x',
      raw: { ...nvdaChart(), confidence: 0.99 } as RawReading,
      resolve: resolver,
      strokeIds: [],
      bounds,
    });
    expect(result.confidence).toBe(0.71);
  });

  it('blocks a chart the shape pass is not sure about', () => {
    const result = proposal(nvdaChart(), RECOGNITION_FLOOR - 0.01);
    expect(result.acceptable).toBe(false);
    expect(result.blockedBy).toContain('sure this is a');
  });

  // A note asserts nothing about the world, which is what makes it safe to
  // propose from a shape nobody recognized.
  it('does not block a note on an unrecognized shape', () => {
    const result = propose({
      shape: shape('unknown', 0),
      text: 'watch the March expiry, dealer gamma flips near 1150',
      raw: { kind: 'note', text: 'watch the March expiry, dealer gamma flips near 1150' },
      resolve: resolver,
      strokeIds: ['s1'],
      bounds,
    });
    expect(result.acceptable).toBe(true);
  });
});

describe('nothing auto-materializes', () => {
  // There is no path from a sketch to a PicassoNode in this package that does
  // not pass through accept().
  it('refuses to build a node from a blocked proposal', () => {
    const blocked = proposal({ kind: 'chart', subject: 'MU', metrics: ['GM'] });
    expect(() => accept(blocked, 'n1', 'maya')).toThrow(ProposalNotAcceptable);
  });

  it('refuses an acceptance with nobody recorded as accepting it', () => {
    expect(() => accept(proposal(nvdaChart()), 'n1', '  ')).toThrow(ProposalNotAcceptable);
  });

  it('records who accepted it on the node', () => {
    const { node } = accept(proposal(nvdaChart()), 'n1', 'maya');
    expect(node.params.acceptedBy).toBe('maya');
    expect(node.params.fromSketch).toBe(true);
    expect(node.createdBy).toBe('agent');
  });
});

describe('an accepted chart', () => {
  it('carries the resolved ids, not the handwriting', () => {
    const { node } = accept(proposal(nvdaChart()), 'n1', 'maya');
    expect(node.kind).toBe('ChartNode');
    expect(node.params.instrument).toBe('eq:nvda:us');
    expect(node.params.metrics).toEqual(['m:revenue_growth', 'm:gross_margin']);
    expect(node.params.frequency).toBe('quarterly');
  });

  // Bound, not wired: it resolves to real data and updates live, but nothing
  // has been connected to it and wiring is a decision the analyst has not made.
  it('arrives bound, not wired', () => {
    expect(accept(proposal(nvdaChart()), 'n1', 'maya').node.binding).toBe('bound');
  });

  it('lands where the ink was', () => {
    const { node } = accept(proposal(nvdaChart()), 'n1', 'maya');
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.size).toEqual({ w: 360, h: 240 });
  });

  // "On accept the ink stays, greyed and collapsible, linked to the node it
  // produced, because the sketch is often better documentation than the node."
  it('leaves the ink in place, greyed and linked', () => {
    const { ink } = accept(proposal(nvdaChart()), 'n1', 'maya');
    expect(ink).toEqual({ strokeIds: ['s1', 's2'], state: 'greyed', linkedNodeId: 'n1' });
  });
});

describe('an accepted note', () => {
  it('stays loose, because a note is not a computation', () => {
    const noteProposal = propose({
      shape: shape('unknown', 0),
      text: 'watch the March expiry',
      raw: { kind: 'note', text: 'watch the March expiry' },
      resolve: resolver,
      strokeIds: ['s1'],
      bounds,
    });
    const { node } = accept(noteProposal, 'n2', 'maya');
    expect(node.binding).toBe('loose');
    expect(node.kind).toBe('TextPad');
  });
});

describe('an accepted scenario', () => {
  it('carries its shocks', () => {
    const scenarioProposal = propose({
      shape: shape('rectangle', 0.9),
      text: 'hawkish +50bp',
      raw: { kind: 'scenario', name: 'hawkish', shocks: [{ factor: 'rates', magnitude: '+50bp' }] },
      resolve: resolver,
      strokeIds: ['s1'],
      bounds,
    });
    const { node } = accept(scenarioProposal, 'n3', 'maya');
    expect(node.kind).toBe('ScenarioNode');
    expect(node.params.shocks).toEqual(['rates:+50bp']);
  });
});
