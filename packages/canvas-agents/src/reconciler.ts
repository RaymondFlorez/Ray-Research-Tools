/**
 * The Reconciler (PRD 4.5, 7.4).
 *
 * "Reconciler checks that the delta and vega totals in the narrative match the
 * simulation node's actual outputs. Any mismatch fails the join and reruns the
 * Scribe with corrected numbers."
 *
 * And the walkthrough that motivates it: "The Scribe's first draft says total
 * portfolio vega is -4,200. The Reconciler checks against the actual output of
 * the aggregation node, which says -3,870. Mismatch beyond tolerance, join
 * fails... This is the failure mode that would otherwise put a wrong number in
 * front of a person making a real decision, and it is caught automatically
 * because the number had to trace to a cell."
 *
 * **"Had to" is the whole design.** The tempting implementation is to pull
 * numbers out of prose and look for one that is close to a cell value. That
 * fails in both directions: a hallucinated total that happens to sit near some
 * other cell passes, and an honest number the checker cannot match fails. So
 * the contract runs the other way. The Scribe emits text *with spans*, every
 * numeral in the text must lie inside a span, and every span names the fact it
 * renders. A number with no handle is not an unparseable number, it is an
 * unsourced one, and that is itself the finding.
 *
 * That turns reconciliation into a chain of equalities, each of which can only
 * be broken deliberately:
 *
 *     text span -> fact.value -> cell.value at this cacheKey
 *
 * with units compared at every link and never converted. Every injection in
 * `redteam.ts` breaks one of those links, which is why the catch rate is a
 * property of the structure rather than a score. The measurement that matters
 * is the other one — that a clean draft produces no findings — because a
 * checker that fails everything also catches everything.
 */

import type { Blackboard, Fact } from './blackboard.js';
import { agrees, findNumerals, formatLike, normalizeUnit, sameUnit, toleranceFor } from './numeric.js';

/** A span of the narrative that renders one fact, or is declared non-numeric prose. */
export interface Handle {
  factId: string;
  start: number;
  /** One past the last character. */
  end: number;
  /**
   * `literal` waives the coverage rule for a numeral that is prose rather than
   * a claim — a form name, a quarter, a count. It is a handle rather than a
   * silent exemption so the waiver shows up in the report and an auditor can
   * see what was excused.
   *
   * The waiver is also the one place a fabricated number could walk straight
   * past every other check in this file, by being declared prose. So a literal
   * handle whose `factId` resolves to a fact carrying a value is itself a
   * finding: whatever that span is, it is not prose, and the Scribe has said
   * so twice in contradictory ways.
   */
  kind?: 'fact' | 'literal';
  /**
   * The unit the surrounding sentence is written in.
   *
   * Optional, and worth having because it closes a link the other checks
   * cannot see. Everything else compares the fact against its source; this
   * compares the fact against the sentence it was dropped into, which is where
   * a Scribe writing a percent sentence around a basis-point fact goes wrong.
   * It does not make the citation semantically right — see `redteam.ts` for
   * the case that stays out of reach — it only rules out the class of error
   * where the sentence and the fact disagree about what kind of thing the
   * number is.
   */
  unit?: string;
}

export interface Narrative {
  text: string;
  handles: Handle[];
}

/** The live output of a compute node: the thing a number has to trace to. */
export interface CellReading {
  nodeId: string;
  cacheKey: string;
  /**
   * Which output port this reading came off.
   *
   * A node has one cache key and can have several outputs, so the port is what
   * identifies a reading and the cache key is what dates it. Omit it for a
   * single-output node.
   */
  port?: string;
  label: string;
  value: number;
  unit: string;
  asof: string;
}

/** Readings are identified by node and port; the cache key dates them. */
function readingKey(nodeId: string, port: string | undefined): string {
  return `${nodeId}\u0000${port ?? ''}`;
}

export type FindingKind =
  | 'unsourced'
  | 'waiver_abuse'
  | 'ambiguous_handle'
  | 'dangling_handle'
  | 'unverified_source'
  | 'note_as_data'
  | 'retracted'
  | 'contested'
  | 'missing_cell'
  | 'stale_cell'
  | 'unit_mismatch'
  | 'transcription'
  | 'cell_mismatch'
  | 'document_mismatch'
  | 'unchecked_document'
  | 'derivation_mismatch';

export type Severity = 'block' | 'warn';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  message: string;
  factId?: string;
  span?: { start: number; end: number; text: string };
  expected?: number;
  found?: number;
}

