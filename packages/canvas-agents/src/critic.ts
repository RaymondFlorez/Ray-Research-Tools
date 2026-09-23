/**
 * The Critic (PRD 4.5, Appendix C.5).
 *
 * "Attack the emerging conclusion: find the strongest disconfirming evidence,
 * name the assumptions that carry the argument."
 *
 * C.5 resolves how independent the model behind it has to be, and the answer
 * that matters for this file is the second half of the decision: "move the
 * mechanical part of the Critic's job off the model entirely... Roughly half
 * of what the Critic contributes is deterministic and does not need a frontier
 * model at all... These run at every tier, including tier 4 and including full
 * frontier outage."
 *
 * So this module is mostly not about models. Assumption extraction is a graph
 * traversal, the base rate is a database query, disconfirming retrieval is a
 * search with the thesis negated, and the sensitivity sweep is a loop over
 * re-evaluations. All four run with no model at all, which is the property
 * being claimed — and the test for it is that `critique()` produces every
 * section with `model: undefined`, not that it degrades gracefully.
 *
 * The prose argument is the only part that needs a model, and the output
 * always states which tier produced it, because a `reduced independence`
 * critique read as an independent one is worse than no critique.
 */

import type { CanvasDocument, NodeID } from '@picasso/canvas-core';
import type { Model } from '@picasso/canvas-router';
import { trackRecord, type Scored } from '@picasso/canvas-hypothesis';

/** C.5's ladder, best first. */
export type IndependenceTier = 1 | 2 | 3 | 4;

export const TIER_LABEL: Record<IndependenceTier, string> = {
  1: 'independent critique',
  2: 'partially independent',
  3: 'reduced independence',
  4: 'reduced independence, open-weight',
};

export interface TierChoice {
  tier: IndependenceTier;
  label: string;
  model?: Model;
  /** Why this tier and not a better one. */
  reason: string;
  /** Tier 3 runs the author's own model adversarially. */
  settings?: { temperature: number; seed: number; adversarialPrompt: true };
}

/** Frontier here means "the vendor-hosted top tier", which is what C.5's ladder means by it. */
function isFrontier(model: Model): boolean {
  return model.placement === 'vendor';
}

/**
 * Pick the highest available tier.
 *
 * The ladder is ordered by how uncorrelated the critic's failures are with the
 * author's, so it is walked strictly in order and never scored. A cheaper
 * model at a worse tier is not a trade the Critic gets to make: the whole
 * value of the role is the uncorrelated blind spots, and a score that can
 * exchange independence for cost will exchange it every time.
 */
export function chooseTier(author: Model, available: readonly Model[], seed = 7): TierChoice {
  const others = available.filter((m) => m.id !== author.id);

  const differentVendor = others.filter((m) => isFrontier(m) && m.vendor !== author.vendor);
  const best = pickBest(differentVendor);
  if (best) {
    return {
      tier: 1,
      label: TIER_LABEL[1],
      model: best,
      reason: `${best.id} is frontier and runs at ${best.vendor}, not ${author.vendor}`,
    };
  }

  const sameVendorOtherFamily = others.filter(
    (m) =>
      m.vendor === author.vendor &&
      author.family !== undefined &&
      m.family !== undefined &&
      m.family !== author.family,
  );
  const cousin = pickBest(sameVendorOtherFamily);
  if (cousin) {
    return {
      tier: 2,
      label: TIER_LABEL[2],
      model: cousin,
      reason: `no second frontier vendor is available; ${cousin.id} is a different family at ${cousin.vendor}`,
    };
  }

  const openLarge = others.filter((m) => m.vendor === 'open' && (m.paramsB ?? 0) >= 70);
  const open = pickBest(openLarge);

  // Tier 3 before tier 4 is C.5's order, and it is the right way round: the
  // author's own model prompted adversarially still reasons at frontier
  // quality about a frontier argument, while a 70B critic is independent but
  // frequently cannot follow the thing it is meant to attack. Both are labelled
  // `reduced independence` precisely because neither is a substitute for tier 1.
  // The author has to actually be up. "Full frontier outage" means the model
  // that wrote the argument is down too, and a tier that silently assumes the
  // author is reachable would report `reduced independence` at the exact
  // moment there is no critic at all.
  const authorAvailable = available.some((m) => m.id === author.id);
  if (authorAvailable && author.quality['critique.redteam'] !== undefined) {
    return {
      tier: 3,
      label: TIER_LABEL[3],
      model: author,
      reason: 'no independent model is available; running the author adversarially at a different seed',
      settings: { temperature: 0.7, seed, adversarialPrompt: true },
    };
  }
  if (open) {
    return {
      tier: 4,
      label: TIER_LABEL[4],
      model: open,
      reason: `falling back to the ${open.paramsB}B open-weight critic`,
    };
  }
  return {
    tier: 4,
    label: TIER_LABEL[4],
    reason: 'no model is available; the deterministic critique runs alone',
  };
}

