/**
 * Synthesis (PRD 5.7, step 6).
 *
 * > **Synthesize.** Answer written into a `TextPad` with inline provenance
 * > handles. Every number is clickable and flies the viewport to its source
 * > node.
 *
 * The Reconciler already holds the hard part: a narrative arrives as text plus
 * spans, every numeral lies inside a span, and every span names the fact it
 * renders. What is missing between that and the PRD's sentence is short and
 * entirely about what cannot happen.
 *
 * ## The TextPad is not reachable from an unreconciled draft
 *
 * `materialize` takes a `ReconcileResult` and refuses one that did not pass.
 * The pipeline's own order says the answer is written after reconciliation,
 * and an order written down in a comment is an order until somebody adds a
 * fast path. Here the function cannot be called without the evidence that the
 * check ran: passing `{ ok: true, findings: [] }` by hand is possible and is
 * the sort of thing a reviewer sees, where a forgotten call is not.
 *
 * ## A handle resolves to a place, or it is not a handle
 *
 * "Every number is clickable" is a claim about *every* number, so a span whose
 * fact traces to a node that is no longer on the canvas is a broken link, and
 * the honest thing is to say so rather than to render a handle that does
 * nothing when the analyst clicks it. `materialize` reports those separately
 * instead of dropping them, because a number nobody can trace should look
 * different from one nobody clicked.
 *
 * ## The viewport is computed at the click, not at the write
 *
 * A handle stores where the source *is*, not the viewport that would frame it.
 * A viewport captured at synthesis is wrong as soon as the analyst zooms, and
 * a number that flies somewhere slightly wrong is worse than one that does not
 * fly: it lands the analyst on a different node and tells them nothing has
 * moved. `flyToSource` takes the viewport as it is now.
 */

import {
  flyTo,
  nodeRect,
  type CanvasDocument,
  type NodeID,
  type PicassoNode,
  type Viewport,
} from '@picasso/canvas-core';
import { createNode } from '@picasso/canvas-core';
import type { Fact } from './blackboard.js';
import type { Handle, Narrative, ReconcileResult } from './reconciler.js';

/** Where a handle points. */
export type HandleTarget =
  | { kind: 'node'; nodeId: NodeID }
  | { kind: 'document'; docId: string; page: number; charStart: number; charEnd: number };

export interface ProvenanceHandle {
  /** The span in the TextPad's text. */
  start: number;
  end: number;
  /** What the analyst sees in that span. */
  text: string;
  factId: string;
  target: HandleTarget;
  /** What the handle's tooltip says, so a hover explains before a click moves. */
  label: string;
}

/** A span that cites a fact whose source is not on this canvas. */
export interface BrokenHandle {
  start: number;
  end: number;
  text: string;
  factId: string;
  reason: string;
}

export class NotReconciled extends Error {
  constructor(readonly findings: ReconcileResult['findings']) {
    const blocking = findings.filter((f) => f.severity === 'block');
    super(
      `the draft has ${blocking.length} blocking finding(s) and cannot be written to a TextPad: ` +
        blocking.map((f) => f.kind).join(', '),
    );
    this.name = 'NotReconciled';
  }
}

export interface MaterializeInput {
  narrative: Narrative;
  /** The result of reconciling *this* narrative. Refused unless it passed. */
  reconciliation: ReconcileResult;
  facts: readonly Fact[];
  doc: CanvasDocument;
  nodeId: NodeID;
  /** Where the answer lands on the canvas. */
  position: { x: number; y: number };
  size?: { w: number; h: number };
  createdBy?: 'user' | 'agent';
}

export interface Synthesized {
  /** The answer, as a node the canvas can hold. */
  node: PicassoNode;
  handles: ProvenanceHandle[];
  /** Spans whose source is not on the canvas. Reported, never silently dropped. */
  broken: BrokenHandle[];
  /** The nodes this answer cites, for the wiring the PRD's t=31s line describes. */
  sources: NodeID[];
}

const DEFAULT_SIZE = { w: 520, h: 320 };

/**
 * Write a reconciled draft into a TextPad with its handles resolved.
 *
 * The node arrives `loose`. An answer is prose: it computes nothing, it has no
 * inputs to invalidate, and binding it would put it in the scheduler with
 * nothing to schedule. The handles are what connect it to the canvas, and they
 * point at nodes that are themselves live.
 */