/** A number to hand back to the Scribe, already rendered. */
export interface Correction {
  factId: string;
  span: { start: number; end: number };
  wrote: string;
  shouldBe: string;
  value: number;
  unit: string;
  sourceNodeId?: string;
}

export interface ReconcileResult {
  ok: boolean;
  findings: Finding[];
  corrections: Correction[];
  /** Numerals excused by a `literal` handle, listed so the waiver is visible. */
  waived: Array<{ text: string; start: number }>;
  checked: number;
}

export interface ReconcileInput {
  narrative: Narrative;
  facts: readonly Fact[] | Blackboard;
  cells: readonly CellReading[];
  /** Document text by id. Supply it and cited spans are checked; omit it and they warn. */
  documents?: ReadonlyMap<string, string>;
}

const BLOCKING: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'unsourced',
  'waiver_abuse',
  'ambiguous_handle',
  'dangling_handle',
  'unverified_source',
  'note_as_data',
  'retracted',
  'contested',
  'missing_cell',
  'stale_cell',
  'unit_mismatch',
  'transcription',
  'cell_mismatch',
  'document_mismatch',
  'derivation_mismatch',
]);

function severityOf(kind: FindingKind): Severity {
  return BLOCKING.has(kind) ? 'block' : 'warn';
}

function factList(source: readonly Fact[] | Blackboard): readonly Fact[] {
  return Array.isArray(source) ? source : (source as Blackboard).facts();
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { narrative, cells } = input;
  const facts = new Map(factList(input.facts).map((f) => [f.id, f]));
  const cellFor = new Map(cells.map((c) => [readingKey(c.nodeId, c.port), c]));
  const findings: Finding[] = [];
  const corrections: Correction[] = [];
  const waived: Array<{ text: string; start: number }> = [];

  const add = (kind: FindingKind, message: string, extra: Omit<Finding, 'kind' | 'severity' | 'message'> = {}) => {
    findings.push({ kind, severity: severityOf(kind), message, ...extra });
  };

  // 1. Coverage. Every numeral in the text lies inside some handle.
  const numerals = findNumerals(narrative.text);
  let checked = 0;
  for (const numeral of numerals) {
    const handle = narrative.handles.find((h) => h.start <= numeral.start && h.end >= numeral.end);
    if (!handle) {
      add('unsourced', `"${numeral.literal}" appears in the narrative with no source`, {
        span: { start: numeral.start, end: numeral.end, text: numeral.literal },
        found: numeral.value,
      });
      continue;
    }
    if (handle.kind === 'literal') {
      const claimed = facts.get(handle.factId);
      if (claimed?.value !== undefined) {
        add(
          'waiver_abuse',
          `"${numeral.literal}" is waived as prose but cites ${handle.factId}, which carries a value`,
          {
            factId: handle.factId,
            span: { start: numeral.start, end: numeral.end, text: numeral.literal },
            found: numeral.value,
          },
        );
        continue;
      }
      waived.push({ text: numeral.literal, start: numeral.start });
      continue;
    }
    checked += 1;
  }

  // 2. Each fact handle: the chain from what was written to what the cell holds.
  for (const handle of narrative.handles) {
    if (handle.kind === 'literal') continue;
    const inside = findNumerals(narrative.text.slice(handle.start, handle.end));
    const written = inside[0];
    if (!written || inside.length > 1) {
      add(
        'ambiguous_handle',
        inside.length === 0
          ? `handle for ${handle.factId} covers no number`
          : `handle for ${handle.factId} covers ${inside.length} numbers`,
        {
          factId: handle.factId,
          span: {
            start: handle.start,
            end: handle.end,
            text: narrative.text.slice(handle.start, handle.end),
          },
        },
      );
      continue;
    }
    // Re-anchor to the full text so spans in findings are absolute.
    const numeral = {
      ...written,
      start: handle.start + written.start,
      end: handle.start + written.end,
    };
    const span = { start: numeral.start, end: numeral.end, text: numeral.literal };

    const fact = facts.get(handle.factId);
    if (!fact) {
      add('dangling_handle', `handle cites ${handle.factId}, which is not on the blackboard`, {
        factId: handle.factId,
        span,
      });
      continue;
    }
    if (fact.retracted) {
      add('retracted', `${handle.factId} was retracted when its conflict was resolved`, {
        factId: fact.id,
        span,
      });
      continue;
    }
    if (fact.contested) {
      add('contested', `${handle.factId} is contested and the conflict is unresolved`, {
        factId: fact.id,
        span,
      });
      continue;
    }
    if (!fact.value) {
      add('ambiguous_handle', `${handle.factId} carries no value but is rendered as a number`, {
        factId: fact.id,
        span,
      });
      continue;
    }

    // sentence -> fact
    if (handle.unit !== undefined && !sameUnit(handle.unit, fact.value.unit)) {
      add(
        'unit_mismatch',
        `the sentence is written in ${normalizeUnit(handle.unit)} and ${fact.id} is in ${normalizeUnit(fact.value.unit)}`,
        { factId: fact.id, span, found: fact.value.number },
      );
      continue;
    }

    // text -> fact
    if (!agrees(numeral, fact.value.number)) {
      add(
        'transcription',
        `narrative says ${numeral.literal} where ${fact.id} holds ${fact.value.number}`,
        { factId: fact.id, span, expected: fact.value.number, found: numeral.value },
      );
      corrections.push(correction(fact, numeral, fact.value.number));
      continue;
    }

    // fact -> source
    if (fact.provenance.kind === 'note') {
      // PRD 3.2.5. The analyst wrote "GM probably 71" in the margin and the
      // narrative is now reporting 71 as a figure. It traces perfectly — to a
      // belief. Its own kind, not `unverified_source`, because the remedy is
      // different: a model number wants checking against a cell, and this one
      // wants the sentence rewritten to say who thinks so.
      add(
        'note_as_data',
        `${fact.id} traces to analyst note ${fact.provenance.nodeId}; a note is what the analyst believes, not a measured value`,
        { factId: fact.id, span },
      );
      continue;
    }

    if (fact.provenance.kind === 'model') {
      add(
        'unverified_source',
        `${fact.id} traces only to model dispatch ${fact.provenance.traceId}; a narrative number must trace to a cell or a document`,
        { factId: fact.id, span },
      );
      continue;
    }

    if (fact.provenance.kind === 'document') {
      checkDocument(fact, span, input.documents, add);
      continue;
    }

    const cell = cellFor.get(readingKey(fact.provenance.nodeId, fact.provenance.port));
    if (!cell) {
      const where =
        fact.provenance.port === undefined
          ? `node ${fact.provenance.nodeId}`
          : `${fact.provenance.nodeId}.${fact.provenance.port}`;
      add('missing_cell', `${fact.id} cites ${where}, which produced no reading`, {
        factId: fact.id,
        span,
      });
      continue;
    }
    if (cell.cacheKey !== fact.provenance.cacheKey) {
      add(
        'stale_cell',
        `${fact.id} was read from ${cell.nodeId} at ${fact.provenance.cacheKey}; the node now reads ${cell.cacheKey}`,
        { factId: fact.id, span, expected: cell.value, found: fact.value.number },
      );
      corrections.push(correction(fact, numeral, cell.value, cell));
      continue;
    }
    if (!sameUnit(fact.value.unit, cell.unit)) {
      add(
        'unit_mismatch',
        `${fact.id} is in ${normalizeUnit(fact.value.unit)}; ${cell.nodeId} emits ${normalizeUnit(cell.unit)}`,
        { factId: fact.id, span, expected: cell.value, found: fact.value.number },
      );
      continue;
    }
    if (Math.abs(cell.value - fact.value.number) > toleranceFor(numeral)) {
      add(
        'cell_mismatch',
        `${fact.id} says ${fact.value.number} but ${cell.nodeId} outputs ${cell.value}`,
        { factId: fact.id, span, expected: cell.value, found: fact.value.number },
      );
      corrections.push(correction(fact, numeral, cell.value, cell));
    }
  }

  // 3. Derived facts recompute from their operands, whatever their own
  //    provenance says. A total that cites the aggregation node is still wrong
  //    if it is not the sum of the legs the narrative also cites.
  for (const fact of facts.values()) {
    if (!fact.derivation || !fact.value || fact.retracted) continue;
    const operands = fact.derivation.operands.map((id) => facts.get(id));
    if (operands.some((o) => !o?.value)) {
      add('derivation_mismatch', `${fact.id} is derived from facts that are not all on the board`, {
        factId: fact.id,
      });
      continue;
    }
    const values = operands.map((o) => (o as Fact).value!.number);
    const units = operands.map((o) => normalizeUnit((o as Fact).value!.unit));
    const expected = applyOp(fact.derivation.op, values);
    if (fact.derivation.op !== 'ratio' && new Set(units).size > 1) {
      add('unit_mismatch', `${fact.id} combines operands in ${[...new Set(units)].join(' and ')}`, {
        factId: fact.id,
      });
      continue;
    }
    // The operands each carry their own precision; the loosest one bounds what
    // the combination can claim.
    const band = Math.max(...operands.map((o) => valueBand((o as Fact).value!.number)));
    if (Math.abs(expected - fact.value.number) > band) {
      add(
        'derivation_mismatch',
        `${fact.id} states ${fact.value.number}; ${fact.derivation.op} of its operands is ${expected}`,
        { factId: fact.id, expected, found: fact.value.number },
      );
    }
  }

  return {
    ok: !findings.some((f) => f.severity === 'block'),
    findings,
    corrections,
    waived,
    checked,
  };
}

