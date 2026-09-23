import { describe, expect, it } from 'vitest';
import {
  addNode,
  createDocument,
  createNode,
  type CanvasDocument,
  type Edge,
  type NodeID,
  type PicassoNode,
  type PortType,
} from '@picasso/canvas-core';
import {
  ATTENTION_BONUS,
  NOTE_FRAMING,
  NotALooseNote,
  analystNote,
  noteText,
  CATEGORY_ORDER,
  RECENCY_HALF_LIFE_MS,
  approximateTokens,
  assembleContext,
  budgetContext,
  neighborhoodScore,
  summarizeNode,
  tableContext,
  type ContextCategory,
  type ContextItem,
} from '../src/context.js';

function n(
  id: string,
  params: PicassoNode['params'] = {},
  outputs: Array<[string, PortType]> = [['out', 'series']],
): PicassoNode {
  return createNode({
    id,
    kind: 'ChartNode',
    binding: 'wired',
    inputs: [{ id: 'in', name: 'in', type: 'series', cardinality: 'many', required: false }],
    outputs: outputs.map(([pid, type]) => ({
      id: pid,
      name: pid,
      type,
      cardinality: 'one',
      required: true,
    })),
    params,
  });
}

/** A loose object carrying recognized text: the analyst's margin. */
function note(id: string, text: string): PicassoNode {
  return createNode({ id, kind: 'TextPad', binding: 'loose', params: { text } });
}

/** PRD 3.2.2 row 5: an arrow from a loose object to a node. */
function attach(doc: CanvasDocument, from: NodeID, to: NodeID): Edge {
  const edge: Edge = {
    id: `${from}~${to}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'reference',
    contextTag: 'analyst_note',
  };
  doc.edges.set(edge.id, edge);
  return edge;
}

function wire(doc: CanvasDocument, from: NodeID, to: NodeID): Edge {
  const edge: Edge = {
    id: `${from}->${to}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'data',
  };
  doc.edges.set(edge.id, edge);
  return edge;
}

/**
 * source -> factor -> beta (selected) -> conclusion -> summary.
 *
 * Two ancestors above the selection and two descendants below it, so a builder
 * that walks the wrong way is visible rather than merely differently ordered.
 */
function chain(): CanvasDocument {
  const doc = createDocument('c');
  for (const id of ['source', 'factor', 'beta', 'conclusion', 'summary']) addNode(doc, n(id));
  wire(doc, 'source', 'factor');
  wire(doc, 'factor', 'beta');
  wire(doc, 'beta', 'conclusion');
  wire(doc, 'conclusion', 'summary');
  return doc;
}

const roomy = { ceiling: 100_000 };

describe('the lineage slice', () => {
  it('is the ancestors of the selection and not its descendants', () => {
    const assembled = assembleContext({
      doc: chain(),
      question: 'why is beta 1.4?',
      selected: ['beta'],
      policy: roomy,
    });
    const lineage = assembled.items.filter((i) => i.category === 'lineage').map((i) => i.nodeId);
    expect(new Set(lineage)).toEqual(new Set(['source', 'factor']));
    // The conclusion drawn from the selection is exactly what a model asked to
    // derive it must not be handed.
    const all = assembled.items.map((i) => i.nodeId);
    expect(all).not.toContain('conclusion');
    expect(all).not.toContain('summary');
  });

  it('scores a direct input above its own input', () => {
    const assembled = assembleContext({
      doc: chain(),
      question: 'why?',
      selected: ['beta'],
      policy: roomy,
    });
    const byId = new Map(assembled.items.map((i) => [i.nodeId, i]));
    expect(byId.get('factor')!.score).toBeGreaterThan(byId.get('source')!.score);
  });

  it('takes the shorter of two routes to the same ancestor', () => {
    // shared feeds the selection directly and again through a long detour.
    const doc = createDocument('c');
    for (const id of ['shared', 'mid', 'far', 'sel']) addNode(doc, n(id));
    wire(doc, 'shared', 'sel');
    wire(doc, 'shared', 'mid');
    wire(doc, 'mid', 'far');
    wire(doc, 'far', 'sel');
    const assembled = assembleContext({ doc, question: 'q', selected: ['sel'], policy: roomy });
    const byId = new Map(assembled.items.map((i) => [i.nodeId, i]));
    expect(byId.get('shared')!.score).toBe(1);
    expect(byId.get('mid')!.score).toBeLessThan(byId.get('far')!.score);
  });

  it('does not re-list a selected node as its own ancestor', () => {
    const doc = chain();
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['factor', 'beta'],
      policy: roomy,
    });
    const lineage = assembled.items.filter((i) => i.category === 'lineage').map((i) => i.nodeId);
    expect(lineage).toEqual(['source']);
    expect(assembled.items.filter((i) => i.nodeId === 'factor')).toHaveLength(1);
  });
});

