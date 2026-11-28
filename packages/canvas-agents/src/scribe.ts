/**
 * A Scribe that is a model (PRD 4.5's join, with a real writer behind it).
 *
 * The join's contract is that every numeral in the narrative lies inside a
 * handle naming the fact it renders (`reconciler.ts`). A model cannot emit
 * character offsets, so the Scribe asks for the next best thing: each number
 * written out, followed at once by the fact it comes from in square brackets —
 * `a loss of $396,629 [sleeve:pnl]`. `readCitations` turns each marker into a
 * handle over the numeral just before it and takes the marker out.
 *
 * The model writes the digits itself. That is the point: rendering the facts
 * into placeholders would make every number right by construction and the
 * reconciler would be checking the template, not the writer. Here a digit the
 * model mistyped is a `transcription` finding with a correction, a number it
 * wrote with no citation is `unsourced`, and a citation of a fact that is not on
 * the board is `dangling` — the PRD's walkthrough failure, caught the way the
 * PRD says it is caught, on a real model's prose.
 *
 * A rerun hands the corrections back to the model, which rewrites; the join
 * bounds the rounds and keeps every round's findings.
 */

import type { Blackboard, Fact } from './blackboard.js';
import type { AgentFn, JoinSpec } from './coordinator.js';
import { findNumerals } from './numeric.js';
import type { CellReading, Correction, Finding, Handle, Narrative } from './reconciler.js';

/** One model call: a system prompt and a user message in, text out. */
export type Complete = (system: string, user: string) => Promise<string>;

const MARKER = /\s?\[([^\][\s]{1,80})\]/g;

/**
 * A draft with `[fact-id]` markers, as text and handles.
 *
 * Each marker becomes a handle over the last numeral between it and the
 * previous marker; a marker with no numeral before it becomes a handle that
 * covers nothing, which the reconciler reports rather than this dropping it.
 */
export function readCitations(draft: string): Narrative {
  let text = '';
  const handles: Handle[] = [];
  let from = 0;
  let segmentStart = 0;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(draft); m !== null; m = MARKER.exec(draft)) {
    text += draft.slice(from, m.index);
    from = m.index + m[0].length;
    const segment = text.slice(segmentStart);
    const last = findNumerals(segment).at(-1);
    const factId = m[1] as string;
    if (last) handles.push({ factId, start: segmentStart + last.start, end: segmentStart + last.end });
    else handles.push({ factId, start: text.length, end: text.length });
    segmentStart = text.length;
  }
  text += draft.slice(from);
  return { text, handles };
}

export interface ModelScribeOptions {
  complete: Complete;
  /** The facts the answer may use. Everything else on the board is left out of the prompt. */
  factIds: readonly string[];
  /** The live cell readings the join checks against: the canvas's, not the board's. */
  cells: () => readonly CellReading[];
  maxAttempts?: number;
}

const SYSTEM = [
  'You write the answer to an analyst\'s question from the facts you are given, in two or three sentences.',
  'Every number you write must be one of the facts. Write it, then immediately its id in square brackets,',
  'for example: the sleeve loses $396,629 [sleeve:pnl] if rates rise 50 [sleeve:shock] basis points.',
  'Write a loss or a fall as a negative number, with its sign: -$396,629, not "a loss of $396,629".',
  'Write each number once, with its id, even one the question already states.',
  'Write no other numbers: no dates, no tenors, no counts.',
].join('\n');

// No as-of in the prompt: a date handed to a model comes back as three unsourced numbers.
const describe = (f: Fact): string => `[${f.id}] ${f.claim}: ${f.value?.number} ${f.value?.unit}`;

/**
 * The Scribe as an agent for its plan step, and the join that checks it.
 *
 * The agent writes the first draft from the board when its step runs; the
 * join's `rerunScribe` asks the model again with the corrections.
 */
export function modelScribe(options: ModelScribeOptions): { agent: AgentFn; join: JoinSpec; drafts: string[] } {
  let current: Narrative = { text: '', handles: [] };
  // Set when the step failed: the join then checks the draft as it stands and
  // asks for no rewrite of an answer the plan already counted as failed.
  let failed = false;
  let question = '';
  let given = '';
  const drafts: string[] = [];
  const facts = (board: Blackboard): Fact[] => {
    const out: Fact[] = [];
    for (const id of options.factIds) {
      const f = board.fact(id);
      if (!f || f.retracted || !f.value) throw new Error(`the answer needs ${id}, which is not on the board`);
      out.push(f);
    }
    return out;
  };
  const write = async (prompt: string): Promise<Narrative> => {
    const draft = (await options.complete(SYSTEM, prompt)).trim();
    drafts.push(draft);
    return readCitations(draft);
  };
  // A draft that cites none of the facts it was given has claimed nothing, and
  // the reconciler would pass it for that reason: an empty answer is not a
  // checked one.
  const answers = (n: Narrative): boolean => n.handles.some((h) => options.factIds.includes(h.factId));
  const agent: AgentFn = async ({ board }) => {
    question = board.snapshot().question;
    given = facts(board).map(describe).join('\n');
    current = await write(`Question: ${question}\n\nFacts:\n${given}`);
    if (!answers(current)) failed = true;
    if (failed) throw new Error(`the draft cites none of ${options.factIds.join(', ')}: ${JSON.stringify(drafts.at(-1))}`);
    return { note: `drafted ${current.text.length} characters citing ${current.handles.length} fact(s)` };
  };
  const join: JoinSpec = {
    narrative: () => current,
    cells: options.cells,
    maxAttempts: options.maxAttempts ?? 3,
    rerunScribe: async (corrections: readonly Correction[], previous: Narrative, findings: readonly Finding[]) => {
      if (failed) return previous;
      const fixes = [
        ...corrections.map((c) => `you wrote ${c.wrote} for [${c.factId}]; it is ${c.shouldBe}`),
        // Digits alone cannot say a sign was wrong when the words carried it.
        ...findings
          .filter((f) => f.kind === 'transcription' && f.expected !== undefined && f.found !== undefined && Math.sign(f.expected) !== Math.sign(f.found))
          .map((f) => `[${f.factId}] is ${(f.expected as number) > 0 ? 'a gain, not a loss' : 'a loss, not a gain'}`),
        ...findings
          .filter((f) => f.kind === 'unsourced')
          .map((f) => `you wrote ${f.span?.text} with no fact behind it; leave it out, or cite the fact it is`),
        ...findings
          .filter((f) => f.kind !== 'unsourced' && f.kind !== 'transcription')
          .map((f) => f.message),
      ].join('\n');
      const rewrite = await write(
        `Question: ${question}\n\nFacts:\n${given}\n\nYour previous answer:\n${previous.text}\n\nIt had these problems:\n${fixes}\n\nWrite the answer again, citing every number the same way.`,
      );
      // A rewrite that answers nothing leaves the previous draft standing, so
      // the join fails on its findings rather than passing on silence.
      if (!answers(rewrite)) return previous;
      current = rewrite;
      return current;
    },
  };
  return { agent, join, drafts };
}
