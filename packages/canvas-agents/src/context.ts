/**
 * Context assembly (PRD 4.6).
 *
 * > Prompt context is built from the canvas, not from chat history. The context
 * > builder assembles, in priority order:
 * > 1. The question and the explicitly selected nodes.
 * > 2. The **lineage slice**: all ancestors of selected nodes, serialized as a
 * >    compact typed summary (node kind, params, output schema, latest values),
 * >    not raw data.
 * > 3. The **spatial neighborhood**: nodes within a radius, weighted by recency
 * >    of edit and by whether the analyst has looked at them this session.
 * > 4. Pinned canvas memory: the analyst's stated thesis, constraints, house
 * >    view, and prior conclusions on this canvas.
 * > 5. Retrieved external evidence.
 * >
 * > Token budgeting is greedy under a ceiling with per-category floors so that
 * > retrieval never crowds out the lineage slice. Large tabular data is never
 * > inlined: the model receives a schema, summary statistics, and a tool to
 * > query the table.
 *
 * Four things in that passage are decisions rather than description.
 *
 * ## Ancestors, not descendants
 *
 * "All ancestors of selected nodes" is precise and the obvious generalisation —
 * "everything connected" — is wrong in a way that is hard to see. A selected
 * node's *descendants* are the conclusions drawn from it. Putting them in the
 * context of a question about that node hands the model the answer and asks it
 * to derive it, and what comes back agrees with the canvas because it was read
 * off the canvas. The lineage slice is what the value was computed *from*.
 *
 * ## Floors, and what they actually protect
 *
 * The PRD gives the floors a purpose: "per-category floors so that retrieval
 * never crowds out the lineage slice". Measured against this implementation
 * that is not what they do, because the greedy fill is greedy *within* the
 * priority order — it takes every lineage item it can before it looks at the
 * first retrieved chunk, whatever the scores are. Evidence cannot displace
 * lineage here with or without a floor, and `budgetContext` is tested for it
 * both ways.
 *
 * What can be crowded out is everything below whichever category is large: a
 * selection with four hundred ancestors fills the ceiling and the analyst's
 * own pinned thesis never reaches the prompt. That is the failure the floors
 * are load-bearing against, so they are stated as protecting the tail rather
 * than the head. A category that does not use its floor releases it — a
 * reservation that goes unspent is a ceiling nobody asked for.
 *
 * ## A table is never inlined, structurally
 *
 * `tableContext` is the only way to put a table in a context, and it cannot
 * produce rows: it takes the schema, the summary statistics and the handle of
 * the tool that can query it. The rule is in the constructor rather than in a
 * review comment, for the same reason `present()` is the only way to produce a
 * displayable number.
 *
 * ## A loose note is ingested, and can only arrive as intent
 *
 * PRD 3.2.5 sends the analyst's margin into this builder — "the context
 * builder (section 4.6) ingests recognized text from loose objects in the
 * spatial neighborhood, tagged `analyst_note`" — under a constraint stated in
 * bold: **notes are treated as intent and hypothesis, never as data.**
 *
 * The laundering path is short and quiet. A loose note is a node, a node has
 * params, and its recognized text lives in `params.text`, so the obvious
 * neighborhood loop emits `note-7 TextPad text=GM probably 71` — a param
 * assignment, in the same serialization as a calibrated one, and the model has
 * no way to tell which is which. So a loose node carrying text never reaches
 * `summarizeNode` at all: it is routed through `analystNote`, which is the
 * only producer of an item with `role: 'intent'` and refuses any node that is
 * not loose. Laundering a note into data now requires binding it, which is a
 * thing the analyst does on purpose.
 *
 * ## The classification travels
 *
 * Everything assembled here is about to become a prompt, and what may be in a
 * prompt is exactly what `canvas-guard`'s router gate decides. So each item
 * carries the classification of what it came from and the assembled context
 * reports the combined one. A context builder that dropped it would hand the
 * gate a payload with nothing to check.
 */

