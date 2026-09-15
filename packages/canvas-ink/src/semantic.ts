/**
 * The semantic pass (PRD 3.2.1, 3.7).
 *
 * "Recognized text plus surrounding shapes go to a small open-weight model
 * with a strict output schema: does this sketch describe a chart, a formula, a
 * scenario, or a note? A sketched box labeled 'NVDA rev growth vs GM,
 * quarterly' becomes a real `ChartNode` with resolved instruments and metrics,
 * **presented as a proposal the analyst accepts or rejects. Nothing
 * auto-materializes without confirmation.**"
 *
 * Three things follow from that paragraph, and they are the whole design.
 *
 * **The output schema is strict, so it is validated here rather than trusted.**
 * A small open-weight model asked for JSON returns something JSON-shaped most
 * of the time. `validate` rejects anything that is not exactly one of the four
 * kinds with the fields that kind requires, and a rejected reading becomes a
 * `note` — the one kind that asserts nothing — rather than a best-effort chart
 * with two of its three fields invented.
 *
 * **Entities resolve against the reference layer, and ambiguity does not
 * resolve.** Same rule as the QueryNode's disambiguation chip: "NVDA rev growth
 * vs GM" has to become a real instrument id and two real metric ids, and a
 * mention with two candidates comes back unresolved so the proposal card can
 * ask. A proposal that silently picked one would be accepted by an analyst who
 * is looking at their own handwriting, not at the resolution.
 *
 * **A proposal is not a node.** `propose` returns a `Proposal`; only `accept`
 * produces a node, and it refuses a proposal carrying unresolved mentions or a
 * confidence below the floor. "Nothing auto-materializes" is a property the
 * type system can carry: there is no path from a sketch to a `PicassoNode`
 * that does not pass through a function named `accept`.
 */

import {
  createNode,
  type Frequency,
  type NodeKind,
  type PicassoNode,
  type Rect,
} from '@picasso/canvas-core';
import { RECOGNITION_FLOOR, type Recognition, type ShapeKind } from './recognize.js';

/** The four readings the schema allows. Nothing else is a valid answer. */
export type SketchKind = 'chart' | 'formula' | 'scenario' | 'note';

export interface ChartReading {
  kind: 'chart';
  /** Mentions as written in the ink, before resolution. */
  subject: string;
  metrics: string[];
  frequency?: Frequency;
}

export interface FormulaReading {
  kind: 'formula';
  expression: string;
  inputs: string[];
}

export interface ScenarioReading {
  kind: 'scenario';
  name: string;
  shocks: Array<{ factor: string; magnitude: string }>;
}

export interface NoteReading {
  kind: 'note';
  text: string;
}

export type Reading = ChartReading | FormulaReading | ScenarioReading | NoteReading;

export interface RawReading {
  kind?: unknown;
  [key: string]: unknown;
}

export class SchemaViolation extends Error {
  constructor(readonly detail: string) {
    super(`the semantic pass returned something the schema does not allow: ${detail}`);
    this.name = 'SchemaViolation';
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate a model's reading against the schema.
 *
 * Returns the reading or throws. The caller in `propose` catches and falls
 * back to a note, which is the only kind that asserts nothing about the world:
 * a malformed chart reading downgraded to a chart with guessed metrics is a
 * proposal the analyst would accept without noticing what was invented.
 */
export function validate(raw: RawReading): Reading {
  switch (raw.kind) {
    case 'chart': {
      if (typeof raw.subject !== 'string' || raw.subject.trim() === '') {
        throw new SchemaViolation('chart reading has no subject');
      }
      if (!isStringArray(raw.metrics) || raw.metrics.length === 0) {
        throw new SchemaViolation('chart reading has no metrics');
      }
      const frequency = raw.frequency;
      if (frequency !== undefined && !isFrequency(frequency)) {
        throw new SchemaViolation(`"${String(frequency)}" is not a frequency`);
      }
      return {
        kind: 'chart',
        subject: raw.subject,
        metrics: raw.metrics,
        ...(frequency !== undefined ? { frequency: frequency as Frequency } : {}),
      };
    }
    case 'formula': {
      if (typeof raw.expression !== 'string' || raw.expression.trim() === '') {
        throw new SchemaViolation('formula reading has no expression');
      }
      if (!isStringArray(raw.inputs)) throw new SchemaViolation('formula reading has no input list');
      return { kind: 'formula', expression: raw.expression, inputs: raw.inputs };
    }
    case 'scenario': {
      if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        throw new SchemaViolation('scenario reading has no name');
      }
      const shocks = raw.shocks;
      if (
        !Array.isArray(shocks) ||
        shocks.length === 0 ||
        !shocks.every(
          (s) =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as Record<string, unknown>).factor === 'string' &&
            typeof (s as Record<string, unknown>).magnitude === 'string',
        )
      ) {
        throw new SchemaViolation('scenario reading has no well-formed shocks');
      }
      return { kind: 'scenario', name: raw.name, shocks: shocks as ScenarioReading['shocks'] };
    }
    case 'note': {
      if (typeof raw.text !== 'string') throw new SchemaViolation('note reading has no text');
      return { kind: 'note', text: raw.text };
    }
    default:
      throw new SchemaViolation(`"${String(raw.kind)}" is not one of chart, formula, scenario, note`);
  }
}