function pickBest(models: readonly Model[]): Model | undefined {
  return [...models]
    .filter((m) => m.quality['critique.redteam'] !== undefined)
    .sort((a, b) => (b.quality['critique.redteam'] ?? 0) - (a.quality['critique.redteam'] ?? 0))[0];
}

// ---------------------------------------------------------------------------
// 1. Assumption extraction. A graph traversal.
// ---------------------------------------------------------------------------

export interface Assumption {
  nodeId: NodeID;
  kind: 'hand_set_param' | 'weak_mapping' | 'analyst_note';
  /** Param name, or the edge id for a mapping. */
  name: string;
  value?: number;
  /** For a mapping, the R-squared that failed the bar. */
  r2?: number;
  description: string;
}

/** C.5's bar: "every mapping whose estimation R-squared falls below 0.2". */
export const WEAK_MAPPING_R2 = 0.2;

/**
 * Params the analyst set by hand, mappings the data barely supports, and the
 * analyst's own notes.
 *
 * The notes are there because PRD 3.2.5 puts them there: a note "becomes a
 * statement of what the analyst believes, which the Critic is specifically
 * instructed to test". A margin note is the purest assumption on the canvas —
 * it is load-bearing precisely because nothing computed it — and it is the one
 * the analyst is least likely to list when asked what they assumed.
 *
 * A param counts as hand-set when the node has an input port of that name and
 * nothing is wired into it. That is the definition the canvas can actually
 * check: a port with an edge carries whatever upstream computed, and a port
 * without one carries whatever a person typed. Params with no matching port
 * are configuration (a lookback, a random seed), not assumptions about the
 * world, and listing them would bury the four numbers that carry the argument
 * under forty that do not.
 */
export function extractAssumptions(doc: CanvasDocument, scope?: readonly NodeID[]): Assumption[] {
  const inScope = scope ? new Set(scope) : undefined;
  const connected = new Set<string>();
  for (const edge of doc.edges.values()) {
    if (edge.class === 'data') connected.add(`${edge.to.nodeId}|${edge.to.portId}`);
  }

  const assumptions: Assumption[] = [];
  for (const node of doc.nodes.values()) {
    if (inScope && !inScope.has(node.id)) continue;
    if (node.binding === 'loose') continue;
    for (const port of node.inputs) {
      if (connected.has(`${node.id}|${port.id}`)) continue;
      const value = node.params[port.id];
      if (value === undefined || value === null) continue;
      assumptions.push({
        nodeId: node.id,
        kind: 'hand_set_param',
        name: port.id,
        ...(typeof value === 'number' ? { value } : {}),
        description: `${node.kind} ${node.id}: ${port.name} is set to ${JSON.stringify(value)} by hand, not derived`,
      });
    }
  }

  // PRD 3.2.2 and 3.2.5: a note the analyst attached to a node by arrow.
  // Only attached ones, not every loose object on the canvas — the arrow is
  // the analyst saying this note is about that node, and a critique that
  // listed the whole margin would bury the four that carry the argument.
  for (const edge of doc.edges.values()) {
    if (edge.class !== 'reference' || edge.contextTag !== 'analyst_note') continue;
    if (inScope && !inScope.has(edge.to.nodeId)) continue;
    const note = doc.nodes.get(edge.from.nodeId);
    if (!note || note.binding !== 'loose') continue;
    const text = note.params.text;
    if (typeof text !== 'string' || text.trim() === '') continue;
    assumptions.push({
      nodeId: edge.to.nodeId,
      kind: 'analyst_note',
      name: note.id,
      description: `${edge.to.nodeId} carries the analyst's note "${text.trim()}", which is a belief and has not been tested`,
    });
  }

  for (const edge of doc.edges.values()) {
    if (edge.class !== 'causal' || !edge.causal) continue;
    if (inScope && !inScope.has(edge.to.nodeId) && !inScope.has(edge.from.nodeId)) continue;
    const r2 = edge.causal.estimation?.r2;
    if (r2 === undefined || r2 >= WEAK_MAPPING_R2) continue;
    assumptions.push({
      nodeId: edge.to.nodeId,
      kind: 'weak_mapping',
      name: edge.id,
      r2,
      description: `${edge.from.nodeId} -> ${edge.to.nodeId} carries an elasticity of ${edge.causal.elasticity} estimated at R-squared ${r2.toFixed(2)}`,
    });
  }

  return assumptions;
}