describe('the node summary', () => {
  it('carries kind, params and output schema without raw data', () => {
    const node = n('px', { symbol: 'NVDA', window: 20 }, [['out', 'series']]);
    const text = summarizeNode(node);
    expect(text).toContain('px ChartNode');
    expect(text).toContain('symbol=NVDA');
    expect(text).toContain('window=20');
    expect(text).toContain('out:series');
  });

  it('summarizes a long array rather than inlining it', () => {
    const series = Array.from({ length: 10_000 }, (_, i) => i);
    const text = summarizeNode(n('px', { points: series }));
    expect(text).toContain('points=[10000 items]');
    expect(text.length).toBeLessThan(200);
  });

  it('reports the status when the caller has no value, and the value when it has one', () => {
    const node = n('px');
    expect(summarizeNode(node)).toContain('status=stale');
    expect(summarizeNode(node, 1.4142135)).toContain('value=1.41421');
  });
});

describe('tableContext', () => {
  it('cannot inline rows, because it is never given any', () => {
    const item = tableContext(
      'returns',
      {
        schema: { date: 'date', ret: 'number' },
        rows: 2_500_000,
        statistics: { mean: 0.0004, nulls: 0 },
        queryTool: 'query_table',
      },
      'licensed',
    );
    expect(item.text).toContain('2500000 rows');
    expect(item.text).toContain('date:date');
    expect(item.text).toContain('query via query_table');
    // The figure the README quotes: 2.5 million rows, 25 tokens.
    expect(item.tokens).toBe(25);
    // The type has no field a row could arrive in: a caller holding the rows
    // has nowhere to put them.
    const summary: Parameters<typeof tableContext>[1] = {
      schema: {},
      rows: 0,
      statistics: {},
      queryTool: 't',
    };
    expect(Object.keys(summary).sort()).toEqual(['queryTool', 'rows', 'schema', 'statistics']);
  });
});

describe('the neighborhood weighting', () => {
  it('decays with the age of the edit rather than cutting off', () => {
    const at = (ms: number) =>
      neighborhoodScore({ sinceEditMs: ms, seenThisSession: false, distance: 0 });
    expect(at(2 * 60_000)).toBeGreaterThan(at(2 * 3_600_000));
    expect(at(2 * 3_600_000)).toBeGreaterThan(at(7 * 24 * 3_600_000));
    expect(at(RECENCY_HALF_LIFE_MS)).toBeCloseTo(0.5, 12);
  });

  it('adds a flat bonus for having been looked at, not a multiplier', () => {
    const far = { sinceEditMs: 10 * RECENCY_HALF_LIFE_MS, distance: 50_000 };
    const seen = neighborhoodScore({ ...far, seenThisSession: true });
    const unseen = neighborhoodScore({ ...far, seenThisSession: false });
    expect(seen - unseen).toBeCloseTo(ATTENTION_BONUS, 12);
    const near = { sinceEditMs: 0, distance: 0 };
    expect(
      neighborhoodScore({ ...near, seenThisSession: true }) -
        neighborhoodScore({ ...near, seenThisSession: false }),
    ).toBeCloseTo(ATTENTION_BONUS, 12);
  });

  it('ranks a node seen this session above a closer one never looked at', () => {
    const doc = createDocument('c');
    for (const id of ['sel', 'glanced', 'ignored']) addNode(doc, n(id));
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['sel'],
      neighborhood: {
        glanced: { sinceEditMs: 4 * 3_600_000, seenThisSession: true, distance: 900 },
        ignored: { sinceEditMs: 4 * 3_600_000, seenThisSession: false, distance: 20 },
      },
      policy: roomy,
    });
    const near = assembled.items.filter((i) => i.category === 'neighborhood');
    expect(near.map((i) => i.nodeId)).toEqual(['glanced', 'ignored']);
  });
});

function item(
  category: ContextCategory,
  text: string,
  tokens: number,
  score: number,
  classification: ContextItem['classification'] = 'public',
): ContextItem {
  return { category, role: 'data', text, tokens, score, classification };
}

