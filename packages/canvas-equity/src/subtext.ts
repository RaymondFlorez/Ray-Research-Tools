/**
 * The earnings subtext engine (PRD 5.2).
 *
 * "The subtext engine computes, per call: hedging-term density,
 * forward-looking-statement ratio, question-evasion score (does the answer
 * contain the entities the question asked about), tone delta against the same
 * speaker's trailing four calls, and guidance-language change detection with
 * diff highlighting against the prior quarter's exact phrasing. Each metric
 * outputs both a number and the specific spans that produced it, so the
 * analyst can click a score and land on the sentences."
 *
 * Every one of these is a lexical count dressed up as an insight, and the
 * spans are what keep that honest. A hedging density of 33 is not a finding;
 * thirty-three specific sentences are, and an analyst who reads them will
 * sometimes conclude the number is noise. That is the correct outcome and the
 * reason `metric()` refuses to report a non-zero value with nothing to click.
 *
 * The one metric here that is not a word count is **question evasion**, and it
 * is the one worth the most: the PRD defines it operationally — "does the
 * answer contain the entities the question asked about" — which is checkable
 * rather than interpretive. An executive who is asked about China and gross
 * margin and answers about demand environment has evaded, whatever the tone
 * of the answer was.
 */

import {
  executiveTurns,
  inSection,
  metric,
  sentences,
  spansOf,
  wordCount,
  type Metric,
  type Section,
  type Span,
  type Transcript,
} from './transcript.js';

// ---------------------------------------------------------------------------
// 1. Hedging density
// ---------------------------------------------------------------------------

const HEDGES = [
  'approximately', 'roughly', 'somewhat', 'relatively', 'fairly', 'generally',
  'largely', 'broadly', 'modestly', 'slightly', 'potentially', 'possibly',
  'perhaps', 'maybe', 'arguably', 'presumably', 'seemingly', 'apparently',
  'could', 'might', 'may', 'would', 'should', 'tends? to', 'appears? to',
  'seems? to', 'we think', 'we believe', 'we feel', 'our sense is',
  'in the ballpark', 'or so', 'give or take', 'directionally',
  'at this point', 'at this time', 'as of today', 'hard to say',
  'too early to', "it's difficult to", 'we will see', 'time will tell',
];

const HEDGE_PATTERN = new RegExp(`\\b(?:${HEDGES.join('|')})\\b`, 'gi');

/** Hedging terms per thousand words, with every occurrence cited. */
export function hedgingDensity(transcript: Transcript, section: Section): Metric {
  const turns = executiveTurns(transcript, section);
  let words = 0;
  const spans: Span[] = [];
  for (const [index, utterance] of turns) {
    words += wordCount(utterance.text);
    spans.push(...spansOf(transcript, index, HEDGE_PATTERN));
  }
  const value = words === 0 ? 0 : (spans.length / words) * 1000;
  return metric(
    'hedging density',
    value,
    'per thousand words',
    spans,
    words < 200 ? `only ${words} words of executive speech in this section` : undefined,
  );
}

// ---------------------------------------------------------------------------
// 2. Forward-looking statement ratio
// ---------------------------------------------------------------------------

const FORWARD = new RegExp(
  [
    '\\bwe (?:expect|anticipate|project|forecast|plan|intend|target|aim)\\b',
    '\\bwill (?:be|continue|remain|grow|improve|decline|deliver)\\b',
    '\\b(?:next|coming|upcoming) (?:quarter|year|half|period)\\b',
    '\\b(?:guidance|outlook|guiding)\\b',
    '\\bgoing forward\\b',
    '\\bover time\\b',
    '\\bby (?:the end of|fiscal|calendar) \\d{4}\\b',
  ].join('|'),
  'gi',
);

/**
 * Share of executive sentences that make a claim about the future.
 *
 * A ratio, not a count, because the denominator is the thing that moves: a
 * long prepared section and a short one produce very different counts of the
 * same behaviour.
 */
export function forwardLookingRatio(transcript: Transcript, section: Section): Metric {
  const turns = executiveTurns(transcript, section);
  let total = 0;
  const spans: Span[] = [];
  for (const [index, utterance] of turns) {
    for (const sentence of sentences(utterance.text)) {
      total += 1;
      FORWARD.lastIndex = 0;
      if (FORWARD.test(sentence.text)) {
        spans.push({
          utterance: index,
          start: sentence.start,
          end: sentence.end,
          text: sentence.text,
          speaker: utterance.speaker,
        });
      }
    }
  }
  const value = total === 0 ? 0 : spans.length / total;
  return metric('forward-looking ratio', value, 'share of sentences', spans);
}

