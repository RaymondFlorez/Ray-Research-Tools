import { describe, expect, it } from 'vitest';
import {
  addNode,
  createDocument,
  createNode,
  flyTo,
  nodeRect,
  type CanvasDocument,
  type Viewport,
} from '@picasso/canvas-core';
import type { Fact } from '../src/blackboard.js';
import { reconcile, type CellReading, type Narrative } from '../src/reconciler.js';
import {
  NoPlaceToFly,
  NotReconciled,
  flyToSource,
  handleAt,
  materialize,
  type MaterializeInput,
} from '../src/synthesis.js';

const VIEWPORT: Viewport = { x: 0, y: 0, scale: 1, width: 1440, height: 900 };

function canvas(): CanvasDocument {
  const doc = createDocument('canvas-answer');
  addNode(
    doc,
    createNode({
      id: 'agg-vega',
      kind: 'TransformNode',
      binding: 'wired',
      position: { x: 4000, y: 2600 },
      size: { w: 240, h: 160 },
    }),
  );
  addNode(
    doc,
    createNode({
      id: 'agg-delta',
      kind: 'TransformNode',
      binding: 'wired',
      position: { x: 4400, y: 2600 },
      size: { w: 240, h: 160 },
    }),
  );
  return doc;
}

const vega: Fact = {
  id: 'f-vega',
  claim: 'portfolio vega after the shock',
  value: { number: -3870, unit: 'usd', asof: '2026-03-11' },
  provenance: { kind: 'cell', nodeId: 'agg-vega', cacheKey: 'k-vega-1' },
  confidence: 1,
  contested: false,
  assertedBy: 'quant',
  at: 1,
};

const delta: Fact = {
  ...vega,
  id: 'f-delta',
  claim: 'portfolio delta after the shock',
  value: { number: 1240, unit: 'usd', asof: '2026-03-11' },
  provenance: { kind: 'cell', nodeId: 'agg-delta', cacheKey: 'k-delta-1' },
};

const cells: CellReading[] = [
  {
    nodeId: 'agg-vega',
    cacheKey: 'k-vega-1',
    label: 'vega',
    value: -3870,
    unit: 'usd',
    asof: '2026-03-11',
  },
  {
    nodeId: 'agg-delta',
    cacheKey: 'k-delta-1',
    label: 'delta',
    value: 1240,
    unit: 'usd',
    asof: '2026-03-11',
  },
];

/** "Vega falls to -3,870 and delta holds at 1,240." with both numbers handled. */
function draft(): Narrative {
  const before = 'Under the hawkish shock vega falls to ';
  const middle = ' and delta holds at ';
  const vegaText = '-3,870';
  const deltaText = '1,240';
  const text = `${before}${vegaText}${middle}${deltaText}.`;
  return {
    text,
    handles: [
      { factId: 'f-vega', start: before.length, end: before.length + vegaText.length },
      {
        factId: 'f-delta',
        start: before.length + vegaText.length + middle.length,
        end: text.length - 1,
      },
    ],
  };
}

function input(overrides: Partial<MaterializeInput> = {}): MaterializeInput {
  const narrative = overrides.narrative ?? draft();
  const facts = overrides.facts ?? [vega, delta];
  return {
    narrative,
    facts,
    reconciliation: overrides.reconciliation ?? reconcile({ narrative, facts, cells }),
    doc: overrides.doc ?? canvas(),
    nodeId: overrides.nodeId ?? 'answer-1',
    position: overrides.position ?? { x: 100, y: 100 },
    ...(overrides.size ? { size: overrides.size } : {}),
  };
}

