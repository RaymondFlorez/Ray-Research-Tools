/**
 * The red-team suite (PRD Appendix B, phase 6).
 *
 * Exit criterion: "Reconciler catches 100 percent of injected numeric
 * mismatches in the red-team suite."
 *
 * A catch rate on its own is not a measurement, because a checker that rejects
 * every draft scores 100 percent. So the suite carries two populations: the
 * injections, every one of which must be caught, and the clean variants, none
 * of which may raise a blocking finding. The second set is the harder one to
 * pass and it is where the tolerance rules earn their keep — an honest
 * rounding, a hedged total, a unicode minus sign and a form number are all
 * things a real Scribe emits, and a Reconciler that fails them would be turned
 * off inside a week.
 *
 * Each injection also declares the finding kind it should produce. Catching
 * the sign flip for the wrong reason is not catching it: the analyst reads the
 * finding, and one that names the wrong failure sends them to the wrong place.
 */

import type { Fact } from './blackboard.js';
import { reconcile, type CellReading, type FindingKind, type Handle, type Narrative } from './reconciler.js';

export interface Case {
  narrative: Narrative;
  facts: Fact[];
  cells: CellReading[];
  documents: Map<string, string>;
}

/** A piece of narrative: plain prose, or a span that cites a fact. */
type Part = string | { factId: string; text: string; kind?: 'fact' | 'literal' };

function draft(parts: readonly Part[]): Narrative {
  let text = '';
  const handles: Handle[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    const start = text.length;
    text += part.text;
    handles.push({
      factId: part.factId,
      start,
      end: text.length,
      ...(part.kind ? { kind: part.kind } : {}),
    });
  }
  return { text, handles };
}

const DOC_NVDA =
  'Q&A section. Across the prepared remarks and the question period the CFO used ' +
  'hedging terms at a density of 33 per thousand words, against 24.8 in the prior quarter. ' +
  'Guidance language was unchanged in structure.';

const HEDGING_START = DOC_NVDA.indexOf('hedging terms at a density of');
const HEDGING_END = DOC_NVDA.indexOf(', against');

/**
 * The PRD's own worked example (7.4): a Scribe draft that states portfolio
 * totals from an aggregation node, a document-sourced subtext metric, and a
 * total that is supposed to be the sum of two legs.
 */
