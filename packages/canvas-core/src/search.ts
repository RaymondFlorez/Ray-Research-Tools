/**
 * Spatial search and the command palette (PRD 3.8).
 *
 * > | Command palette | `Cmd K` | Fuzzy search over node types, tickers,
 * > existing nodes, saved templates |
 * > | Spatial search | `Cmd F` | Searches node content and flies to results;
 * > matches glow at any LOD |
 *
 * Both are ranking problems with no UI in them, which is why they are here
 * rather than in the renderer: what a match *is*, and which of several matches
 * comes first, is a property of the canvas and belongs where the canvas lives.
 *
 * ## The matcher
 *
 * Subsequence matching, scored, which is what "fuzzy" means in every palette
 * worth using: `ndv` finds `NVDA` and `esn` finds `EventStudyNode`. Three
 * things drive the score, and they are the three that make a palette feel like
 * it read your mind rather than your keystrokes:
 *
 * - **Contiguity.** A run of adjacent matched characters scores far above the
 *   same characters scattered, so `event` beats `e...v...e...n...t` spread
 *   across a sentence.
 * - **Word starts.** A character matching at the beginning of a word, or at a
 *   camel-case boundary, scores extra. This is what makes initialisms work.
 * - **Earliness.** A match near the front of the candidate beats one buried in
 *   it, because the front of a name is what the analyst was thinking of.
 *
 * Case-insensitive, and an exact case-insensitive prefix short-circuits to the
 * top: somebody who typed the whole word meant the whole word.
 *
 * ## Why the fly-to is not a viewport
 *
 * `flyTo` returns the viewport a result should be framed at, and leaves the
 * animating to the caller. A function that returned "the camera is now here"
 * would have to own the clock, and every caller that wanted to compose the
 * move with something else — a selection change, a second result, a user
 * grabbing the canvas mid-flight — would be fighting it.
 */

import type { CanvasDocument, NodeID, ParamValue, PicassoNode } from './types.js';
import { clampZoom, type Rect, type Viewport } from './viewport.js';

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

export interface FuzzyMatch {
  score: number;
  /** Indices in the candidate that the query matched, in order. */
  positions: number[];
}

const CONTIGUOUS_BONUS = 12;
const WORD_START_BONUS = 9;
const EARLY_BONUS = 4;
const GAP_PENALTY = 1;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] as string;
  const here = text[index] as string;
  if (/[^A-Za-z0-9]/.test(previous)) return true;
  // camelCase and PascalCase: a capital after a lowercase starts a word.
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(here);
}

/**
 * Score `query` against `candidate`, or `undefined` when it is not a
 * subsequence of it.
 *
 * Greedy left-to-right rather than an optimal alignment. An optimal matcher
 * costs O(query x candidate) per candidate and differs from this one on inputs
 * a person does not type; a palette ranking a few thousand candidates on every
 * keystroke is the wrong place to spend that.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | undefined {
  if (query === '') return { score: 0, positions: [] };

  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  const positions: number[] = [];

  let score = 0;
  let cursor = 0;
  let previousIndex = -2;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return undefined;

    if (found === previousIndex + 1) score += CONTIGUOUS_BONUS;
    else score -= Math.min(found - previousIndex - 1, 8) * GAP_PENALTY;
    if (isBoundary(candidate, found)) score += WORD_START_BONUS;
    if (found < 4) score += EARLY_BONUS;

    positions.push(found);
    previousIndex = found;
    cursor = found + 1;
  }

  // Somebody who typed the whole word meant the whole word.
  if (haystack.startsWith(needle)) score += 30;
  if (haystack === needle) score += 40;

  // A short candidate matching the whole query is a better answer than a long
  // one containing it, so length is a mild tiebreak rather than a factor.
  score -= Math.min(candidate.length, 60) / 20;
  return { score, positions };
}

// ---------------------------------------------------------------------------
// The command palette
// ---------------------------------------------------------------------------

export type PaletteKind = 'nodeType' | 'ticker' | 'node' | 'template';

export interface PaletteEntry {
  kind: PaletteKind;
  /** What the analyst sees and types against. */
  label: string;
  /** Extra text to match against but not display, such as a company name. */
  aliases?: readonly string[];
  /** What the caller acts on: a node kind, a ticker, a node id, a template name. */
  value: string;
}

export interface PaletteResult extends PaletteEntry {
  score: number;
  positions: number[];
  /** Which string produced the match: the label, or one of the aliases. */
  matchedOn: string;
}

/**
 * Rank the palette against a query.
 *
 * Kind is a tiebreak and not a filter, because a palette that guesses what the
 * analyst meant by their keystrokes is a palette that hides the thing they
 * wanted. The order is existing nodes, then tickers, then node types, then
 * templates: a node already on the canvas is a thing they can see, and the
 * palette is most often a way of getting back to it.
 */
