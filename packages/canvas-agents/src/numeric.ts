/**
 * Numerals as they appear in prose, and the tolerance a rendering implies.
 *
 * The Reconciler's job (PRD 4.5) is "resolve numeric conflicts between agents;
 * every number must trace to a cell". Before anything can be traced, the
 * numbers have to be found in the Scribe's text and compared against cell
 * values on terms that do not manufacture disagreement.
 *
 * **The rendering declares the precision.** A narrative that says `-3,870` is
 * claiming the ones digit; if the cell holds -3,870.4 that is a correct
 * rounding, and if it holds -3,880 it is not. So the tolerance is half a unit
 * in the last displayed place, derived from the text rather than configured.
 * A fixed relative tolerance would either pass `-3,900` against `-3,870`
 * (0.8 percent, inside most defaults) or fail honest roundings of small
 * numbers, and the PRD's motivating failure is exactly a number rounded and
 * transcribed wrong.
 *
 * Hedged numbers are the exception, and they have to say so in the text:
 * "about 4,200" widens to a relative band. A Scribe that wants slack must
 * write the slack down where the analyst can read it.
 */

/** Words that buy a number a relative tolerance instead of a last-place one. */
const HEDGE = /(?:about|approximately|roughly|around|circa|~)\s*$/i;

/** How much slack a hedge buys. One percent: enough for a rounded total. */
export const HEDGED_RELATIVE = 0.01;

/** A numeric literal found in text. */
export interface Numeral {
  /** As written, including sign and grouping. */
  literal: string;
  /** Parsed value. */
  value: number;
  /** Index of the first character in the source text. */
  start: number;
  /** Index one past the last character. */
  end: number;
  /** The text hedged this number, so it is claiming a neighbourhood. */
  hedged: boolean;
}

/**
 * Both ASCII hyphen-minus and U+2212. Agent output and copied spreadsheet
 * cells disagree about which one a negative sign is, and a sign that fails to
 * parse would read as a magnitude — which is the one transcription error that
 * must never pass.
 *
 * A currency symbol between the sign and the digits is part of the numeral:
 * `-$396,629` is how a loss is written, and reading it as `396,629` with a
 * stray hyphen in front made a model's correct sentence a transcription error.
 * An unsigned `$396,629` matches from the digits, as it always did.
 */
const SIGN = '(?:[-−][$€£]?)?';
const GROUPED = `${SIGN}\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?`;
const PLAIN = `${SIGN}\\d+(?:\\.\\d+)?`;
const NUMERAL = new RegExp(`${GROUPED}|${PLAIN}`, 'g');

export function parseNumber(literal: string): number {
  return Number.parseFloat(literal.replace(/[,$€£]/g, '').replace(/−/g, '-'));
}

/** Every numeric literal in `text`, in order. */
export function findNumerals(text: string): Numeral[] {
  const found: Numeral[] = [];
  NUMERAL.lastIndex = 0;
  for (let match = NUMERAL.exec(text); match !== null; match = NUMERAL.exec(text)) {
    const literal = match[0];
    const start = match.index;
    found.push({
      literal,
      value: parseNumber(literal),
      start,
      end: start + literal.length,
      hedged: HEDGE.test(text.slice(Math.max(0, start - 24), start)),
    });
  }
  return found;
}

/**
 * Half a unit in the last displayed place.
 *
 * `3,870` -> 0.5, `3.87` -> 0.005, `0.250` -> 0.0005. Trailing zeros after the
 * point count: writing `0.250` claims the third decimal, and a Scribe that did
 * not mean to claim it should not have written it.
 */
export function displayTolerance(literal: string): number {
  const point = literal.indexOf('.');
  const decimals = point < 0 ? 0 : literal.length - point - 1;
  return 0.5 * 10 ** -decimals;
}

