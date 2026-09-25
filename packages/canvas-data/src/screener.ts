/**
 * The screener behind a `UniverseNode` (PRD 3.3).
 *
 * > `UniverseNode`: screener expression that resolves to a set of instruments.
 *
 * and, from 5.8, "universes resolve as of the historical date, including
 * delisted names". A small expression language, parsed by hand — no `eval`,
 * which the canvas's own content security policy refuses anyway — and three
 * decisions about what an expression means when the data is not tidy.
 *
 * ## A field nobody has is an error, not an empty universe
 *
 * `markte_cap > 10b` matches nothing, and an empty universe is a perfectly
 * plausible answer to a strict screen. So an unknown field is refused by name,
 * with the nearest known field suggested, before anything is evaluated.
 *
 * ## Missing data is unknown, not false
 *
 * A name with no short-interest figure is not a name with zero short interest.
 * Comparisons against a missing value are *unknown*, combined by Kleene's
 * three-valued logic, and a name is a member only when the expression is
 * definitely true. That matters under `not`: with two-valued logic,
 * `not (short_interest > 0.2)` would admit every name missing the field as a
 * low-short-interest name. Names left out for want of data are counted and
 * reported by field, because "the screen returned 40" and "the screen returned
 * 40 and could not evaluate 300" are different results.
 *
 * ## Membership is as of the canvas date
 *
 * A name is eligible if it was listed on the as-of date: listed on or before
 * it, and delisted after it or never. A screen run as of 2019 includes the
 * names that were trading in 2019 and have since gone — the survivorship rule —
 * and excludes names that listed later.
 */

import { createNode, type NodeID, type PicassoNode } from '@picasso/canvas-core';

export type FieldValue = number | string | undefined;

export interface ScreenRow {
  instrument: string;
  /** ISO date listed. */
  listed: string;
  /** ISO date delisted, if it has been. */
  delisted?: string;
  /** Point-in-time field values as of the screen's date. Absent is unknown. */
  fields: Readonly<Record<string, FieldValue>>;
}

type Op = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Expr =
  | { kind: 'and'; left: Expr; right: Expr }
  | { kind: 'or'; left: Expr; right: Expr }
  | { kind: 'not'; operand: Expr }
  | { kind: 'cmp'; field: string; op: Op; value: number | string }
  | { kind: 'in'; field: string; values: Array<number | string> };

export class ScreenSyntaxError extends Error {
  constructor(readonly position: number, detail: string) {
    super(`screener expression, at character ${position}: ${detail}`);
    this.name = 'ScreenSyntaxError';
  }
}

export class UnknownField extends Error {
  constructor(readonly field: string, readonly suggestion: string | undefined) {
    super(
      `no instrument has a field called "${field}"` +
        (suggestion ? `; did you mean "${suggestion}"?` : '') +
        ' — an unknown field is refused rather than screening everything out',
    );
    this.name = 'UnknownField';
  }
}

export class TypeMismatch extends Error {
  constructor(readonly field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = 'TypeMismatch';
  }
}

// ---------------------------------------------------------------------------
// Tokens and parsing
// ---------------------------------------------------------------------------

type Token =
  | { t: 'ident'; v: string; at: number }
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'op'; v: Op; at: number }
  | { t: 'punct'; v: '(' | ')' | '[' | ']' | ','; at: number }
  | { t: 'end'; at: number };

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, '%': 0.01 };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ('()[],'.includes(c)) {
      tokens.push({ t: 'punct', v: c as '(' | ')' | '[' | ']' | ',', at: i });
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ t: 'op', v: two, at: i });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>') {
      tokens.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = source.indexOf(c, i + 1);
      if (end < 0) throw new ScreenSyntaxError(i, 'unterminated string');
      tokens.push({ t: 'str', v: source.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const number = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?([kmbt%])?/i.exec(source.slice(i));
    if (number && (c === '-' || /[\d.]/.test(c))) {
      const scale = number[3] ? SUFFIX[number[3].toLowerCase()]! : 1;
      tokens.push({ t: 'num', v: Number(number[1]! + (number[2] ?? '')) * (c === '-' ? -1 : 1) * scale, at: i });
      i += number[0].length;
      continue;
    }
    const ident = /^[a-z_][a-z0-9_]*/i.exec(source.slice(i));
    if (ident) {
      tokens.push({ t: 'ident', v: ident[0], at: i });
      i += ident[0].length;
      continue;
    }
    throw new ScreenSyntaxError(i, `unexpected "${c}"`);
  }
  tokens.push({ t: 'end', at: source.length });
  return tokens;
}