describe('the token budget', () => {
  it('never exceeds the ceiling, and accounts for every item', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      item(CATEGORY_ORDER[i % CATEGORY_ORDER.length]!, `item ${i}`, 7 + (i % 5), 60 - i),
    );
    const assembled = budgetContext(items, { ceiling: 100 });
    expect(assembled.tokens).toBeLessThanOrEqual(100);
    expect(assembled.tokens).toBe(assembled.items.reduce((a, i) => a + i.tokens, 0));
    expect(assembled.items.length + assembled.dropped.length).toBe(items.length);
    expect(new Set([...assembled.items, ...assembled.dropped]).size).toBe(items.length);
  });

  it('keeps retrieval from crowding out the lineage slice, with or without a floor', () => {
    // Every retrieved chunk outranks every ancestor by a hundred to one. The
    // PRD asks for a floor to survive this; the priority order survives it
    // alone, because a category is exhausted before the next is looked at.
    const evidence = Array.from({ length: 40 }, (_, i) =>
      item('evidence', `evidence ${i}`, 10, 100 - i),
    );
    const lineage = Array.from({ length: 6 }, (_, i) => item('lineage', `lineage ${i}`, 10, 1));

    const ungoverned = budgetContext([...evidence, ...lineage], { ceiling: 200 });
    expect(ungoverned.byCategory.lineage).toBe(60);

    const governed = budgetContext([...evidence, ...lineage], {
      ceiling: 200,
      floors: { lineage: 60 },
    });
    expect(governed.byCategory.lineage).toBe(60);
    expect(governed.tokens).toBeLessThanOrEqual(200);
  });

  it('is what stops a large lineage slice ending the budget before memory', () => {
    // The failure the floors are actually load-bearing against: four hundred
    // ancestors, and the analyst's own stated thesis never reaches the prompt.
    const lineage = Array.from({ length: 400 }, (_, i) => item('lineage', `lineage ${i}`, 10, 1));
    const memory = [item('memory', 'Thesis: memory pricing turns in H2.', 10, 2)];
    const evidence = [item('evidence', 'a broker note', 10, 2)];
    const all = [...lineage, ...memory, ...evidence];

    const ungoverned = budgetContext(all, { ceiling: 1000 });
    expect(ungoverned.byCategory.lineage).toBe(1000);
    expect(ungoverned.byCategory.memory).toBe(0);
    expect(ungoverned.byCategory.evidence).toBe(0);

    const governed = budgetContext(all, { ceiling: 1000, floors: { memory: 10, evidence: 10 } });
    expect(governed.byCategory.memory).toBe(10);
    expect(governed.byCategory.evidence).toBe(10);
    expect(governed.byCategory.lineage).toBe(980);
    expect(governed.tokens).toBe(1000);
  });

  it('releases a floor the category does not use', () => {
    const items = [
      item('lineage', 'the only ancestor', 10, 1),
      ...Array.from({ length: 20 }, (_, i) => item('evidence', `evidence ${i}`, 10, 100 - i)),
    ];
    const assembled = budgetContext(items, { ceiling: 100, floors: { lineage: 80 } });
    expect(assembled.byCategory.lineage).toBe(10);
    // The 70 tokens lineage did not want went to evidence, not to nobody.
    expect(assembled.byCategory.evidence).toBe(90);
    expect(assembled.tokens).toBe(100);
  });

  it("spends a floor on the category's own best items", () => {
    const items = [
      item('lineage', 'weak ancestor', 10, 0.1),
      item('lineage', 'strong ancestor', 10, 9),
      ...Array.from({ length: 20 }, (_, i) => item('evidence', `evidence ${i}`, 10, 100 - i)),
    ];
    const assembled = budgetContext(items, { ceiling: 200, floors: { lineage: 10 } });
    const kept = assembled.items.filter((i) => i.category === 'lineage');
    expect(kept.map((i) => i.text)).toContain('strong ancestor');
  });

  it('never splits an item', () => {
    const items = [item('lineage', 'a', 30, 1), item('lineage', 'b', 30, 0.5)];
    const assembled = budgetContext(items, { ceiling: 45 });
    expect(assembled.items).toHaveLength(1);
    expect(assembled.items[0]!.tokens).toBe(30);
    expect(assembled.dropped).toHaveLength(1);
  });

  it("emits in the PRD's priority order", () => {
    const items = [
      item('evidence', 'e', 5, 1),
      item('memory', 'm', 5, 1),
      item('question', 'q', 5, 1),
      item('neighborhood', 'n', 5, 1),
      item('lineage', 'l', 5, 1),
    ];
    const assembled = budgetContext(items, { ceiling: 100 });
    expect(assembled.items.map((i) => i.category)).toEqual([...CATEGORY_ORDER]);
  });
});