// ---------------------------------------------------------------------------
// 2. Base-rate lookup. A database query.
// ---------------------------------------------------------------------------

export interface BaseRate {
  subject: string;
  /** The line the dissent block prints. */
  sentence: string;
  count: number;
  right: number;
}

/**
 * "Query the analyst's own hypothesis tracker for prior calls of the same
 * shape and report their hit rate... in the section 6 walkthrough it produced
 * the single most useful line in the output."
 */
export function baseRate(history: readonly Scored[], subject: string): BaseRate {
  return {
    subject,
    sentence: trackRecord(history, subject),
    count: history.length,
    right: history.filter((h) => h.outcome).length,
  };
}

// ---------------------------------------------------------------------------
// 3. Disconfirming retrieval. A search, not a judgment.
// ---------------------------------------------------------------------------

export interface Evidence {
  id: string;
  text: string;
  score: number;
  source?: string;
}

export type Retrieve = (query: string, limit: number) => readonly Evidence[];

/**
 * Negate a thesis well enough to retrieve against it.
 *
 * Not natural-language understanding — a lookup table of the directional words
 * a thesis is actually written with, and a blunt fallback when none of them
 * appear. The fallback matters more than the table: a retrieval query that
 * silently returns the original thesis would surface *confirming* evidence
 * under a disconfirming heading, which is worse than returning nothing.
 */
const OPPOSITES: ReadonlyArray<readonly [string, string]> = [
  ['above', 'below'],
  ['rise', 'fall'],
  ['rises', 'falls'],
  ['rising', 'falling'],
  ['higher', 'lower'],
  ['increase', 'decrease'],
  ['increases', 'decreases'],
  ['expand', 'contract'],
  ['expands', 'contracts'],
  ['beat', 'miss'],
  ['beats', 'misses'],
  ['outperform', 'underperform'],
  ['outperforms', 'underperforms'],
  ['widen', 'tighten'],
  ['widens', 'tightens'],
  ['strengthen', 'weaken'],
  ['strengthens', 'weakens'],
  ['improve', 'deteriorate'],
  ['improves', 'deteriorates'],
  ['accelerate', 'decelerate'],
  ['accelerates', 'decelerates'],
];

export function negate(thesis: string): string {
  const table = new Map<string, string>();
  for (const [a, b] of OPPOSITES) {
    table.set(a, b);
    table.set(b, a);
  }
  let flipped = false;
  const out = thesis.replace(/[A-Za-z]+/g, (word) => {
    if (flipped) return word;
    const swap = table.get(word.toLowerCase());
    if (!swap) return word;
    flipped = true;
    return isCapitalized(word) ? capitalize(swap) : swap;
  });
  return flipped ? out : `evidence against: ${thesis}`;
}