const KIND_WEIGHT: Record<PaletteKind, number> = {
  node: 3,
  ticker: 2,
  nodeType: 1,
  template: 0,
};

export function searchPalette(
  entries: readonly PaletteEntry[],
  query: string,
  limit = 20,
): PaletteResult[] {
  const results: PaletteResult[] = [];

  for (const entry of entries) {
    let best: { match: FuzzyMatch; on: string } | undefined;
    for (const text of [entry.label, ...(entry.aliases ?? [])]) {
      const match = fuzzyMatch(query, text);
      if (match && (!best || match.score > best.match.score)) best = { match, on: text };
    }
    if (!best) continue;
    results.push({
      ...entry,
      score: best.match.score + KIND_WEIGHT[entry.kind],
      positions: best.match.positions,
      matchedOn: best.on,
    });
  }

  results.sort((a, b) => (b.score - a.score) || (a.label < b.label ? -1 : 1));
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Spatial search
// ---------------------------------------------------------------------------

export interface SpatialHit {
  nodeId: NodeID;
  score: number;
  /** Where the match was found: a param name, or `kind`. */
  field: string;
  /** The matched text, for the result list. */
  text: string;
  positions: number[];
}

function searchableText(node: PicassoNode): Array<{ field: string; text: string }> {
  const fields: Array<{ field: string; text: string }> = [{ field: 'kind', text: node.kind }];
  const push = (field: string, value: ParamValue): void => {
    if (typeof value === 'string') fields.push({ field, text: value });
    else if (typeof value === 'number' || typeof value === 'boolean') {
      fields.push({ field, text: String(value) });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => push(`${field}[${index}]`, item as ParamValue));
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) push(`${field}.${key}`, inner);
    }
  };
  for (const [name, value] of Object.entries(node.params)) push(name, value);
  return fields;
}

/**
 * "Searches node content and flies to results."
 *
 * Content means the node's kind and every string reachable from its params,
 * nested arrays and objects included — a chart's metric list is content, and a
 * search that only looked at top-level strings would miss it. Values are
 * searched, not just keys, because the analyst is looking for NVDA and not for
 * the word "instrument".
 */
export function searchCanvas(
  doc: CanvasDocument,
  query: string,
  limit = 50,
): SpatialHit[] {
  if (query.trim() === '') return [];
  const hits: SpatialHit[] = [];

  for (const node of doc.nodes.values()) {
    let best: SpatialHit | undefined;
    for (const { field, text } of searchableText(node)) {
      const match = fuzzyMatch(query, text);
      if (!match) continue;
      // A param match beats a kind match: somebody searching a canvas is
      // usually looking for a subject, not for a node type. The palette is
      // where node types are found.
      const score = match.score + (field === 'kind' ? 0 : 6);
      if (!best || score > best.score) {
        best = { nodeId: node.id, score, field, text, positions: match.positions };
      }
    }
    if (best) hits.push(best);
  }

  hits.sort((a, b) => (b.score - a.score) || (a.nodeId < b.nodeId ? -1 : 1));
  return hits.slice(0, limit);
}

/** Scale at which a result is framed, when its own size does not decide. */
export const FLY_TO_PADDING = 1.6;

/**
 * The viewport that frames a rectangle, for the caller to animate toward.
 *
 * Zoom is chosen to fit the rectangle with padding and then clamped to the
 * canvas's zoom range, which matters at both ends: a single small node would
 * otherwise fly to a scale where nothing around it is legible, and a frame
 * spanning the whole canvas to one where it is a speck.
 */
export function flyTo(viewport: Viewport, target: Rect, padding = FLY_TO_PADDING): Viewport {
  const width = Math.max(target.maxX - target.minX, 1);
  const height = Math.max(target.maxY - target.minY, 1);
  const scale = clampZoom(
    Math.min(viewport.width / (width * padding), viewport.height / (height * padding)),
  );

  const centreX = (target.minX + target.maxX) / 2;
  const centreY = (target.minY + target.maxY) / 2;
  return {
    ...viewport,
    scale,
    x: centreX - viewport.width / (2 * scale),
    y: centreY - viewport.height / (2 * scale),
  };
}

/** The rectangle covering a set of nodes, for framing several results at once. */
export function boundsOf(doc: CanvasDocument, ids: Iterable<NodeID>): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const id of ids) {
    const node = doc.nodes.get(id);
    if (!node) continue;
    found = true;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.size.w);
    maxY = Math.max(maxY, node.position.y + node.size.h);
  }

  return found ? { minX, minY, maxX, maxY } : undefined;
}
