/**
 * The margin seam: a handwritten note reaching the model without becoming data.
 *
 * PRD 3.2.5 is the highest-value claim in the whiteboard layer and the easiest
 * to break by accident: "the context builder (section 4.6) ingests recognized
 * text from loose objects in the spatial neighborhood, tagged `analyst_note`,
 * with a hard constraint: **notes are treated as intent and hypothesis, never
 * as data.** A handwritten 'GM probably 71' never becomes a number in a
 * computation."
 *
 * Both halves of that cross package boundaries, in opposite directions.
 * *Reaching* the model runs `canvas-ink` -> `canvas-core` -> `canvas-agents`:
 * the recognizer produces a note, the arrow carries the tag onto an edge, and
 * the context builder reads the tag from the edge without ever having seen the
 * gesture that produced it. *Never as data* is enforced in three separate
 * places — the serializer, the wire gate, the reconciler — and each of them is
 * in a different module from the one the analyst's number entered by.
 *
 * Every unit suite here passes with the tag dropped between packages, which is
 * exactly the bug this file exists to catch.
 */

import { describe, expect, it } from 'vitest';
import {
  addNode,
  createDocument,
  createNode,
  edgeFromArrow,
  resolveDrawnArrow,
  type CanvasDocument,
  type PicassoNode,
} from '@picasso/canvas-core';
import { accept, propose, recognizeShape } from '@picasso/canvas-ink';
import {
  NOTE_FRAMING,
  assembleContext,
  checkWire,
  extractAssumptions,
  reconcile,
  type CellReading,
  type Fact,
} from '@picasso/canvas-agents';
import { mulberry32, scribble } from './strokes.js';

const NOTE = 'GM probably 71';

/** A scribble nobody can read, carrying words somebody can. */
function scribbledNote(id: string): PicassoNode {
  const points = scribble(mulberry32(7));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const proposal = propose({
    shape: recognizeShape(points),
    text: NOTE,
    raw: { kind: 'note', text: NOTE },
    resolve: () => [],
    strokeIds: ['s-margin'],
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  });
  // A note asserts nothing about the world, so the recognizer's uncertainty
  // does not block it. That is what makes it the safe reading.
  expect(proposal.acceptable).toBe(true);
  return accept(proposal, id, 'maya').node;
}

function segmentNode(): PicassoNode {
  return createNode({
    id: 'gm-seg',
    kind: 'TransformNode',
    binding: 'wired',
    inputs: [{ id: 'series', name: 'series', type: 'series', cardinality: 'one', required: true }],
    outputs: [{ id: 'out', name: 'out', type: 'scalar', cardinality: 'one', required: false }],
    params: { basis: 'gaap' },
  });
}

/** The canvas: one computed node, one margin note, one arrow between them. */
function canvas(): { doc: CanvasDocument; note: PicassoNode } {
  const doc = createDocument('canvas-margin');
  const target = addNode(doc, segmentNode());
  const note = addNode(doc, scribbledNote('note-margin'));
  const resolution = resolveDrawnArrow(note, target);
  expect(resolution.class).toBe('reference');
  expect(resolution.contextTag).toBe('analyst_note');
  doc.edges.set(
    'a1',
    edgeFromArrow(
      'a1',
      { nodeId: note.id, portId: 'out' },
      { nodeId: target.id, portId: 'series' },
      resolution,
    ),
  );
  return { doc, note };
}

describe('a note the analyst drew an arrow from', () => {
  it('arrives loose, with the recognized text on it', () => {
    const note = scribbledNote('note-margin');
    expect(note.binding).toBe('loose');
    expect(note.params.text).toBe(NOTE);
  });

  it('carries its tag from the gesture onto the edge', () => {
    const { doc } = canvas();
    const edge = doc.edges.get('a1')!;
    // The context builder runs minutes or days later and never saw the arrow
    // being drawn. Everything below depends on this line.
    expect(edge.class).toBe('reference');
    expect(edge.contextTag).toBe('analyst_note');
  });

  it('reaches the prompt, framed as intent', () => {
    const { doc } = canvas();
    const context = assembleContext({
      doc,
      question: 'what is segment gross margin?',
      selected: ['gm-seg'],
      policy: { ceiling: 10_000 },
    });
    const item = context.items.find((i) => i.nodeId === 'note-margin')!;
    expect(item).toBeDefined();
    expect(item.role).toBe('intent');
    expect(item.text).toContain(NOTE_FRAMING);
    expect(item.text).toContain(NOTE);
    expect(item.text).toContain('on gm-seg');
  });

  it('is never serialized as a param, which is the quiet way it becomes data', () => {
    const { doc } = canvas();
    const context = assembleContext({
      doc,
      question: 'what is segment gross margin?',
      selected: ['gm-seg'],
      neighborhood: {
        'note-margin': { sinceEditMs: 0, seenThisSession: true, distance: 20 },
      },
      policy: { ceiling: 10_000 },
    });
    const prompt = context.items.map((i) => i.text).join('\n');
    // `note-margin TextPad text=GM probably 71` reads exactly like a param the
    // analyst calibrated. The number may appear; the assignment may not.
    expect(prompt).not.toContain('text=GM probably 71');
    expect(prompt).toContain(NOTE);
    expect(context.items.filter((i) => i.nodeId === 'note-margin')).toHaveLength(1);
  });

  it('is listed by the Critic as a belief to test', () => {
    const { doc } = canvas();
    const notes = extractAssumptions(doc).filter((a) => a.kind === 'analyst_note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.nodeId).toBe('gm-seg');
    expect(notes[0]!.description).toContain(NOTE);
  });
});

describe('the number in the note', () => {
  const noteFact: Fact = {
    id: 'f-gm',
    claim: 'segment gross margin',
    value: { number: 71, unit: 'pct', asof: '2026-03-11' },
    provenance: { kind: 'note', nodeId: 'note-margin' },
    confidence: 0.5,
    contested: false,
    assertedBy: 'extractor',
    at: 1,
  };

  it('cannot be wired into a computation, with or without an override', () => {
    const { doc } = canvas();
    const mc = addNode(
      doc,
      createNode({
        id: 'mc',
        kind: 'MonteCarloNode',
        binding: 'wired',
        inputs: [{ id: 'gm', name: 'gm', type: 'scalar', cardinality: 'one', required: true }],
      }),
    );
    const wire = {
      id: 'e-compute',
      from: { nodeId: 'note-margin', portId: 'out' },
      to: { nodeId: mc.id, portId: 'gm' },
      class: 'data' as const,
      unverifiedOverride: {
        approvedBy: 'maya',
        approvedAt: 1_770_000_000_000,
        reason: 'it is my own note and I believe it',
      },
    };
    const decision = checkWire(noteFact, mc, wire);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.needsOverride).toBe(false);
  });

  it('cannot be reported in the narrative as a measured figure', () => {
    const text = `Segment gross margin is 71 percent.`;
    const start = text.indexOf('71');
    const cells: CellReading[] = [];
    const result = reconcile({
      narrative: { text, handles: [{ factId: 'f-gm', start, end: start + 2 }] },
      facts: [noteFact],
      cells,
    });
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.kind === 'note_as_data')!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('block');
    expect(finding.message).toContain('note-margin');
  });
});