/**
 * Parses a screener expression.
 *
 * `not` binds tighter than `and`, which binds tighter than `or`, as in SQL and
 * as a reader expects: `a or b and c` is `a or (b and c)`.
 */
export function parseScreen(source: string): Expr {
  const tokens = tokenize(source);
  let p = 0;
  const peek = () => tokens[p]!;
  const keyword = (word: string) => {
    const t = peek();
    return t.t === 'ident' && t.v.toLowerCase() === word;
  };

  const orExpr = (): Expr => {
    let left = andExpr();
    while (keyword('or')) {
      p++;
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  };
  const andExpr = (): Expr => {
    let left = notExpr();
    while (keyword('and')) {
      p++;
      left = { kind: 'and', left, right: notExpr() };
    }
    return left;
  };
  const notExpr = (): Expr => {
    if (keyword('not')) {
      p++;
      return { kind: 'not', operand: notExpr() };
    }
    return primary();
  };
  const literal = (): number | string => {
    const t = peek();
    if (t.t === 'num' || t.t === 'str') {
      p++;
      return t.v;
    }
    throw new ScreenSyntaxError(t.at, 'expected a number or a quoted string');
  };
  const primary = (): Expr => {
    const t = peek();
    if (t.t === 'punct' && t.v === '(') {
      p++;
      const inner = orExpr();
      const close = peek();
      if (!(close.t === 'punct' && close.v === ')')) throw new ScreenSyntaxError(close.at, 'expected ")"');
      p++;
      return inner;
    }
    if (t.t !== 'ident' || ['and', 'or', 'not', 'in'].includes(t.v.toLowerCase())) {
      throw new ScreenSyntaxError(t.at, 'expected a field name');
    }
    p++;
    const field = t.v;
    if (keyword('in')) {
      p++;
      const open = peek();
      if (!(open.t === 'punct' && open.v === '[')) throw new ScreenSyntaxError(open.at, 'expected "[" after in');
      p++;
      const values = [literal()];
      while (peek().t === 'punct' && (peek() as { v: string }).v === ',') {
        p++;
        values.push(literal());
      }
      const close = peek();
      if (!(close.t === 'punct' && close.v === ']')) throw new ScreenSyntaxError(close.at, 'expected "]"');
      p++;
      return { kind: 'in', field, values };
    }
    const op = peek();
    if (op.t !== 'op') throw new ScreenSyntaxError(op.at, `expected a comparison after ${field}`);
    p++;
    return { kind: 'cmp', field, op: op.v, value: literal() };
  };

  const expr = orExpr();
  if (peek().t !== 'end') throw new ScreenSyntaxError(peek().at, 'unexpected text after the expression');
  return expr;
}

// ---------------------------------------------------------------------------
// Checking and evaluation
// ---------------------------------------------------------------------------

function fieldsOf(expr: Expr, out: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'and':
    case 'or':
      fieldsOf(expr.left, out);
      fieldsOf(expr.right, out);
      break;
    case 'not':
      fieldsOf(expr.operand, out);
      break;
    case 'cmp':
    case 'in':
      out.add(expr.field);
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Three-valued truth: true, false, or unknown because a value was missing. */
type Truth = true | false | undefined;

function compare(value: FieldValue, op: Op, target: number | string, field: string): Truth {
  if (value === undefined) return undefined;
  if (typeof value !== typeof target) {
    throw new TypeMismatch(field, `holds ${typeof value}s and is being compared with ${JSON.stringify(target)}`);
  }
  if (typeof value === 'string' && op !== '==' && op !== '!=') {
    throw new TypeMismatch(field, `text can only be compared with == or !=, not ${op}`);
  }
  switch (op) {
    case '==':
      return value === target;
    case '!=':
      return value !== target;
    case '<':
      return value < target;
    case '<=':
      return value <= target;
    case '>':
      return value > target;
    case '>=':
      return value >= target;
  }
}

function evaluate(expr: Expr, row: ScreenRow, unknownFields: Set<string>): Truth {
  switch (expr.kind) {
    case 'and': {
      const l = evaluate(expr.left, row, unknownFields);
      if (l === false) return false;
      const r = evaluate(expr.right, row, unknownFields);
      if (r === false) return false;
      return l === true && r === true ? true : undefined;
    }
    case 'or': {
      const l = evaluate(expr.left, row, unknownFields);
      if (l === true) return true;
      const r = evaluate(expr.right, row, unknownFields);
      if (r === true) return true;
      return l === false && r === false ? false : undefined;
    }
    case 'not': {
      const v = evaluate(expr.operand, row, unknownFields);
      return v === undefined ? undefined : !v;
    }
    case 'cmp': {
      const v = compare(row.fields[expr.field], expr.op, expr.value, expr.field);
      if (v === undefined) unknownFields.add(expr.field);
      return v;
    }
    case 'in': {
      const value = row.fields[expr.field];
      if (value === undefined) {
        unknownFields.add(expr.field);
        return undefined;
      }
      for (const target of expr.values) {
        if (compare(value, '==', target, expr.field)) return true;
      }
      return false;
    }
  }
}

export interface Universe {
  asof: string;
  expression: string;
  members: string[];
  /** Names listed on the date for which the expression could not be decided. */
  undecided: { count: number; byField: Record<string, number> };
  /** Names eligible on the date at all, before the expression. */
  eligible: number;
}

/**
 * Resolves a screen against rows as of a date.
 *
 * The rows' field values must already be point-in-time for `asof` — that is
 * the bitemporal store's job — and this decides which of them were trading and
 * which pass.
 */
export function resolveUniverse(expression: string, rows: readonly ScreenRow[], asof: string): Universe {
  const expr = parseScreen(expression);
  const known = new Set<string>();
  for (const row of rows) for (const field of Object.keys(row.fields)) known.add(field);
  for (const field of fieldsOf(expr)) {
    if (known.has(field)) continue;
    let best: string | undefined;
    let bestDistance = 3;
    for (const candidate of known) {
      const d = editDistance(field, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    throw new UnknownField(field, best);
  }

  const members: string[] = [];
  const byField: Record<string, number> = {};
  let undecided = 0;
  let eligible = 0;
  for (const row of rows) {
    if (row.listed > asof) continue;
    if (row.delisted !== undefined && row.delisted <= asof) continue;
    eligible += 1;
    const unknownFields = new Set<string>();
    const truth = evaluate(expr, row, unknownFields);
    if (truth === true) members.push(row.instrument);
    else if (truth === undefined) {
      undecided += 1;
      for (const field of unknownFields) byField[field] = (byField[field] ?? 0) + 1;
    }
  }
  return { asof, expression, members: members.sort(), undecided: { count: undecided, byField }, eligible };
}

/**
 * A `UniverseNode` holding a screen.
 *
 * The expression is parsed here, at creation, so a node never holds one that
 * cannot be read: a syntax error surfaces while the analyst is typing it, not
 * at the first evaluation of a canvas somebody else opened later.
 */
export function createUniverseNode(id: NodeID, expression: string): PicassoNode {
  parseScreen(expression);
  return createNode({
    id,
    kind: 'UniverseNode',
    binding: 'wired',
    inputs: [],
    outputs: [{ id: 'universe', name: 'Universe', type: 'universe', cardinality: 'one', required: false }],
    params: { expression },
  });
}