export function disconfirming(thesis: string, retrieve: Retrieve, limit = 5): Evidence[] {
  return [...retrieve(negate(thesis), limit)].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// 4. Sensitivity sweep. A loop over re-evaluations.
// ---------------------------------------------------------------------------

export interface SweepInput {
  /** Assumptions with a number and a one-standard-deviation step. */
  assumptions: ReadonlyArray<Assumption & { value: number; sigma: number }>;
  /** Recompute the conclusion metric with one assumption moved. */
  evaluate: (override: { nodeId: NodeID; name: string; value: number }) => number;
  /** Whether the conclusion still stands at that metric. */
  holds: (metric: number) => boolean;
}

export interface Flip {
  nodeId: NodeID;
  name: string;
  direction: 'up' | 'down';
  from: number;
  to: number;
  metric: number;
}

export interface Sweep {
  flips: Flip[];
  /** Assumptions that survived both directions, with the closer margin. */
  robust: Array<{ nodeId: NodeID; name: string; worstMetric: number }>;
}

/**
 * "Perturb each load-bearing assumption by one standard deviation and report
 * which single change flips the conclusion."
 *
 * One at a time, never jointly. A joint sweep finds bigger effects and tells
 * the analyst nothing they can act on, because the answer is always "if four
 * things go against you at once, you are wrong". The single-change form names
 * the one number worth arguing about.
 */
export function sensitivitySweep(input: SweepInput): Sweep {
  const flips: Flip[] = [];
  const robust: Sweep['robust'] = [];
  for (const assumption of input.assumptions) {
    let worst = Number.POSITIVE_INFINITY;
    let flipped = false;
    for (const direction of ['up', 'down'] as const) {
      const to = assumption.value + (direction === 'up' ? assumption.sigma : -assumption.sigma);
      const metric = input.evaluate({ nodeId: assumption.nodeId, name: assumption.name, value: to });
      if (!input.holds(metric)) {
        flipped = true;
        flips.push({
          nodeId: assumption.nodeId,
          name: assumption.name,
          direction,
          from: assumption.value,
          to,
          metric,
        });
      }
      worst = Math.min(worst, metric);
    }
    if (!flipped) robust.push({ nodeId: assumption.nodeId, name: assumption.name, worstMetric: worst });
  }
  return { flips, robust };
}

// ---------------------------------------------------------------------------
// The critique
// ---------------------------------------------------------------------------

export interface Critique {
  tier: TierChoice;
  assumptions: Assumption[];
  baseRate?: BaseRate;
  disconfirming: Evidence[];
  sweep?: Sweep;
  /** The model's argument. Absent at full frontier outage; everything else is not. */
  prose?: string;
  /** What the analyst reads at the top of the dissent block. */
  header: string;
  lines: string[];
}

export interface CritiqueInput {
  thesis: string;
  document: CanvasDocument;
  scope?: readonly NodeID[];
  author: Model;
  available: readonly Model[];
  history?: readonly Scored[];
  retrieve?: Retrieve;
  sweep?: SweepInput;
  prose?: (tier: TierChoice) => string;
  seed?: number;
}

export function critique(input: CritiqueInput): Critique {
  const tier = chooseTier(input.author, input.available, input.seed ?? 7);
  const assumptions = extractAssumptions(input.document, input.scope);
  const rate = input.history ? baseRate(input.history, input.thesis) : undefined;
  const against = input.retrieve ? disconfirming(input.thesis, input.retrieve) : [];
  const sweep = input.sweep ? sensitivitySweep(input.sweep) : undefined;

  const lines: string[] = [];
  if (assumptions.length > 0) {
    lines.push(
      `the argument rests on ${assumptions.length} hand-set input${assumptions.length === 1 ? '' : 's'}: ` +
        assumptions.map((a) => `${a.nodeId}.${a.name}`).join(', '),
    );
  } else {
    lines.push('every input on the path is derived; nothing is hand-set');
  }
  if (rate) lines.push(rate.sentence);
  if (sweep) {
    if (sweep.flips.length === 0) {
      lines.push('no single one-sigma move in any assumption flips the conclusion');
    } else {
      for (const flip of sweep.flips) {
        lines.push(
          `moving ${flip.nodeId}.${flip.name} ${flip.direction} one sigma, to ${flip.to}, flips the conclusion`,
        );
      }
    }
  }
  if (against.length > 0) {
    lines.push(`strongest contradicting evidence: ${against[0]?.text ?? ''}`);
  }

  const prose = input.prose ? input.prose(tier) : undefined;
  return {
    tier,
    assumptions,
    ...(rate ? { baseRate: rate } : {}),
    disconfirming: against,
    ...(sweep ? { sweep } : {}),
    ...(prose !== undefined ? { prose } : {}),
    header: `Dissent — ${tier.label}${tier.model ? ` (${tier.model.id})` : ''}`,
    lines,
  };
}

function isCapitalized(word: string): boolean {
  const first = word.charAt(0);
  return first !== '' && first === first.toUpperCase();
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