export function baseline(): Case {
  const facts: Fact[] = [
    {
      id: 'f-shock',
      claim: 'size of the rate shock',
      value: { number: 50, unit: 'bps', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'scn-rate', cacheKey: 'k-scn-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'simulator',
      at: 0,
    },
    {
      id: 'f-vega-tech',
      claim: 'vega of the tech leg',
      value: { number: -2100, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'leg-tech', cacheKey: 'k-tech-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'quant',
      at: 1,
    },
    {
      id: 'f-vega-semis',
      claim: 'vega of the semis leg',
      value: { number: -1770, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'leg-semis', cacheKey: 'k-semis-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'quant',
      at: 2,
    },
    {
      id: 'f-vega',
      claim: 'total portfolio vega',
      value: { number: -3870, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'agg-vega', cacheKey: 'k-agg-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'simulator',
      derivation: { op: 'sum', operands: ['f-vega-tech', 'f-vega-semis'] },
      at: 3,
    },
    {
      id: 'f-delta',
      claim: 'total portfolio delta',
      value: { number: 12450, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'agg-delta', cacheKey: 'k-delta-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'simulator',
      at: 4,
    },
    {
      id: 'f-hedging',
      claim: 'hedging density on the latest call',
      value: { number: 33, unit: 'per_thousand_words', asof: '2026-02-26' },
      provenance: {
        kind: 'document',
        docId: 'doc-nvda-q4',
        page: 3,
        charStart: HEDGING_START,
        charEnd: HEDGING_END,
      },
      confidence: 0.9,
      contested: false,
      assertedBy: 'extractor',
      at: 5,
    },
    {
      id: 'f-move',
      claim: 'event-implied move',
      value: { number: 6.2, unit: 'pct', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'iv-event', cacheKey: 'k-iv-1' },
      confidence: 1,
      contested: false,
      assertedBy: 'quant',
      at: 6,
    },
  ];

  const narrative = draft([
    'Against a ',
    { factId: 'f-shock', text: '50' },
    'bp hawkish repricing the book carries total vega of ',
    { factId: 'f-vega', text: '-3,870' },
    ' and total delta of ',
    { factId: 'f-delta', text: '12,450' },
    '. The vega sits in two legs: tech at ',
    { factId: 'f-vega-tech', text: '-2,100' },
    ' and semis at ',
    { factId: 'f-vega-semis', text: '-1,770' },
    '. The latest call raised hedging density to ',
    { factId: 'f-hedging', text: '33' },
    ' per thousand words, and the risk factors in the ',
    { factId: 'literal:form', text: '10-Q', kind: 'literal' },
    ' are unchanged. The options market prices an event move of ',
    { factId: 'f-move', text: '6.2' },
    '%.',
  ]);

  const cells: CellReading[] = [
    { nodeId: 'scn-rate', cacheKey: 'k-scn-1', label: 'rate shock', value: 50, unit: 'bps', asof: '2026-03-11' },
    { nodeId: 'agg-vega', cacheKey: 'k-agg-1', label: 'portfolio vega', value: -3870, unit: 'usd', asof: '2026-03-11' },
    { nodeId: 'agg-delta', cacheKey: 'k-delta-1', label: 'portfolio delta', value: 12450, unit: 'usd', asof: '2026-03-11' },
    { nodeId: 'leg-tech', cacheKey: 'k-tech-1', label: 'tech leg vega', value: -2100, unit: 'usd', asof: '2026-03-11' },
    { nodeId: 'leg-semis', cacheKey: 'k-semis-1', label: 'semis leg vega', value: -1770, unit: 'usd', asof: '2026-03-11' },
    { nodeId: 'iv-event', cacheKey: 'k-iv-1', label: 'event-implied move', value: 6.2, unit: 'pct', asof: '2026-03-11' },
  ];

  return { narrative, facts, cells, documents: new Map([['doc-nvda-q4', DOC_NVDA]]) };
}

function clone(base: Case): Case {
  return {
    narrative: { text: base.narrative.text, handles: base.narrative.handles.map((h) => ({ ...h })) },
    facts: base.facts.map((f) => ({ ...f, value: f.value ? { ...f.value } : undefined })) as Fact[],
    cells: base.cells.map((c) => ({ ...c })),
    documents: new Map(base.documents),
  };
}

function factIn(c: Case, id: string): Fact {
  const found = c.facts.find((f) => f.id === id);
  if (!found) throw new Error(`fixture is missing fact ${id}`);
  return found;
}

function cellIn(c: Case, id: string): CellReading {
  const found = c.cells.find((x) => x.nodeId === id);
  if (!found) throw new Error(`fixture is missing cell ${id}`);
  return found;
}

/** Replace the text under the handle for `factId`, keeping handles aligned. */
function rewrite(c: Case, factId: string, replacement: string): void {
  const handle = c.narrative.handles.find((h) => h.factId === factId);
  if (!handle) throw new Error(`fixture is missing a handle for ${factId}`);
  const delta = replacement.length - (handle.end - handle.start);
  c.narrative.text =
    c.narrative.text.slice(0, handle.start) + replacement + c.narrative.text.slice(handle.end);
  for (const other of c.narrative.handles) {
    if (other === handle) continue;
    if (other.start >= handle.end) other.start += delta;
    if (other.end >= handle.end) other.end += delta;
  }
  handle.end += delta;
}

export interface Injection {
  id: string;
  description: string;
  expect: FindingKind;
  apply: (c: Case) => void;
}

export const INJECTIONS: readonly Injection[] = [
  {
    id: 'transcription_drift',
    description: 'the Scribe writes -4,200 where the aggregation node says -3,870',
    expect: 'transcription',
    apply: (c) => rewrite(c, 'f-vega', '-4,200'),
  },
  {
    id: 'sign_flip',
    description: 'the negative sign is dropped from a short vega position',
    expect: 'transcription',
    apply: (c) => rewrite(c, 'f-vega', '3,870'),
  },
  {
    id: 'digit_swap',
    description: 'two digits transpose inside an otherwise cited number',
    expect: 'transcription',
    apply: (c) => rewrite(c, 'f-delta', '12,540'),
  },
  {
    id: 'scale_shift',
    description: 'a number is restated in millions in the prose without changing the claim',
    expect: 'transcription',
    apply: (c) => rewrite(c, 'f-vega', '-3.87'),
  },
  {
    id: 'orphan_number',
    description: 'a total appears in the narrative that nothing on the board asserts',
    expect: 'unsourced',
    apply: (c) => {
      c.narrative.text += ' Net notional exposure is 41,200.';
    },
  },
  {
    id: 'cell_moved',
    description: 'the aggregation node recomputed and now outputs a different number',
    expect: 'cell_mismatch',
    apply: (c) => {
      cellIn(c, 'agg-vega').value = -3510;
    },
  },
  {
    id: 'stale_read',
    description: 'the number traces to a cell, but to a cache key the node has moved past',
    expect: 'stale_cell',
    apply: (c) => {
      cellIn(c, 'agg-delta').cacheKey = 'k-delta-2';
    },
  },
  {
    id: 'unit_swap',
    description: 'the fact claims millions where the node emits dollars',
    expect: 'unit_mismatch',
    apply: (c) => {
      const fact = factIn(c, 'f-delta');
      if (fact.value) fact.value.unit = 'usd_millions';
    },
  },
  {
    id: 'pct_bps_confusion',
    description: 'a percent reading is asserted in basis points',
    expect: 'unit_mismatch',
    apply: (c) => {
      const fact = factIn(c, 'f-move');
      if (fact.value) fact.value.unit = 'bps';
    },
  },
  {
    id: 'fabricated_number',
    description: 'the only provenance for a cited total is a model dispatch',
    expect: 'unverified_source',
    apply: (c) => {
      factIn(c, 'f-vega').provenance = { kind: 'model', traceId: 'trace-9f2' };
    },
  },
  {
    id: 'note_promoted_to_datum',
    description: "a figure from the analyst's own margin note, cited as a computed one",
    expect: 'note_as_data',
    apply: (c) => {
      // The failure PRD 3.2.5 names: the analyst wrote a number down as a
      // guess, an agent read it out of the context, and the narrative now
      // reports it with the same face as a repriced leg.
      factIn(c, 'f-vega').provenance = { kind: 'note', nodeId: 'note-margin-7' };
    },
  },
  {
    id: 'dangling_citation',
    description: 'a handle cites a fact id that is not on the board',
    expect: 'dangling_handle',
    apply: (c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-move');
      if (handle) handle.factId = 'f-move-v2';
    },
  },
  {
    id: 'missing_cell',
    description: 'the node a number cites produced no reading this run',
    expect: 'missing_cell',
    apply: (c) => {
      c.cells = c.cells.filter((x) => x.nodeId !== 'iv-event');
    },
  },
  {
    id: 'broken_sum',
    description: 'the legs no longer add to the total, and both cite their own cells',
    expect: 'derivation_mismatch',
    apply: (c) => {
      const leg = factIn(c, 'f-vega-semis');
      if (leg.value) leg.value.number = -1200;
      cellIn(c, 'leg-semis').value = -1200;
      rewrite(c, 'f-vega-semis', '-1,200');
    },
  },
  {
    id: 'document_fabrication',
    description: 'an extracted metric is not in the span it cites',
    expect: 'document_mismatch',
    apply: (c) => {
      const fact = factIn(c, 'f-hedging');
      if (fact.value) fact.value.number = 41;
      rewrite(c, 'f-hedging', '41');
    },
  },
  {
    id: 'contested_number',
    description: 'two agents disagree about the total and the narrative picks one silently',
    expect: 'contested',
    apply: (c) => {
      factIn(c, 'f-vega').contested = true;
    },
  },
  {
    id: 'retracted_number',
    description: 'the narrative cites the fact that lost its conflict',
    expect: 'retracted',
    apply: (c) => {
      factIn(c, 'f-delta').retracted = true;
    },
  },
  {
    id: 'hedge_overreach',
    description: 'a hedge word is used to cover a move far outside what a hedge buys',
    expect: 'transcription',
    apply: (c) => {
      rewrite(c, 'f-vega', 'about -4,200');
    },
  },
  {
    id: 'waiver_abuse',
    description: 'a real claim is marked as prose to slip past the coverage rule',
    expect: 'waiver_abuse',
    apply: (c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-move');
      if (handle) handle.kind = 'literal';
    },
  },
  {
    id: 'sentence_unit_drift',
    description: 'a basis-point fact is dropped into a sentence written in percent',
    expect: 'unit_mismatch',
    apply: (c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-shock');
      if (handle) handle.unit = 'pct';
    },
  },
  {
    id: 'swapped_handles',
    description: 'two numbers are correct but each cites the other one source',
    expect: 'transcription',
    apply: (c) => {
      const a = c.narrative.handles.find((h) => h.factId === 'f-vega-tech');
      const b = c.narrative.handles.find((h) => h.factId === 'f-vega-semis');
      if (a && b) {
        a.factId = 'f-vega-semis';
        b.factId = 'f-vega-tech';
      }
    },
  },
  {
    id: 'widened_handle',
    description: 'one handle is stretched to cover two numbers so only one is checked',
    expect: 'ambiguous_handle',
    apply: (c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-vega');
      const next = c.narrative.handles.find((h) => h.factId === 'f-delta');
      if (handle && next) handle.end = next.end;
    },
  },
];

/** Drafts that must pass. Each is a thing a working Scribe legitimately emits. */
export interface CleanVariant {
  id: string;
  description: string;
  apply: (c: Case) => void;
}

export const CLEAN: readonly CleanVariant[] = [
  { id: 'baseline', description: 'the draft as written', apply: () => {} },
  {
    id: 'honest_rounding',
    description: 'the cell carries decimals the narrative rounds away at the displayed place',
    apply: (c) => {
      cellIn(c, 'agg-vega').value = -3870.4;
      const fact = factIn(c, 'f-vega');
      if (fact.value) fact.value.number = -3870.4;
      const tech = factIn(c, 'f-vega-tech');
      if (tech.value) tech.value.number = -2100.4;
      cellIn(c, 'leg-tech').value = -2100.4;
    },
  },
  {
    id: 'hedged_total',
    description: 'an explicitly hedged number inside the band a hedge buys',
    apply: (c) => {
      rewrite(c, 'f-delta', 'about 12,500');
    },
  },
  {
    id: 'unicode_minus',
    description: 'the minus sign arrives as U+2212 from a copied cell',
    apply: (c) => {
      rewrite(c, 'f-vega', '−3,870');
    },
  },
  {
    id: 'percent_alias',
    description: 'the fact says percent where the cell says pct',
    apply: (c) => {
      const fact = factIn(c, 'f-move');
      if (fact.value) fact.value.unit = 'percent';
    },
  },
  {
    id: 'dated_prose',
    description: 'an as-of date, three numerals under one prose waiver',
    apply: (c) => {
      const prefix = ' Figures are as of ';
      const start = c.narrative.text.length + prefix.length;
      c.narrative.text += `${prefix}2026-03-11.`;
      c.narrative.handles.push({ factId: 'literal:asof', start, end: start + 10, kind: 'literal' });
    },
  },
  {
    id: 'sentence_unit_declared',
    description: 'the Scribe declares the unit of the sentence and it agrees with the fact',
    apply: (c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-move');
      if (handle) handle.unit = 'pct';
    },
  },
  {
    id: 'extra_prose_numeral',
    description: 'a form number in the prose, declared as prose',
    apply: (c) => {
      const start = c.narrative.text.length + ' It also restates the '.length;
      c.narrative.text += ' It also restates the 8-K filed last week.';
      c.narrative.handles.push({ factId: 'literal:form-8k', start, end: start + 3, kind: 'literal' });
    },
  },
];

/**
 * Attacks the Reconciler is known not to catch, kept in the suite rather than
 * out of it.
 *
 * The exit criterion is about numeric mismatches, and the structure above
 * catches those by construction. It does not catch a number that is correct,
 * traceable, in the right unit, and attached to the wrong idea — the vega of
 * one leg presented as the vega of another, where both are dollars and both
 * are real cells. Nothing short of reading the sentence distinguishes those,
 * and reading the sentence is the Critic's job, not the Reconciler's.
 *
 * These are asserted to stay uncaught. If a later change catches one, the test
 * fails and the entry should be deleted with the change that earned it —
 * which is the only way a known gap gets revisited rather than forgotten.
 */
export const KNOWN_LIMITS: readonly Injection[] = [
  {
    id: 'right_number_wrong_concept',
    description:
      'the tech leg vega is presented as the semis leg vega; both cite live cells in dollars',
    expect: 'cell_mismatch',
    apply: (c) => {
      // Make the two legs numerically identical, then swap which cell each
      // cites. Every link in the chain holds; only the meaning is wrong.
      const semis = factIn(c, 'f-vega-semis');
      if (semis.value) semis.value.number = -2100;
      cellIn(c, 'leg-semis').value = -2100;
      rewrite(c, 'f-vega-semis', '-2,100');
      semis.provenance = { kind: 'cell', nodeId: 'leg-tech', cacheKey: 'k-tech-1' };
      const total = factIn(c, 'f-vega');
      if (total.value) total.value.number = -4200;
      cellIn(c, 'agg-vega').value = -4200;
      rewrite(c, 'f-vega', '-4,200');
    },
  },
];

export interface RedTeamReport {
  injections: number;
  caught: number;
  /** Caught, but reported as something other than what the injection is. */
  misattributed: Array<{ id: string; expected: FindingKind; got: FindingKind[] }>;
  missed: string[];
  cleanVariants: number;
  falsePositives: Array<{ id: string; findings: FindingKind[] }>;
  catchRate: number;
  falsePositiveRate: number;
  /** Documented gaps, and whether each is still a gap. */
  knownLimits: Array<{ id: string; stillUncaught: boolean }>;
}

export function runRedTeam(): RedTeamReport {
  const missed: string[] = [];
  const misattributed: RedTeamReport['misattributed'] = [];
  let caught = 0;

  for (const injection of INJECTIONS) {
    const c = clone(baseline());
    injection.apply(c);
    const result = reconcile({
      narrative: c.narrative,
      facts: c.facts,
      cells: c.cells,
      documents: c.documents,
    });
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length === 0) {
      missed.push(injection.id);
      continue;
    }
    caught += 1;
    const kinds = blocking.map((f) => f.kind);
    if (!kinds.includes(injection.expect)) {
      misattributed.push({ id: injection.id, expected: injection.expect, got: kinds });
    }
  }

  const falsePositives: RedTeamReport['falsePositives'] = [];
  for (const variant of CLEAN) {
    const c = clone(baseline());
    variant.apply(c);
    const result = reconcile({
      narrative: c.narrative,
      facts: c.facts,
      cells: c.cells,
      documents: c.documents,
    });
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length > 0) {
      falsePositives.push({ id: variant.id, findings: blocking.map((f) => f.kind) });
    }
  }

  const knownLimits = KNOWN_LIMITS.map((limit) => {
    const c = clone(baseline());
    limit.apply(c);
    const result = reconcile({
      narrative: c.narrative,
      facts: c.facts,
      cells: c.cells,
      documents: c.documents,
    });
    return {
      id: limit.id,
      stillUncaught: result.findings.every((f) => f.severity !== 'block'),
    };
  });

  return {
    injections: INJECTIONS.length,
    caught,
    misattributed,
    missed,
    cleanVariants: CLEAN.length,
    falsePositives,
    catchRate: caught / INJECTIONS.length,
    falsePositiveRate: falsePositives.length / CLEAN.length,
    knownLimits,
  };
}
