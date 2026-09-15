/**
 * Transcripts, diarized and section-tagged (PRD 5.2).
 *
 * "transcripts are ingested with speaker diarization and section tagging
 * (prepared remarks vs Q&A)."
 *
 * The section tag is not metadata, it is the unit of analysis. Prepared
 * remarks are written, lawyered and rehearsed; the Q&A is not. A hedging
 * density computed across both at once measures how long the prepared section
 * was relative to the questions, which varies by company and by quarter for
 * reasons that have nothing to do with what anybody is hiding. Every metric in
 * `subtext.ts` therefore takes a section and none of them defaults to "all".
 */

export type Section = 'prepared' | 'qa';
export type SpeakerRole = 'executive' | 'analyst' | 'operator';

export interface Utterance {
  speaker: string;
  role: SpeakerRole;
  section: Section;
  text: string;
}

export interface Transcript {
  callId: string;
  company: string;
  /** Fiscal period the call covers, e.g. `2026Q1`. */
  period: string;
  at: string;
  utterances: Utterance[];
}

/**
 * A span, indexed into one utterance.
 *
 * "Each metric outputs both a number and the specific spans that produced it,
 * so the analyst can click a score and land on the sentences."
 */
export interface Span {
  /** Index into `Transcript.utterances`. */
  utterance: number;
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export class UnevidencedMetric extends Error {
  constructor(readonly metric: string) {
    super(`${metric} reported a non-zero value with no spans behind it`);
    this.name = 'UnevidencedMetric';
  }
}

/**
 * A number and the sentences that produced it.
 *
 * The constructor refuses a non-zero value with no evidence, which is the
 * enforceable form of "click a score and land on the sentences". A metric that
 * can report 33 with nothing to click is a metric nobody can check, and the
 * whole subtext engine is otherwise a machine for generating numbers that
 * sound authoritative about prose.
 */
export interface Metric {
  name: string;
  value: number;
  unit: string;
  spans: Span[];
  /** Set when the number rests on too little to mean much. */
  caveat?: string;
}

export function metric(
  name: string,
  value: number,
  unit: string,
  spans: Span[],
  caveat?: string,
): Metric {
  if (value !== 0 && spans.length === 0) throw new UnevidencedMetric(name);
  return { name, value, unit, spans, ...(caveat !== undefined ? { caveat } : {}) };
}

export function inSection(transcript: Transcript, section: Section): Array<[number, Utterance]> {
  return transcript.utterances
    .map((utterance, index) => [index, utterance] as [number, Utterance])
    .filter(([, utterance]) => utterance.section === section);
}

export function executiveTurns(transcript: Transcript, section: Section): Array<[number, Utterance]> {
  return inSection(transcript, section).filter(([, u]) => u.role === 'executive');
}

const WORD = /[A-Za-z][A-Za-z'-]*/g;

export function wordCount(text: string): number {
  return (text.match(WORD) ?? []).length;
}

/** Split into sentences, keeping each one's offset in the source. */
export function sentences(text: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  const pattern = /[.!?]+(?=\s|$)/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const end = match.index + match[0].length;
    const slice = text.slice(start, end).trim();
    if (slice !== '') {
      const offset = text.indexOf(slice, start);
      out.push({ start: offset, end: offset + slice.length, text: slice });
    }
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') {
    const offset = text.indexOf(tail, start);
    out.push({ start: offset, end: offset + tail.length, text: tail });
  }
  return out;
}

/** Every match of `pattern` in an utterance, as spans. */
export function spansOf(
  transcript: Transcript,
  index: number,
  pattern: RegExp,
): Span[] {
  const utterance = transcript.utterances[index];
  if (!utterance) return [];
  const out: Span[] = [];
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (let match = scan.exec(utterance.text); match !== null; match = scan.exec(utterance.text)) {
    out.push({
      utterance: index,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      speaker: utterance.speaker,
    });
    if (match[0] === '') scan.lastIndex += 1;
  }
  return out;
}