function correction(
  fact: Fact,
  numeral: { literal: string; start: number; end: number },
  value: number,
  cell?: CellReading,
): Correction {
  return {
    factId: fact.id,
    span: { start: numeral.start, end: numeral.end },
    wrote: numeral.literal,
    shouldBe: formatLike(value, numeral.literal),
    value,
    unit: cell?.unit ?? fact.value?.unit ?? '',
    ...(cell ? { sourceNodeId: cell.nodeId } : {}),
  };
}

function checkDocument(
  fact: Fact,
  span: { start: number; end: number; text: string },
  documents: ReadonlyMap<string, string> | undefined,
  add: (kind: FindingKind, message: string, extra?: Omit<Finding, 'kind' | 'severity' | 'message'>) => void,
): void {
  if (fact.provenance.kind !== 'document' || !fact.value) return;
  const text = documents?.get(fact.provenance.docId);
  if (text === undefined) {
    add(
      'unchecked_document',
      `${fact.id} cites ${fact.provenance.docId}, which was not supplied for checking`,
      { factId: fact.id, span },
    );
    return;
  }
  const cited = text.slice(fact.provenance.charStart, fact.provenance.charEnd);
  const inSpan = findNumerals(cited);
  const target = fact.value.number;
  const found = inSpan.some((n) => Math.abs(n.value - target) <= valueBand(n.value));
  if (!found) {
    add(
      'document_mismatch',
      `${fact.id} claims ${target} from ${fact.provenance.docId}, but the cited span reads "${cited.trim()}"`,
      { factId: fact.id, span, found: target },
    );
  }
}