// ---------------------------------------------------------------------------
// 3. Question evasion
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'that', 'this', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'have', 'has', 'had', 'you', 'your', 'i', 'we', 'our', 'us', 'it',
  'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'to', 'of', 'in',
  'on', 'for', 'with', 'at', 'by', 'from', 'about', 'as', 'into', 'like',
  'through', 'over', 'can', 'could', 'would', 'should', 'will', 'just', 'so',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'thanks', 'thank',
  'question', 'questions', 'morning', 'afternoon', 'hi', 'hey', 'guys',
  'maybe', 'talk', 'give', 'bit', 'little', 'more', 'any', 'some', 'there',
  'here', 'one', 'two', 'also', 'get', 'got', 'think', 'know', 'see', 'look',
]);

/** The substantive things a question asked about. */
export function questionEntities(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z'-]+/g) ?? [];
  const out = new Set<string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 4 || STOPWORDS.has(lower)) continue;
    out.add(lower);
  }
  return [...out];
}

export interface EvasionDetail {
  question: string;
  analyst: string;
  asked: string[];
  answered: string[];
  missed: string[];
  /** Share of asked entities the answer never mentions. */
  evasion: number;
}

export interface Evasion extends Metric {
  exchanges: EvasionDetail[];
}

/**
 * "does the answer contain the entities the question asked about"
 *
 * Pairs each analyst question with the executive turns that follow it before
 * the next question, and asks what share of the question's substantive terms
 * never appear in the answer. The spans point at the *answer*, because that is
 * what the analyst wants to read when they click: the question is already in
 * front of them.
 *
 * The obvious objection is that a good answer can use different words. True,
 * and it is why this is a flag rather than a verdict — but the asymmetry is
 * real: an executive who wants to address China says "China". Answering a
 * question about China entirely in synonyms is itself the behaviour.
 */
export function questionEvasion(transcript: Transcript): Evasion {
  const qa = inSection(transcript, 'qa');
  const exchanges: EvasionDetail[] = [];
  const spans: Span[] = [];

  for (let i = 0; i < qa.length; i += 1) {
    const entry = qa[i];
    if (!entry) continue;
    const [, question] = entry;
    if (question.role !== 'analyst') continue;

    const asked = questionEntities(question.text);
    if (asked.length === 0) continue;

    // Everything the executives say before the next analyst turn.
    const answerIndices: number[] = [];
    for (let j = i + 1; j < qa.length; j += 1) {
      const next = qa[j];
      if (!next) break;
      if (next[1].role === 'analyst') break;
      if (next[1].role === 'executive') answerIndices.push(next[0]);
    }
    if (answerIndices.length === 0) continue;

    const answerText = answerIndices
      .map((index) => transcript.utterances[index]?.text ?? '')
      .join(' ')
      .toLowerCase();
    const answered = asked.filter((term) => answerText.includes(term));
    const missed = asked.filter((term) => !answerText.includes(term));
    const evasion = missed.length / asked.length;

    exchanges.push({
      question: question.text,
      analyst: question.speaker,
      asked,
      answered,
      missed,
      evasion,
    });

    // Cite the answer itself, which is what the analyst wants to read.
    if (missed.length > 0) {
      for (const index of answerIndices) {
        const utterance = transcript.utterances[index];
        if (!utterance) continue;
        spans.push({
          utterance: index,
          start: 0,
          end: utterance.text.length,
          text: utterance.text,
          speaker: utterance.speaker,
        });
      }
    }
  }

  const value =
    exchanges.length === 0 ? 0 : exchanges.reduce((total, e) => total + e.evasion, 0) / exchanges.length;
  const base = metric(
    'question evasion',
    value,
    'share of asked terms unaddressed',
    spans,
    exchanges.length < 4 ? `only ${exchanges.length} question-answer exchange(s) on this call` : undefined,
  );
  return { ...base, exchanges };
}

// ---------------------------------------------------------------------------
// 4. Tone delta
// ---------------------------------------------------------------------------

const POSITIVE = [
  'strong', 'strength', 'record', 'outstanding', 'excellent', 'robust',
  'accelerate', 'accelerating', 'momentum', 'pleased', 'confident',
  'confidence', 'exceeded', 'outperform', 'improving', 'improved', 'growth',
  'opportunity', 'favorable', 'healthy', 'solid', 'encouraged',
];

const NEGATIVE = [
  'weak', 'weakness', 'decline', 'declined', 'declining', 'headwind',
  'challenging', 'challenged', 'pressure', 'pressured', 'disappointing',
  'disappointed', 'shortfall', 'miss', 'missed', 'soft', 'softness',
  'deteriorate', 'deteriorating', 'uncertain', 'uncertainty', 'cautious',
  'slowdown', 'slowing', 'difficult',
];