describe('the classification', () => {
  it('is the most sensitive class actually kept', () => {
    const assembled = budgetContext(
      [
        item('question', 'q', 5, 1, 'public'),
        item('lineage', 'l', 5, 1, 'licensed'),
        item('lineage', 'p', 5, 1, 'positions'),
      ],
      { ceiling: 100 },
    );
    expect(assembled.classification).toBe('positions');
  });

  it('does not report a class that was dropped', () => {
    const assembled = budgetContext(
      [
        item('question', 'q', 5, 10, 'public'),
        item('evidence', 'mnpi', 5000, 10, 'mnpi_risk'),
      ],
      { ceiling: 10 },
    );
    expect(assembled.items.map((i) => i.text)).toEqual(['q']);
    expect(assembled.classification).toBe('public');
  });

  it('travels from the node through the assembled context', () => {
    const doc = chain();
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      classify: (node) => (node.id === 'source' ? 'mnpi_risk' : 'public'),
      policy: roomy,
    });
    expect(assembled.items.find((i) => i.nodeId === 'source')!.classification).toBe('mnpi_risk');
    expect(assembled.classification).toBe('mnpi_risk');
  });
});

describe('assembleContext', () => {
  it('puts the question first and never drops it', () => {
    const doc = chain();
    const assembled = assembleContext({
      doc,
      question: 'why is beta 1.4?',
      selected: ['beta'],
      evidence: Array.from({ length: 50 }, (_, i) => ({ text: `long chunk ${i}`, score: 1000 })),
      policy: { ceiling: 40 },
    });
    expect(assembled.items[0]!.text).toBe('Question: why is beta 1.4?');
  });

  it('ignores a selection that is not on the canvas', () => {
    const assembled = assembleContext({
      doc: chain(),
      question: 'q',
      selected: ['beta', 'ghost'],
      policy: roomy,
    });
    expect(assembled.items.map((i) => i.nodeId)).not.toContain('ghost');
  });

  it("uses the caller's tokenizer when it is given one", () => {
    const counted: string[] = [];
    const assembled = assembleContext({
      doc: chain(),
      question: 'q',
      selected: ['beta'],
      countTokens: (text) => {
        counted.push(text);
        return text.split(/\s+/).length;
      },
      policy: roomy,
    });
    expect(counted.length).toBeGreaterThan(0);
    expect(assembled.tokens).toBe(assembled.items.reduce((a, i) => a + i.tokens, 0));
    expect(assembled.tokens).not.toBe(
      assembled.items.reduce((a, i) => a + approximateTokens(i.text), 0),
    );
  });

  it('takes the latest value from the caller, since a node does not hold one', () => {
    const assembled = assembleContext({
      doc: chain(),
      question: 'q',
      selected: ['beta'],
      latestValue: (node) => (node.id === 'beta' ? 1.4 : undefined),
      policy: roomy,
    });
    const selected = assembled.items.find((i) => i.nodeId === 'beta')!;
    expect(selected.text).toContain('value=1.4');
    expect(assembled.items.find((i) => i.nodeId === 'factor')!.text).toContain('status=');
  });

  it('carries the pinned canvas memory ahead of retrieved evidence', () => {
    const assembled = assembleContext({
      doc: chain(),
      question: 'q',
      selected: ['beta'],
      memory: ['Thesis: memory pricing turns in H2.', 'Constraint: no single name over 5%.'],
      evidence: [{ text: 'a broker note', score: 1000 }],
      policy: roomy,
    });
    const categories = assembled.items.map((i) => i.category);
    expect(categories.indexOf('memory')).toBeLessThan(categories.indexOf('evidence'));
    const memory = assembled.items.filter((i) => i.category === 'memory');
    expect(memory.map((i) => i.text)).toEqual([
      'Canvas memory: Thesis: memory pricing turns in H2.',
      'Canvas memory: Constraint: no single name over 5%.',
    ]);
  });
});