describe('writing the answer into a TextPad', () => {
  it('will not write a draft that did not reconcile', () => {
    const narrative = draft();
    // One transcribed digit, which is the failure the join exists to catch.
    const broken = { ...narrative, text: narrative.text.replace('-3,870', '-3,860') };
    const reconciliation = reconcile({ narrative: broken, facts: [vega, delta], cells });
    expect(reconciliation.ok).toBe(false);
    expect(() => materialize(input({ narrative: broken, reconciliation }))).toThrow(NotReconciled);
  });

  it('lands as a loose TextPad carrying the text', () => {
    const { node } = materialize(input());
    expect(node.kind).toBe('TextPad');
    // Prose computes nothing and has nothing to invalidate; binding it would
    // put it in the scheduler with no work to do.
    expect(node.binding).toBe('loose');
    expect(node.state.status).toBe('idle');
    expect(node.params.text).toBe(draft().text);
    expect(node.createdBy).toBe('agent');
  });

  it('resolves every number to the node that produced it', () => {
    const { handles, broken, sources } = materialize(input());
    expect(broken).toEqual([]);
    expect(handles.map((h) => h.text)).toEqual(['-3,870', '1,240']);
    expect(handles.map((h) => h.target)).toEqual([
      { kind: 'node', nodeId: 'agg-vega' },
      { kind: 'node', nodeId: 'agg-delta' },
    ]);
    expect(sources).toEqual(['agg-vega', 'agg-delta']);
    expect(handles[0]!.label).toContain('portfolio vega');
  });

  it('points a cited document at the document, not at the canvas', () => {
    const docFact: Fact = {
      ...vega,
      id: 'f-vega',
      provenance: { kind: 'document', docId: 'nvda-q4', page: 12, charStart: 40, charEnd: 60 },
    };
    const narrative = draft();
    const documents = new Map([['nvda-q4', `${' '.repeat(40)}vega of -3,870 in the filing`]]);
    const reconciliation = reconcile({ narrative, facts: [docFact, delta], cells, documents });
    const { handles } = materialize(input({ narrative, facts: [docFact, delta], reconciliation }));
    expect(handles[0]!.target).toEqual({
      kind: 'document',
      docId: 'nvda-q4',
      page: 12,
      charStart: 40,
      charEnd: 60,
    });
    expect(handles[0]!.label).toContain('p12');
  });

  it('reports a span whose source has left the canvas instead of rendering a dead link', () => {
    const doc = canvas();
    doc.nodes.delete('agg-delta');
    const { handles, broken } = materialize(input({ doc }));
    expect(handles).toHaveLength(1);
    expect(broken).toHaveLength(1);
    // A number nobody can trace should look different from one nobody clicked.
    expect(broken[0]!.text).toBe('1,240');
    expect(broken[0]!.reason).toContain('agg-delta');
  });

  it('leaves a literal waiver out of the handles rather than making a dead one', () => {
    const before = 'The 10-Q puts vega at ';
    const vegaText = '-3,870';
    const text = `${before}${vegaText}.`;
    const formStart = 'The '.length;
    const narrative: Narrative = {
      text,
      handles: [
        { factId: 'literal:form', start: formStart, end: formStart + 4, kind: 'literal' },
        { factId: 'f-vega', start: before.length, end: before.length + vegaText.length },
      ],
    };
    const reconciliation = reconcile({ narrative, facts: [vega], cells });
    expect(reconciliation.ok).toBe(true);
    const { handles } = materialize(input({ narrative, facts: [vega], reconciliation }));
    expect(handles).toHaveLength(1);
    expect(handles[0]!.factId).toBe('f-vega');
  });
});

describe('clicking a number', () => {
  it('finds the handle under the caret and nothing under the prose', () => {
    const { handles } = materialize(input());
    const start = draft().text.indexOf('-3,870');
    expect(handleAt(handles, start)!.factId).toBe('f-vega');
    expect(handleAt(handles, start + 3)!.factId).toBe('f-vega');
    // Half-open: one past the last character belongs to the prose after it.
    expect(handleAt(handles, start + 6)).toBeUndefined();
    expect(handleAt(handles, 0)).toBeUndefined();
  });

  it('flies the viewport to the source node, framed the way the palette frames it', () => {
    const doc = canvas();
    const { handles } = materialize(input({ doc }));
    const flown = flyToSource(doc, VIEWPORT, handles[0]!);
    // Not a second framing implementation: a number that lands somewhere
    // different from the command palette's result for the same node is a bug
    // nobody reports and everybody feels.
    expect(flown).toEqual(flyTo(VIEWPORT, nodeRect(doc.nodes.get('agg-vega')!)));
    const centreX = flown.x + VIEWPORT.width / (2 * flown.scale);
    expect(centreX).toBeCloseTo(4000 + 120, 6);
  });

  it('computes the viewport at the click, not at the write', () => {
    const doc = canvas();
    const { handles } = materialize(input({ doc }));
    const zoomed: Viewport = { ...VIEWPORT, scale: 0.25, x: -900, y: -400 };
    // A viewport captured at synthesis is wrong as soon as the analyst zooms.
    expect(flyToSource(doc, zoomed, handles[0]!)).toEqual(
      flyTo(zoomed, nodeRect(doc.nodes.get('agg-vega')!)),
    );
  });

  it('refuses to fly to a document or to a node that has gone', () => {
    const doc = canvas();
    const { handles } = materialize(input({ doc }));
    doc.nodes.delete('agg-vega');
    expect(() => flyToSource(doc, VIEWPORT, handles[0]!)).toThrow(NoPlaceToFly);

    const docFact: Fact = {
      ...vega,
      provenance: { kind: 'document', docId: 'nvda-q4', page: 12, charStart: 40, charEnd: 60 },
    };
    const narrative = draft();
    const documents = new Map([['nvda-q4', `${' '.repeat(40)}vega of -3,870 in the filing`]]);
    const built = materialize(
      input({
        narrative,
        facts: [docFact, delta],
        reconciliation: reconcile({ narrative, facts: [docFact, delta], cells, documents }),
      }),
    );
    expect(() => flyToSource(canvas(), VIEWPORT, built.handles[0]!)).toThrow(/document/);
  });
});