const POSITIVE_PATTERN = new RegExp(`\\b(?:${POSITIVE.join('|')})\\b`, 'gi');
const NEGATIVE_PATTERN = new RegExp(`\\b(?:${NEGATIVE.join('|')})\\b`, 'gi');

export interface Tone {
  /** (positive - negative) per thousand words. */
  score: number;
  positive: Span[];
  negative: Span[];
  words: number;
}

export function tone(transcript: Transcript, section: Section, speaker?: string): Tone {
  const turns = executiveTurns(transcript, section).filter(
    ([, u]) => speaker === undefined || u.speaker === speaker,
  );
  let words = 0;
  const positive: Span[] = [];
  const negative: Span[] = [];
  for (const [index, utterance] of turns) {
    words += wordCount(utterance.text);
    positive.push(...spansOf(transcript, index, POSITIVE_PATTERN));
    negative.push(...spansOf(transcript, index, NEGATIVE_PATTERN));
  }
  const score = words === 0 ? 0 : ((positive.length - negative.length) / words) * 1000;
  return { score, positive, negative, words };
}

export interface ToneDelta extends Metric {
  current: number;
  baseline: number;
  /** Standard deviations, where the baseline supports one. */
  z?: number;
  trailing: number[];
}

/**
 * "tone delta against the same speaker's trailing four calls"
 *
 * The delta is reported in the metric's own units and the z-score is reported
 * separately, because **four observations do not support a standard
 * deviation.** The sample sd of four numbers has about 40 percent relative
 * error, so a z computed from it moves around enough that a "two sigma" tone
 * shift on a trailing-four baseline fires on ordinary variation. This is the
 * same failure the model-rollback rule in `canvas-guard` had, and it gets a
 * weaker version of the same treatment: the z is still produced, because it is
 * what the PRD asks for and it is not useless, but it carries a caveat naming
 * the sample size and `test/subtext.test.ts` measures how often a speaker who
 * did not change trips a two-sigma reading.
 */
export const TRAILING_CALLS = 4;

export function toneDelta(
  current: Transcript,
  trailing: readonly Transcript[],
  section: Section,
  speaker: string,
): ToneDelta {
  const here = tone(current, section, speaker);
  const history = trailing
    .slice(-TRAILING_CALLS)
    .map((t) => tone(t, section, speaker))
    .filter((t) => t.words > 0)
    .map((t) => t.score);

  if (history.length === 0) {
    const base = metric('tone delta', 0, 'per thousand words', [], 'no prior call from this speaker');
    return { ...base, current: here.score, baseline: Number.NaN, trailing: [] };
  }

  const baseline = history.reduce((a, b) => a + b, 0) / history.length;
  const delta = here.score - baseline;
  const spans = [...here.positive, ...here.negative];

  let z: number | undefined;
  if (history.length >= 2) {
    const variance =
      history.reduce((total, x) => total + (x - baseline) ** 2, 0) / (history.length - 1);
    const sd = Math.sqrt(variance);
    if (sd > 0) z = delta / sd;
  }

  const base = metric(
    'tone delta',
    delta,
    'per thousand words',
    delta === 0 ? [] : spans,
    `baseline is ${history.length} call${history.length === 1 ? '' : 's'}; a standard deviation from ${history.length} observations carries roughly ${Math.round((1 / Math.sqrt(2 * (history.length - 1))) * 100)}% relative error, so read the z loosely`,
  );
  return { ...base, current: here.score, baseline, trailing: history, ...(z !== undefined ? { z } : {}) };
}

// ---------------------------------------------------------------------------
// 5. Guidance language change
// ---------------------------------------------------------------------------

const GUIDANCE = /\b(?:guidance|guiding|outlook|we expect|we now expect|for the (?:full year|fiscal year|next quarter)|we are (?:raising|lowering|reiterating|maintaining|withdrawing))\b/i;

export interface GuidanceChange {
  /** Sentence from the prior quarter. */
  before?: string;
  /** Sentence from this quarter. */
  after?: string;
  /** Words dropped and added, for the diff highlight. */
  removed: string[];
  added: string[];
  /** 0 when identical, 1 when nothing survives. */
  distance: number;
}

export interface GuidanceDiff extends Metric {
  changes: GuidanceChange[];
  /** Guidance sentences this quarter that have no counterpart last quarter. */
  novel: string[];
  /** Guidance sentences last quarter that are gone. */
  dropped: string[];
}