describe('the analyst margin (PRD 3.2.5)', () => {
  it('never renders a note as a param assignment', () => {
    const doc = chain();
    addNode(doc, note('margin', 'GM probably 71'));
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      neighborhood: { margin: { sinceEditMs: 0, seenThisSession: true, distance: 100 } },
      policy: roomy,
    });
    const item = assembled.items.find((i) => i.nodeId === 'margin')!;
    // The laundering path: `margin TextPad text=GM probably 71`, which reads
    // exactly like a calibrated param.
    expect(item.text).not.toContain('text=GM probably 71');
    expect(item.text).toContain(NOTE_FRAMING);
    expect(item.text).toContain('GM probably 71');
    expect(item.role).toBe('intent');
  });

  it('is the only producer of an intent item', () => {
    const doc = chain();
    addNode(doc, note('margin', 'watch the March expiry'));
    attach(doc, 'margin', 'beta');
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      memory: ['Thesis: memory pricing turns in H2.'],
      evidence: [{ text: 'a broker note', score: 1 }],
      policy: roomy,
    });
    const intent = assembled.items.filter((i) => i.role === 'intent');
    // The note and the pinned memory: both are what the analyst believes.
    expect(intent.map((i) => i.category).sort()).toEqual(['memory', 'question']);
    for (const i of assembled.items.filter((i) => i.role === 'data')) {
      expect(i.text).not.toContain(NOTE_FRAMING);
    }
  });

  it('refuses a node that is not loose, so a computed value cannot pose as a belief', () => {
    const computed = createNode({
      id: 'px',
      kind: 'TextPad',
      binding: 'wired',
      params: { text: 'revenue 71' },
    });
    expect(() => analystNote(computed)).toThrow(NotALooseNote);
    expect(noteText(computed)).toBeUndefined();
  });

  it('refuses a loose shape with no recognized text, rather than inventing one', () => {
    const shape = createNode({ id: 'blob', kind: 'InkLayer', binding: 'loose' });
    expect(() => analystNote(shape)).toThrow(NotALooseNote);
    expect(() => analystNote(note('empty', '   '))).toThrow(NotALooseNote);
  });

  it('still summarizes a loose object that carries no text', () => {
    const doc = chain();
    addNode(doc, createNode({ id: 'blob', kind: 'InkLayer', binding: 'loose' }));
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      neighborhood: { blob: { sinceEditMs: 0, seenThisSession: false, distance: 10 } },
      policy: roomy,
    });
    const item = assembled.items.find((i) => i.nodeId === 'blob')!;
    expect(item.role).toBe('data');
    expect(item.text).toContain('Nearby:');
  });

  it('travels with the node the arrow attaches it to', () => {
    const doc = chain();
    addNode(doc, note('why', 'dealer gamma flips near 1150'));
    attach(doc, 'why', 'factor');
    const assembled = assembleContext({ doc, question: 'q', selected: ['beta'], policy: roomy });
    const item = assembled.items.find((i) => i.nodeId === 'why')!;
    // Filed with `factor`, the node it points at, not behind the neighborhood.
    expect(item.category).toBe('lineage');
    expect(item.text).toContain('on factor');
    const factor = assembled.items.find((i) => i.nodeId === 'factor')!;
    expect(item.score).toBeLessThan(factor.score);
    expect(assembled.items.indexOf(item)).toBe(assembled.items.indexOf(factor) + 1);
  });

  it('is budgeted with its node rather than behind every other category', () => {
    const doc = chain();
    addNode(doc, note('why', 'dealer gamma flips near 1150'));
    attach(doc, 'why', 'beta');
    const wide = assembleContext({ doc, question: 'q', selected: ['beta'], policy: roomy });
    const need = wide.items
      .filter((i) => i.category === 'question')
      .reduce((a, i) => a + i.tokens, 0);
    const tight = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      evidence: Array.from({ length: 20 }, (_, i) => ({ text: `chunk ${i}`, score: 1000 })),
      policy: { ceiling: need },
    });
    expect(tight.items.map((i) => i.nodeId)).toContain('why');
    expect(tight.byCategory.evidence).toBe(0);
  });

  it('does not list a note twice when it is both attached and nearby', () => {
    const doc = chain();
    addNode(doc, note('why', 'dealer gamma flips near 1150'));
    attach(doc, 'why', 'beta');
    const assembled = assembleContext({
      doc,
      question: 'q',
      selected: ['beta'],
      neighborhood: { why: { sinceEditMs: 0, seenThisSession: true, distance: 5 } },
      policy: roomy,
    });
    expect(assembled.items.filter((i) => i.nodeId === 'why')).toHaveLength(1);
  });

  it('ignores a note attached to a node that is not in the context', () => {
    const doc = chain();
    addNode(doc, note('why', 'about the conclusion, not the input'));
    attach(doc, 'why', 'conclusion');
    const assembled = assembleContext({ doc, question: 'q', selected: ['beta'], policy: roomy });
    expect(assembled.items.map((i) => i.nodeId)).not.toContain('why');
  });
});