const FREQUENCIES: readonly string[] = [
  'tick',
  'intraday',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annual',
];

function isFrequency(value: unknown): boolean {
  return typeof value === 'string' && FREQUENCIES.includes(value);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface Candidate {
  id: string;
  label: string;
  hint?: string;
}

export type ReferenceResolver = (mention: string, kind: 'instrument' | 'metric') => Candidate[];

export interface ResolvedMention {
  mention: string;
  id: string;
  label: string;
}

export interface UnresolvedMention {
  mention: string;
  candidates: Candidate[];
  reason: 'ambiguous' | 'unknown';
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

export interface Proposal {
  /** What the semantic pass read the sketch as. */
  reading: Reading;
  /** The node kind this would become, if accepted. */
  nodeKind: NodeKind;
  confidence: number;
  resolved: ResolvedMention[];
  unresolved: UnresolvedMention[];
  /** The ink this came from, which stays after acceptance. */
  strokeIds: string[];
  bounds: Rect;
  /** True only when `accept` would succeed. */
  acceptable: boolean;
  /** Why it is not acceptable, for the card. */
  blockedBy?: string;
  /** Set when the model's reading failed the schema and was downgraded. */
  downgradedFrom?: string;
}

export interface ProposeInput {
  /** The geometric pass's answer for the enclosing shape. */
  shape: Recognition;
  /** Text recognized inside or attached to the shape. */
  text: string;
  /** What the small model returned, unvalidated. */
  raw: RawReading;
  resolve: ReferenceResolver;
  strokeIds: readonly string[];
  bounds: Rect;
}

const NODE_KIND: Record<SketchKind, NodeKind> = {
  chart: 'ChartNode',
  formula: 'TransformNode',
  scenario: 'ScenarioNode',
  note: 'TextPad',
};

/**
 * Read a sketch, and produce something the analyst can say yes or no to.
 *
 * The confidence is the geometric pass's, not the model's. A model's stated
 * confidence in its own reading is a number it generated, and the thing that
 * actually predicts whether this sketch is a chart is whether the recognizer
 * is sure it is a rectangle — which is measured.
 */
export function propose(input: ProposeInput): Proposal {
  let reading: Reading;
  let downgradedFrom: string | undefined;
  try {
    reading = validate(input.raw);
  } catch (error) {
    if (!(error instanceof SchemaViolation)) throw error;
    // A malformed reading becomes a note: the one kind that asserts nothing.
    reading = { kind: 'note', text: input.text };
    downgradedFrom = error.detail;
  }

  const resolved: ResolvedMention[] = [];
  const unresolved: UnresolvedMention[] = [];

  if (reading.kind === 'chart') {
    resolveInto(input.resolve, reading.subject, 'instrument', resolved, unresolved);
    for (const mention of reading.metrics) {
      resolveInto(input.resolve, mention, 'metric', resolved, unresolved);
    }
  }

  const confidence = input.shape.confidence;
  const blocked = blockReason(reading, confidence, unresolved, input.shape.kind);

  return {
    reading,
    nodeKind: NODE_KIND[reading.kind],
    confidence,
    resolved,
    unresolved,
    strokeIds: [...input.strokeIds],
    bounds: input.bounds,
    acceptable: blocked === undefined,
    ...(blocked !== undefined ? { blockedBy: blocked } : {}),
    ...(downgradedFrom !== undefined ? { downgradedFrom } : {}),
  };
}

function resolveInto(
  resolve: ReferenceResolver,
  mention: string,
  kind: 'instrument' | 'metric',
  resolved: ResolvedMention[],
  unresolved: UnresolvedMention[],
): void {
  const candidates = resolve(mention, kind);
  if (candidates.length === 1) {
    const only = candidates[0]!;
    resolved.push({ mention, id: only.id, label: only.label });
    return;
  }
  unresolved.push({
    mention,
    candidates,
    reason: candidates.length === 0 ? 'unknown' : 'ambiguous',
  });
}

function blockReason(
  reading: Reading,
  confidence: number,
  unresolved: readonly UnresolvedMention[],
  shape: ShapeKind,
): string | undefined {
  // A note asserts nothing about the world, so it needs neither a confident
  // shape nor a resolution. That is what makes it a safe fallback.
  if (reading.kind === 'note') return undefined;
  if (shape === 'unknown' || confidence < RECOGNITION_FLOOR) {
    return `the shape pass is only ${(confidence * 100).toFixed(0)}% sure this is a ${shape}`;
  }
  if (unresolved.length > 0) {
    return `${unresolved.map((u) => `"${u.mention}"`).join(', ')} ${unresolved.length === 1 ? 'does' : 'do'} not resolve to one thing`;
  }
  return undefined;
}

export class ProposalNotAcceptable extends Error {
  constructor(reason: string) {
    super(`this proposal cannot be accepted: ${reason}`);
    this.name = 'ProposalNotAcceptable';
  }
}

export interface Accepted {
  node: PicassoNode;
  /**
   * "On accept the ink stays, greyed and collapsible, linked to the node it
   * produced, because the sketch is often better documentation than the node."
   */
  ink: { strokeIds: string[]; state: 'greyed'; linkedNodeId: string };
}

/**
 * Turn an accepted proposal into a node.
 *
 * The only path from a sketch to a `PicassoNode` in this package, which is how
 * "nothing auto-materializes without confirmation" stops being a convention.
 * An `ambient` acceptance — the corner-dot affordance from 3.2.1 — is still an
 * acceptance: it goes through here, with the analyst's click recorded.
 */
export function accept(proposal: Proposal, nodeId: string, by: string): Accepted {
  if (!proposal.acceptable) {
    throw new ProposalNotAcceptable(proposal.blockedBy ?? 'no reason recorded');
  }
  if (by.trim() === '') {
    throw new ProposalNotAcceptable('no analyst is recorded as having accepted it');
  }

  const params: Record<string, string | number | boolean | string[]> = {
    acceptedBy: by,
    fromSketch: true,
  };
  const reading = proposal.reading;
  if (reading.kind === 'chart') {
    const subject = proposal.resolved.find((r) => r.mention === reading.subject);
    params.instrument = subject?.id ?? reading.subject;
    params.metrics = reading.metrics.map(
      (m) => proposal.resolved.find((r) => r.mention === m)?.id ?? m,
    );
    if (reading.frequency) params.frequency = reading.frequency;
  } else if (reading.kind === 'formula') {
    params.expression = reading.expression;
    params.inputs = [...reading.inputs];
  } else if (reading.kind === 'scenario') {
    params.name = reading.name;
    params.shocks = reading.shocks.map((s) => `${s.factor}:${s.magnitude}`);
  } else {
    params.text = reading.text;
  }

  const node = createNode({
    id: nodeId,
    kind: proposal.nodeKind,
    // A chart from a sketch arrives `bound`, not `wired`: it resolves to real
    // data and updates live, but nothing has been connected to it yet, and
    // wiring is a separate decision the analyst has not made.
    binding: reading.kind === 'note' ? 'loose' : 'bound',
    // The node lands where the ink was, so accepting a proposal does not move
    // the analyst's own drawing out from under them.
    position: { x: proposal.bounds.minX, y: proposal.bounds.minY },
    size: {
      w: proposal.bounds.maxX - proposal.bounds.minX,
      h: proposal.bounds.maxY - proposal.bounds.minY,
    },
    params,
    createdBy: 'agent',
  });

  return {
    node,
    ink: { strokeIds: [...proposal.strokeIds], state: 'greyed', linkedNodeId: nodeId },
  };
}