function guidanceSentences(transcript: Transcript): Array<{ index: number; text: string; start: number; end: number }> {
  const out: Array<{ index: number; text: string; start: number; end: number }> = [];
  for (const [index, utterance] of executiveTurns(transcript, 'prepared')) {
    for (const sentence of sentences(utterance.text)) {
      if (GUIDANCE.test(sentence.text)) {
        out.push({ index, text: sentence.text, start: sentence.start, end: sentence.end });
      }
    }
  }
  return out;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]*|\d+(?:\.\d+)?%?/g) ?? []);
}

/** Jaccard distance on token sets. */
function distance(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : 1 - shared / union;
}

/**
 * "guidance-language change detection with diff highlighting against the prior
 * quarter's exact phrasing"
 *
 * Each guidance sentence this quarter is matched to its nearest counterpart
 * last quarter, and the word-level diff is what gets highlighted. The matching
 * is deliberately greedy and nearest-first rather than optimal: guidance
 * sentences are few, and an analyst reading a diff wants to see the sentence
 * that most resembles the one they remember, not the assignment that minimises
 * a global cost.
 *
 * A sentence with no counterpart above the similarity floor is reported as
 * novel rather than diffed against the least-bad match. "We are withdrawing
 * full-year guidance" has no prior-quarter counterpart, and diffing it against
 * "we expect revenue growth of 12 to 14 percent" would produce a word salad
 * where the finding should be one word: withdrawn.
 */
export const MATCH_FLOOR = 0.6;

export function guidanceDiff(current: Transcript, prior: Transcript): GuidanceDiff {
  const here = guidanceSentences(current);
  const before = guidanceSentences(prior);
  const used = new Set<number>();
  const changes: GuidanceChange[] = [];
  const novel: string[] = [];
  const spans: Span[] = [];

  for (const sentence of here) {
    let best: { index: number; d: number } | undefined;
    for (let i = 0; i < before.length; i += 1) {
      if (used.has(i)) continue;
      const d = distance(sentence.text, before[i]!.text);
      if (!best || d < best.d) best = { index: i, d };
    }
    if (!best || best.d > MATCH_FLOOR) {
      novel.push(sentence.text);
      spans.push({
        utterance: sentence.index,
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
        speaker: current.utterances[sentence.index]?.speaker ?? '',
      });
      continue;
    }
    used.add(best.index);
    if (best.d === 0) continue;

    const previous = before[best.index]!.text;
    const beforeTokens = new Set(tokens(previous));
    const afterTokens = new Set(tokens(sentence.text));
    changes.push({
      before: previous,
      after: sentence.text,
      removed: [...beforeTokens].filter((t) => !afterTokens.has(t)),
      added: [...afterTokens].filter((t) => !beforeTokens.has(t)),
      distance: best.d,
    });
    spans.push({
      utterance: sentence.index,
      start: sentence.start,
      end: sentence.end,
      text: sentence.text,
      speaker: current.utterances[sentence.index]?.speaker ?? '',
    });
  }

  const dropped = before.filter((_, i) => !used.has(i)).map((s) => s.text);
  const changed = changes.length + novel.length + dropped.length;
  const total = Math.max(here.length, before.length);
  const value = total === 0 ? 0 : changed / total;

  const base = metric('guidance language change', value, 'share of guidance sentences', spans);
  return { ...base, changes, novel, dropped };
}

// ---------------------------------------------------------------------------
// The call's read
// ---------------------------------------------------------------------------

export interface SubtextRead {
  callId: string;
  hedgingPrepared: Metric;
  hedgingQa: Metric;
  forwardLooking: Metric;
  evasion: Evasion;
  toneDelta?: ToneDelta;
  guidance?: GuidanceDiff;
}

export interface SubtextInput {
  current: Transcript;
  prior?: Transcript;
  trailing?: readonly Transcript[];
  /** Whose tone to track. The PRD tracks one speaker against their own past. */
  speaker?: string;
}

export function read(input: SubtextInput): SubtextRead {
  const { current } = input;
  return {
    callId: current.callId,
    // Separated on purpose: prepared remarks are written and lawyered, the Q&A
    // is not, and a density across both measures section lengths.
    hedgingPrepared: hedgingDensity(current, 'prepared'),
    hedgingQa: hedgingDensity(current, 'qa'),
    forwardLooking: forwardLookingRatio(current, 'prepared'),
    evasion: questionEvasion(current),
    ...(input.trailing && input.speaker
      ? { toneDelta: toneDelta(current, input.trailing, 'qa', input.speaker) }
      : {}),
    ...(input.prior ? { guidance: guidanceDiff(current, input.prior) } : {}),
  };
}