function applyOp(op: 'sum' | 'difference' | 'product' | 'ratio', values: number[]): number {
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'difference':
      return values.slice(1).reduce((a, b) => a - b, values[0] ?? 0);
    case 'product':
      return values.reduce((a, b) => a * b, 1);
    case 'ratio':
      return values.slice(1).reduce((a, b) => a / b, values[0] ?? 0);
  }
}

/** The band a bare value claims, read off its own printed precision. */
function valueBand(value: number): number {
  const printed = String(value);
  if (/e/i.test(printed)) return Math.abs(value) * 1e-9;
  const first = findNumerals(printed)[0];
  return first ? toleranceFor(first) : 0;
}

/**
 * Apply corrections to the narrative in place of a Scribe rerun.
 *
 * The PRD reruns the Scribe with the numbers as structured input. That is the
 * right default — a corrected number can change the sentence around it
 * ("materially higher" is wrong if the number moved the other way) — but the
 * mechanical patch is here because a rerun can fail, the model can be down,
 * and a draft with the right digits and a stale adjective is strictly better
 * than a draft with the wrong digits. `reconcile` should be run again on the
 * patched text either way.
 */
export function patch(narrative: Narrative, corrections: readonly Correction[]): Narrative {
  const ordered = [...corrections].sort((a, b) => b.span.start - a.span.start);
  let text = narrative.text;
  const handles = narrative.handles.map((h) => ({ ...h }));
  for (const fix of ordered) {
    const delta = fix.shouldBe.length - (fix.span.end - fix.span.start);
    text = text.slice(0, fix.span.start) + fix.shouldBe + text.slice(fix.span.end);
    for (const handle of handles) {
      if (handle.start >= fix.span.end) handle.start += delta;
      if (handle.end >= fix.span.end) handle.end += delta;
    }
  }
  return { text, handles };
}