/** The band a rendering claims: last-place, or relative when hedged. */
export function toleranceFor(numeral: Numeral): number {
  const exact = displayTolerance(numeral.literal);
  if (!numeral.hedged) return exact;
  return Math.max(exact, Math.abs(numeral.value) * HEDGED_RELATIVE);
}

/** Whether `actual` is inside what `numeral` claims. */
/**
 * Words that put a minus sign on the number after them.
 *
 * "A loss of $396,629" is how a loss is written, and reading it as +396,629
 * failed every draft one real model wrote, on every rewrite, for a number it
 * had right: Phi-3-mini would not write the minus however it was asked. Taking
 * the magnitude instead would open the other hole — "a loss of $396,629"
 * against a *gain* of 396,629 has to fail — so the words are read as the sign
 * they are. A number already written negative is not negated twice: "a loss of
 * -396,629" is sloppy and still means a loss.
 */
const LOSS_WORDS =
  /\b(?:loss(?:es)?(?:\s+of)?|lost|loses?|down(?:\s+by)?|fell(?:\s+by)?|falls?(?:\s+by)?|fall\s+of|declin(?:e|es|ed)(?:\s+(?:of|by))?|drop(?:s|ped)?(?:\s+(?:of|by))?|decrease(?:s|d)?(?:\s+(?:of|by))?|lower\s+by)\s+(?:about\s+|approximately\s+|roughly\s+|around\s+)?[$€£]?$/i;

/** The value a numeral is written as, with the sign its preceding words give it. */
export function proseValue(text: string, numeral: Numeral): { value: number; signedByWords: boolean } {
  const before = text.slice(Math.max(0, numeral.start - 40), numeral.start);
  if (numeral.value > 0 && LOSS_WORDS.test(before)) return { value: -numeral.value, signedByWords: true };
  return { value: numeral.value, signedByWords: false };
}

export function agrees(numeral: Numeral, actual: number): boolean {
  if (!Number.isFinite(actual)) return false;
  return Math.abs(actual - numeral.value) <= toleranceFor(numeral);
}

/**
 * Render `value` the way `literal` was rendered, for the corrected rerun.
 *
 * The Scribe is re-run "with the numbers passed as structured input rather
 * than as prose it must transcribe" (PRD 7.4), so the correction has to arrive
 * already formatted — handing back a raw float invites the same transcription
 * step that produced the error.
 */
export function formatLike(value: number, literal: string): string {
  const point = literal.indexOf('.');
  const decimals = point < 0 ? 0 : literal.length - point - 1;
  const grouped = literal.includes(',');
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole = '0', fraction] = fixed.split('.');
  const body = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  const sign = value < 0 ? (literal.startsWith('−') ? '−' : '-') : '';
  const currency = /[$€£]/.exec(literal)?.[0] ?? '';
  return `${sign}${currency}${body}${fraction === undefined ? '' : `.${fraction}`}`;
}

/**
 * Unit names, normalized far enough to compare and no further.
 *
 * Aliases collapse (`%` and `percent` are one unit); scales do not convert.
 * `usd` and `usd_millions` are different units here, and a fact claiming one
 * against a cell holding the other is a mismatch rather than a multiplication.
 * Converting silently is how a scale bug reaches a decision intact: the whole
 * point of this check is that somebody wrote down the wrong unit, and a
 * converter would write it down for them.
 */
const UNIT_ALIASES: Record<string, string> = {
  '%': 'pct',
  percent: 'pct',
  pct: 'pct',
  bp: 'bps',
  bps: 'bps',
  'basis points': 'bps',
  $: 'usd',
  usd: 'usd',
  dollars: 'usd',
  'vol points': 'vol_pts',
  vol_pts: 'vol_pts',
  shares: 'shares',
};

export function normalizeUnit(unit: string): string {
  const key = unit.trim().toLowerCase();
  return UNIT_ALIASES[key] ?? key;
}

export function sameUnit(a: string, b: string): boolean {
  return normalizeUnit(a) === normalizeUnit(b);
}