export function materialize(input: MaterializeInput): Synthesized {
  if (!input.reconciliation.ok) throw new NotReconciled(input.reconciliation.findings);

  const factById = new Map(input.facts.map((f) => [f.id, f]));
  const handles: ProvenanceHandle[] = [];
  const broken: BrokenHandle[] = [];
  const sources: NodeID[] = [];

  for (const handle of [...input.narrative.handles].sort((a, b) => a.start - b.start)) {
    // A `literal` handle is prose the Scribe declared is not a claim — a form
    // number, a quarter. There is nowhere for it to fly to, and rendering it
    // as a dead link would teach the analyst that handles sometimes do
    // nothing.
    if (handle.kind === 'literal') continue;
    const text = input.narrative.text.slice(handle.start, handle.end);
    const fact = factById.get(handle.factId);
    if (!fact) {
      broken.push({ ...spanOf(handle, text), reason: `no fact ${handle.factId} on the board` });
      continue;
    }

    if (fact.provenance.kind === 'document') {
      handles.push({
        ...spanOf(handle, text),
        target: {
          kind: 'document',
          docId: fact.provenance.docId,
          page: fact.provenance.page,
          charStart: fact.provenance.charStart,
          charEnd: fact.provenance.charEnd,
        },
        label: `${fact.claim} — ${fact.provenance.docId} p${fact.provenance.page}`,
      });
      continue;
    }

    if (fact.provenance.kind !== 'cell') {
      // A model-sourced or note-sourced number cannot reach here: the
      // Reconciler blocks both, and `ok` was checked above. Reported rather
      // than assumed away, so a future provenance kind fails loudly.
      broken.push({
        ...spanOf(handle, text),
        reason: `${fact.id} traces to a ${fact.provenance.kind}, which is not a place on the canvas`,
      });
      continue;
    }

    const source = input.doc.nodes.get(fact.provenance.nodeId);
    if (!source) {
      broken.push({
        ...spanOf(handle, text),
        reason: `${fact.provenance.nodeId} is not on this canvas`,
      });
      continue;
    }
    handles.push({
      ...spanOf(handle, text),
      target: { kind: 'node', nodeId: source.id },
      label: `${fact.claim} — ${source.kind} ${source.id}`,
    });
    if (!sources.includes(source.id)) sources.push(source.id);
  }

  const node = createNode({
    id: input.nodeId,
    kind: 'TextPad',
    binding: 'loose',
    position: input.position,
    size: input.size ?? DEFAULT_SIZE,
    params: { text: input.narrative.text },
    createdBy: input.createdBy ?? 'agent',
  });

  return { node, handles, broken, sources };
}

function spanOf(handle: Handle, text: string): { start: number; end: number; text: string; factId: string } {
  return { start: handle.start, end: handle.end, text, factId: handle.factId };
}

/** The handle under a character offset, if the analyst clicked one. */
export function handleAt(
  handles: readonly ProvenanceHandle[],
  offset: number,
): ProvenanceHandle | undefined {
  return handles.find((h) => offset >= h.start && offset < h.end);
}

export class NoPlaceToFly extends Error {
  constructor(readonly handle: ProvenanceHandle, reason: string) {
    super(`${handle.factId} cannot be flown to: ${reason}`);
    this.name = 'NoPlaceToFly';
  }
}

/**
 * The viewport a clicked number flies to.
 *
 * Framing is `canvas-core`'s `flyTo`, not a second implementation of it: a
 * number that lands somewhere slightly different from the command palette's
 * result for the same node is a bug nobody reports and everybody feels.
 */
export function flyToSource(
  doc: CanvasDocument,
  viewport: Viewport,
  handle: ProvenanceHandle,
): Viewport {
  if (handle.target.kind !== 'node') {
    throw new NoPlaceToFly(handle, 'it cites a document, which is not on the canvas');
  }
  const node = doc.nodes.get(handle.target.nodeId);
  if (!node) throw new NoPlaceToFly(handle, `${handle.target.nodeId} is no longer on the canvas`);
  return flyTo(viewport, nodeRect(node));
}