import {
  buildAdjacency,
  type CanvasDocument,
  type Edge,
  type NodeID,
  type ParamValue,
  type PicassoNode,
} from '@picasso/canvas-core';

/** Matches `canvas-guard`'s ordering. Kept as data so this package stays below it. */
export type ContextClassification = 'public' | 'licensed' | 'positions' | 'mnpi_risk';

const CLASS_RANK: Record<ContextClassification, number> = {
  public: 0,
  licensed: 1,
  positions: 2,
  mnpi_risk: 3,
};

/** PRD 4.6's five categories, in the order it states them. */
export type ContextCategory =
  | 'question'
  | 'lineage'
  | 'neighborhood'
  | 'memory'
  | 'evidence';

export const CATEGORY_ORDER: readonly ContextCategory[] = [
  'question',
  'lineage',
  'neighborhood',
  'memory',
  'evidence',
];

export interface ContextItem {
  category: ContextCategory;
  /**
   * What the item is for.
   *
   * `data` is something the canvas computed or retrieved. `intent` is
   * something the analyst believes — a margin note, a stated thesis — which
   * the Critic tests and nothing computes with. Required rather than defaulted
   * to `data`, because the default that gets forgotten is the wrong one.
   */
  role: 'data' | 'intent';
  /** What goes in the prompt. */
  text: string;
  /** Estimated tokens. Supplied rather than guessed at, so a caller can use a real tokenizer. */
  tokens: number;
  /** Higher sorts first within a category. */
  score: number;
  classification: ContextClassification;
  nodeId?: NodeID;
}

/**
 * A rough token count, for callers without a tokenizer to hand.
 *
 * Four characters to a token is the usual English approximation and it is an
 * approximation: it under-counts code and over-counts prose with long words.
 * Exposed as a named function rather than applied silently, so a caller with a
 * real tokenizer can pass its numbers instead and a caller without one can see
 * what it is getting.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Building the categories
// ---------------------------------------------------------------------------

/**
 * A node's compact typed summary: kind, params, output schema, latest value.
 *
 * "Not raw data" is the requirement, so this serializes the *shape* and the
 * headline figure. A series contributes its type and its last value, not its
 * ten thousand points.
 *
 * The latest value is supplied rather than read off the node, because a
 * `PicassoNode` does not hold one — `NodeRuntimeState` carries a status, a
 * cache key and a cost, and the value lives wherever the caller computed it.
 * Taking it as an argument keeps that true instead of inventing a field for it
 * here and leaving two places that disagree about where a value lives.
 */
