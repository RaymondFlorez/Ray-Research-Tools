/**
 * TextPad transclusion (PRD 3.3).
 *
 * > `TextPad`: rich text with live transclusion of upstream values
 * > (`{{node.output.value}}`).
 *
 * A transcluded number is a number on screen, so it goes through `present()`
 * like every other one: no source or no as-of, and it does not render. That
 * is the whole reason this lives beside `present()` rather than in a string
 * helper — a TextPad is where a number is most likely to be read without its
 * caption, so it is where the rule matters most.
 *
 * A reference that cannot be honoured renders as a visible marker naming
 * why, never as an empty string or a last-known value. "Revenue grew to {{}}"
 * with the hole silently filled from a stale cache is exactly the confident
 * stale number PRD 7.4 says is worse than none:
 *
 * - a node no longer on the canvas is `missing`;
 * - a `loose` node never computes, so it has no output to show;
 * - a node in `error` shows the error;
 * - a `stale` or `unverified` node shows its value *with* that word, because
 *   the value exists and hiding it would be its own kind of lie.
 *
 * "Live" is re-rendering: `renderTextPad` is pure in the document and the reader, so
 * a changed upstream value is a changed paragraph on the next call, and
 * `transclusions` lists what a pad depends on so the scheduler knows when.
 */

import type { CanvasDocument, NodeID } from '@picasso/canvas-core';
import { present, UntruthfulPresentation, type Origin, type Presented, type Rung } from './degradation.js';

export interface Reference {
  /** Offsets of the whole `{{...}}` in the source text. */
  start: number;
  end: number;
  nodeId: NodeID;
  portId: string;
  field: 'value' | 'asof' | 'source';
}

/** `{{node.port}}` or `{{node.port.field}}`; node ids may not contain dots or braces. */
const PATTERN = /\{\{\s*([^.{}\s]+)\.([^.{}\s]+)(?:\.(value|asof|source))?\s*\}\}/g;

/** Every transclusion in a pad's text, in order. */
export function transclusions(text: string): Reference[] {
  const out: Reference[] = [];
  for (const match of text.matchAll(PATTERN)) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      nodeId: match[1] as NodeID,
      portId: match[2]!,
      field: (match[3] as Reference['field'] | undefined) ?? 'value',
    });
  }
  return out;
}

/** What the runtime holds for a port: the value and where it came from. */
export interface PortReading {
  value: number | string;
  origin: Origin;
}

export type Reader = (nodeId: NodeID, portId: string) => PortReading | undefined;

export type Problem = 'missing' | 'loose' | 'error' | 'not_computed' | 'no_provenance';

export interface RenderedPart extends Reference {
  /** What replaced the reference in the rendered text. */
  text: string;
  presented?: Presented;
  /** Set when the value is shown with a qualifier. */
  qualifier?: 'stale' | 'unverified';
  problem?: Problem;
}

export interface RenderedPad {
  text: string;
  parts: RenderedPart[];
}

/** Renders a pad's text with every reference replaced by a presented value or a marker. */
export function renderTextPad(
  text: string,
  doc: CanvasDocument,
  read: Reader,
  now: number,
  format: (value: number | string) => string = (v) => String(v),
  /**
   * The degradation rung governing each node's value, if any — a live price
   * during a feed outage is transcluded with "stale data" like any tile.
   */
  rungOf: (nodeId: NodeID) => Rung | undefined = () => undefined,
): RenderedPad {
  const parts: RenderedPart[] = [];
  let out = '';
  let cursor = 0;
  for (const ref of transclusions(text)) {
    out += text.slice(cursor, ref.start);
    cursor = ref.end;
    const part = resolve(ref, doc, read, now, format, rungOf(ref.nodeId));
    parts.push(part);
    out += part.text;
  }
  out += text.slice(cursor);
  return { text: out, parts };
}

function resolve(
  ref: Reference,
  doc: CanvasDocument,
  read: Reader,
  now: number,
  format: (value: number | string) => string,
  rung: Rung | undefined,
): RenderedPart {
  const node = doc.nodes.get(ref.nodeId);
  if (!node) return { ...ref, text: `[missing: ${ref.nodeId}]`, problem: 'missing' };
  if (node.binding === 'loose') return { ...ref, text: `[not computed: ${ref.nodeId} is loose]`, problem: 'loose' };
  if (node.state.status === 'error') {
    return { ...ref, text: `[error in ${ref.nodeId}: ${node.state.error?.message ?? 'unknown'}]`, problem: 'error' };
  }
  const reading = read(ref.nodeId, ref.portId);
  if (!reading) return { ...ref, text: `[not computed: ${ref.nodeId}.${ref.portId}]`, problem: 'not_computed' };

  let presented: Presented;
  try {
    presented = present(reading.value, reading.origin, now, rung);
  } catch (error) {
    if (!(error instanceof UntruthfulPresentation)) throw error;
    return { ...ref, text: `[no provenance: ${ref.nodeId}.${ref.portId}]`, problem: 'no_provenance' };
  }

  const qualifier = node.state.status === 'stale' ? 'stale' : node.state.status === 'unverified' ? 'unverified' : undefined;
  const shown =
    ref.field === 'asof' ? presented.asof : ref.field === 'source' ? presented.source : format(presented.value);
  const marks = [qualifier, presented.badge].filter((m): m is string => m !== undefined);
  return {
    ...ref,
    text: marks.length > 0 ? `${shown} (${marks.join(', ')})` : shown,
    presented,
    ...(qualifier ? { qualifier } : {}),
  };
}