export function summarizeNode(node: PicassoNode, latestValue?: ParamValue): string {
  const params = Object.entries(node.params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${name}=${compactValue(value)}`)
    .join(' ');
  const outputs = node.outputs.map((port) => `${port.id}:${port.type}`).join(',');
  const value =
    latestValue !== undefined
      ? ` value=${compactValue(latestValue)}`
      : ` status=${node.state.status}`;
  return `${node.id} ${node.kind}${params ? ` ${params}` : ''}${outputs ? ` -> ${outputs}` : ''}${value}`;
}

function compactValue(value: ParamValue): string {
  if (typeof value === 'number') return String(Number(value.toPrecision(6)));
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  if (Array.isArray(value)) {
    // A list is summarized rather than inlined, for the same reason a table is.
    return value.length <= 4
      ? `[${value.map((v) => compactValue(v as ParamValue)).join(',')}]`
      : `[${value.length} items]`;
  }
  if (value && typeof value === 'object') return `{${Object.keys(value).length} fields}`;
  return String(value);
}

export interface TableSummary {
  /** Column name to type. */
  schema: Record<string, string>;
  rows: number;
  /** Whatever the caller computed: means, nulls, cardinality. */
  statistics: Record<string, string | number>;
  /** The tool the model calls to ask this table a question. */
  queryTool: string;
}

/**
 * The only way to put a table in a context.
 *
 * It cannot inline rows because it is never given any. PRD 4.6: "large tabular
 * data is never inlined: the model receives a schema, summary statistics, and a
 * tool to query the table." Expressed here rather than in a convention, so a
 * caller holding a million rows has nowhere to put them.
 */
export function tableContext(
  nodeId: NodeID,
  summary: TableSummary,
  classification: ContextClassification,
  score = 0,
): ContextItem {
  const columns = Object.entries(summary.schema)
    .map(([name, type]) => `${name}:${type}`)
    .join(', ');
  const stats = Object.entries(summary.statistics)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  const text =
    `${nodeId} table ${summary.rows} rows [${columns}]` +
    `${stats ? ` stats(${stats})` : ''} query via ${summary.queryTool}`;
  return {
    category: 'lineage',
    role: 'data',
    text,
    tokens: approximateTokens(text),
    score,
    classification,
    nodeId,
  };
}

/**
 * The framing every note carries into the prompt.
 *
 * Stated on the item rather than once at the top of the context, because a
 * budget drops items and a single header that survives while the note it
 * governs does not — or the reverse — is a rule that holds in the common case.
 */
export const NOTE_FRAMING = 'Analyst note (intent, hypothesis; never data)';

export class NotALooseNote extends Error {
  constructor(readonly nodeId: NodeID, detail: string) {
    super(`${nodeId} cannot enter the context as an analyst note: ${detail}`);
    this.name = 'NotALooseNote';
  }
}

/** The recognized text of a loose object, if it has any. */
export function noteText(node: PicassoNode): string | undefined {
  if (node.binding !== 'loose') return undefined;
  const text = node.params.text;
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

/**
 * The only way a note enters a context (PRD 3.2.5).
 *
 * It refuses a node that is not loose, because the whole constraint rests on
 * the distinction: a bound or wired object is something the canvas computes,
 * and calling its output a note would let a computed number arrive stripped of
 * its provenance. It refuses a node with no recognized text for the same
 * reason in the other direction — a shape with no words is not a statement of
 * belief, it is a drawing, and inventing a text for it would put something in
 * the prompt the analyst never wrote.
 *
 * `attachedTo` is set when the analyst drew an arrow from the note to a node
 * (PRD 3.2.2, `contextTag: 'analyst_note'`). It is in the text because the
 * note means something different next to a different node: "watch the March
 * expiry" is about whatever it points at.
 */
export function analystNote(
  node: PicassoNode,
  options: {
    category?: ContextCategory;
    score?: number;
    classification?: ContextClassification;
    attachedTo?: NodeID;
    countTokens?: (text: string) => number;
  } = {},
): ContextItem {
  if (node.binding !== 'loose') {
    throw new NotALooseNote(node.id, `it is ${node.binding}, and a note is a loose object`);
  }
  const body = noteText(node);
  if (body === undefined) {
    throw new NotALooseNote(node.id, 'it carries no recognized text');
  }
  const about = options.attachedTo ? ` on ${options.attachedTo}` : '';
  const text = `${NOTE_FRAMING}${about} — ${node.id}: ${body}`;
  const count = options.countTokens ?? approximateTokens;
  return {
    category: options.category ?? 'neighborhood',
    role: 'intent',
    text,
    tokens: count(text),
    score: options.score ?? 0,
    classification: options.classification ?? 'public',
    nodeId: node.id,
  };
}

export interface NeighborhoodSignal {
  /** Milliseconds since the node was last edited. */
  sinceEditMs: number;
  /** Whether the analyst has looked at it this session. */
  seenThisSession: boolean;
  /** World distance from the selection. */
  distance: number;
}

/**
 * PRD 4.6's weighting for the spatial neighborhood.
 *
 * "Weighted by recency of edit and by whether the analyst has looked at them
 * this session." Recency decays rather than cutting off, because a node edited
 * two hours ago is less relevant than one edited two minutes ago and more
 * relevant than one edited last week — a threshold would make those last two
 * equal. Having been looked at is a flat bonus rather than a multiplier: it
 * says the analyst knows the node exists, which does not become more true the
 * closer the node is.
 */
export const ATTENTION_BONUS = 0.5;
export const RECENCY_HALF_LIFE_MS = 30 * 60_000;

export function neighborhoodScore(signal: NeighborhoodSignal): number {
  const recency = Math.pow(0.5, signal.sinceEditMs / RECENCY_HALF_LIFE_MS);
  const proximity = 1 / (1 + signal.distance / 1000);
  return recency * proximity + (signal.seenThisSession ? ATTENTION_BONUS : 0);
}

// ---------------------------------------------------------------------------
// Budgeting
// ---------------------------------------------------------------------------

export interface BudgetPolicy {
  /** Total token ceiling for the assembled context. */
  ceiling: number;
  /**
   * Tokens reserved per category before anything competes.
   *
   * Absent categories have no floor. A floor larger than the category's own
   * content is released rather than held: a reservation that goes unspent is a
   * ceiling nobody asked for.
   */
  floors?: Partial<Record<ContextCategory, number>>;
}

export interface AssembledContext {
  items: ContextItem[];
  /** Tokens used, which never exceeds the ceiling. */
  tokens: number;
  /** Per-category token usage, for the trace. */
  byCategory: Record<ContextCategory, number>;
  /** Items that did not fit, so a caller can say how much was left out. */
  dropped: ContextItem[];
  /**
   * The most sensitive class present.
   *
   * This is what the router gate reads. A context builder that did not report
   * it would hand the gate a payload with nothing to check.
   */
  classification: ContextClassification;
}

/**
 * Fill the budget: floors first, then greedily by priority.
 *
 * Two passes. The first gives each category up to its floor, in priority order,
 * taking its own highest-scoring items. The second spends whatever is left, in
 * the same priority order, on whatever is still waiting.
 *
 * The second pass is the one that satisfies "retrieval never crowds out the
 * lineage slice": a category is exhausted before the next is looked at, so a
 * retrieved chunk scoring 100 waits behind an ancestor scoring 1. The floors
 * are therefore what a low-priority category has, not what lineage needs —
 * without one, a large lineage slice ends the budget before memory is reached.
 *
 * Items are never split. Half a node summary is not a smaller node summary, it
 * is a truncated one, and a model reading `instrument=eq:nv` does not know that
 * it is reading a fragment.
 */
export function budgetContext(
  items: readonly ContextItem[],
  policy: BudgetPolicy,
): AssembledContext {
  const byCategory = new Map<ContextCategory, ContextItem[]>();
  for (const category of CATEGORY_ORDER) byCategory.set(category, []);
  for (const item of items) {
    const bucket = byCategory.get(item.category);
    if (bucket) bucket.push(item);
  }
  for (const bucket of byCategory.values()) {
    bucket.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : 1));
  }

  const taken = new Set<ContextItem>();
  let used = 0;

  // Pass one: each category's floor, in priority order.
  for (const category of CATEGORY_ORDER) {
    const floor = policy.floors?.[category] ?? 0;
    if (floor <= 0) continue;
    let spent = 0;
    for (const item of byCategory.get(category) ?? []) {
      if (spent + item.tokens > floor) continue;
      if (used + item.tokens > policy.ceiling) continue;
      taken.add(item);
      spent += item.tokens;
      used += item.tokens;
    }
  }

  // Pass two: the remainder, same priority order.
  for (const category of CATEGORY_ORDER) {
    for (const item of byCategory.get(category) ?? []) {
      if (taken.has(item)) continue;
      if (used + item.tokens > policy.ceiling) continue;
      taken.add(item);
      used += item.tokens;
    }
  }

  const chosen: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  const usage: Record<ContextCategory, number> = {
    question: 0,
    lineage: 0,
    neighborhood: 0,
    memory: 0,
    evidence: 0,
  };

  // Emitted in the PRD's priority order, and by score within a category, so the
  // prompt reads the way the specification describes it.
  for (const category of CATEGORY_ORDER) {
    for (const item of byCategory.get(category) ?? []) {
      if (taken.has(item)) {
        chosen.push(item);
        usage[category] += item.tokens;
      } else {
        dropped.push(item);
      }
    }
  }

  let worst: ContextClassification = 'public';
  for (const item of chosen) {
    if (CLASS_RANK[item.classification] > CLASS_RANK[worst]) worst = item.classification;
  }

  return { items: chosen, tokens: used, byCategory: usage, dropped, classification: worst };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export interface ContextInput {
  doc: CanvasDocument;
  question: string;
  /** Nodes the analyst explicitly selected. */
  selected: readonly NodeID[];
  /** Classification per node. Anything absent is `public`. */
  classify?: (node: PicassoNode) => ContextClassification;
  /**
   * The latest value of a node, from wherever the caller holds values.
   *
   * A `PicassoNode` does not carry one, and this package is not the right place
   * to decide that it should.
   */
  latestValue?: (node: PicassoNode) => ParamValue | undefined;
  /** Signals for the spatial neighborhood, by node id. */
  neighborhood?: Record<NodeID, NeighborhoodSignal>;
  /** Pinned canvas memory: thesis, constraints, house view, prior conclusions. */
  memory?: readonly string[];
  /** Retrieved external evidence, already ranked by the retriever. */
  evidence?: ReadonlyArray<{ text: string; score: number }>;
  policy: BudgetPolicy;
  /** Override the token estimate with a real tokenizer. */
  countTokens?: (text: string) => number;
}

/**
 * Ancestors with their distance from the selection.
 *
 * `ancestors()` in `canvas-core` returns a set, which is the right answer to
 * the question it is asked and one fact short of the question here: a lineage
 * slice that does not fit is truncated somewhere, and the right place to cut is
 * the far end. So this is a breadth-first walk that keeps the depth at which
 * each node was first reached — the shortest path, when a node feeds the
 * selection through two routes of different lengths, because the short route is
 * how directly it explains the value.
 */
/**
 * A note ranks immediately below the node it is attached to.
 *
 * Not equal, because a tie sorts by text and would sometimes put the note
 * first; not lower by any visible amount, because the point is that the two
 * are budgeted as one thing.
 */
const NOTE_RANK_EPSILON = 1e-6;

function isNoteEdge(edge: Edge): boolean {
  return edge.class === 'reference' && edge.contextTag === 'analyst_note';
}

function ancestorDepths(doc: CanvasDocument, roots: ReadonlySet<NodeID>): Map<NodeID, number> {
  const adj = buildAdjacency(doc);
  const depth = new Map<NodeID, number>();
  let frontier = [...roots];
  let level = 0;
  while (frontier.length > 0) {
    level += 1;
    const next: NodeID[] = [];
    for (const id of frontier) {
      for (const prev of adj.in.get(id) ?? []) {
        if (depth.has(prev) || roots.has(prev)) continue;
        depth.set(prev, level);
        next.push(prev);
      }
    }
    frontier = next;
  }
  return depth;
}

/**
 * Build the context for a question about a selection.
 *
 * The lineage slice is the selection's **ancestors**. Descendants are the
 * conclusions drawn from the selection, and handing them to a model being asked
 * to derive those conclusions produces agreement rather than analysis.
 */
export function assembleContext(input: ContextInput): AssembledContext {
  const { doc, question, selected } = input;
  const count = input.countTokens ?? approximateTokens;
  const classify = input.classify ?? (() => 'public' as ContextClassification);
  const latest = input.latestValue ?? (() => undefined);
  const items: ContextItem[] = [];

  const questionText = `Question: ${question}`;
  items.push({
    category: 'question',
    role: 'data',
    text: questionText,
    tokens: count(questionText),
    score: Number.POSITIVE_INFINITY,
    classification: 'public',
  });

  const selectedSet = new Set<NodeID>();
  /** Where each node landed, so an attached note can be filed beside it. */
  const placed = new Map<NodeID, { category: ContextCategory; score: number }>();
  for (const id of selected) {
    const node = doc.nodes.get(id);
    if (!node) continue;
    selectedSet.add(id);
    placed.set(id, { category: 'question', score: 1 });
    const text = `Selected: ${summarizeNode(node, latest(node))}`;
    items.push({
      category: 'question',
      role: 'data',
      text,
      tokens: count(text),
      score: 1,
      classification: classify(node),
      nodeId: id,
    });
  }

  // The lineage slice: ancestors only, nearest first.
  for (const [id, depth] of ancestorDepths(doc, selectedSet)) {
    if (selectedSet.has(id)) continue;
    const node = doc.nodes.get(id);
    if (!node) continue;
    placed.set(id, { category: 'lineage', score: 1 / depth });
    const text = `Lineage: ${summarizeNode(node, latest(node))}`;
    items.push({
      category: 'lineage',
      role: 'data',
      text,
      tokens: count(text),
      // Nearer ancestors first: the thing a value was computed from directly
      // explains it better than its grandparent does.
      score: 1 / depth,
      classification: classify(node),
      nodeId: id,
    });
  }

  const noted = new Set<NodeID>();
  for (const [id, signal] of Object.entries(input.neighborhood ?? {})) {
    if (selectedSet.has(id)) continue;
    const node = doc.nodes.get(id);
    if (!node) continue;
    // PRD 3.2.5. A loose object with recognized text is the analyst's margin,
    // and summarizing it as a node would emit `text=GM probably 71` — a param
    // assignment indistinguishable from a calibrated one. It goes through
    // `analystNote` instead, which is the only producer of `role: 'intent'`.
    if (noteText(node) !== undefined) {
      noted.add(id);
      items.push(
        analystNote(node, {
          category: 'neighborhood',
          score: neighborhoodScore(signal),
          classification: classify(node),
          countTokens: count,
        }),
      );
      continue;
    }
    const text = `Nearby: ${summarizeNode(node, latest(node))}`;
    items.push({
      category: 'neighborhood',
      role: 'data',
      text,
      tokens: count(text),
      score: neighborhoodScore(signal),
      classification: classify(node),
      nodeId: id,
    });
  }

  // Notes the analyst attached by arrow travel with the node they point at
  // (PRD 3.2.2), so they are filed in that node's own category rather than in
  // the neighborhood: a note that explains why a param is 1.4 is budgeted
  // beside the node whose param it is, not behind every other nearby object.
  // Scored just under it, so the two survive or fall together.
  for (const edge of doc.edges.values()) {
    if (!isNoteEdge(edge)) continue;
    const host = placed.get(edge.to.nodeId);
    if (!host) continue;
    const note = doc.nodes.get(edge.from.nodeId);
    if (!note || noted.has(note.id) || noteText(note) === undefined) continue;
    noted.add(note.id);
    items.push(
      analystNote(note, {
        category: host.category,
        score: host.score - NOTE_RANK_EPSILON,
        classification: classify(note),
        attachedTo: edge.to.nodeId,
        countTokens: count,
      }),
    );
  }

  for (const [index, note] of (input.memory ?? []).entries()) {
    const text = `Canvas memory: ${note}`;
    items.push({
      category: 'memory',
      // Pinned canvas memory is the analyst's thesis, constraints and house
      // view. Those are beliefs, held to the same rule as a margin note.
      role: 'intent',
      text,
      tokens: count(text),
      score: (input.memory ?? []).length - index,
      classification: 'public',
    });
  }

  for (const found of input.evidence ?? []) {
    const text = `Evidence: ${found.text}`;
    items.push({
      category: 'evidence',
      role: 'data',
      text,
      tokens: count(text),
      score: found.score,
      classification: 'public',
    });
  }

  return budgetContext(items, input.policy);
}
