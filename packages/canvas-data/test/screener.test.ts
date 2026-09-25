import { describe, expect, it } from 'vitest';
import {
  ScreenSyntaxError,
  createUniverseNode,
  TypeMismatch,
  UnknownField,
  parseScreen,
  resolveUniverse,
  type ScreenRow,
} from '../src/screener.js';

const rows: ScreenRow[] = [
  { instrument: 'NVDA', listed: '1999-01-22', fields: { sector: 'semis', market_cap: 2.2e12, adv: 45e9, short_interest: 0.011 } },
  { instrument: 'AMD', listed: '1979-03-17', fields: { sector: 'semis', market_cap: 2.6e11, adv: 9e9, short_interest: 0.025 } },
  { instrument: 'WOLF', listed: '1993-02-01', delisted: '2025-07-01', fields: { sector: 'semis', market_cap: 1.9e9, adv: 1.2e8, short_interest: 0.32 } },
  { instrument: 'ARM', listed: '2023-09-14', fields: { sector: 'semis', market_cap: 1.4e11, adv: 3e9 } },
  { instrument: 'XOM', listed: '1920-01-01', fields: { sector: 'energy', market_cap: 4.6e11, adv: 2e9, short_interest: 0.008 } },
];

describe('parsing', () => {
  it('binds not tighter than and, and and tighter than or', () => {
    expect(parseScreen('a > 1 or b > 2 and not c > 3')).toEqual({
      kind: 'or',
      left: { kind: 'cmp', field: 'a', op: '>', value: 1 },
      right: {
        kind: 'and',
        left: { kind: 'cmp', field: 'b', op: '>', value: 2 },
        right: { kind: 'not', operand: { kind: 'cmp', field: 'c', op: '>', value: 3 } },
      },
    });
  });

  it('reads 10b, 5m, 20% and negative numbers as numbers', () => {
    const value = (src: string) => (parseScreen(src) as { value: number }).value;
    expect(value('x > 10b')).toBe(1e10);
    expect(value('x > 5m')).toBe(5e6);
    expect(value('x < 20%')).toBeCloseTo(0.2, 15);
    expect(value('x > -1.5')).toBe(-1.5);
    expect(value('x > 1e3')).toBe(1000);
  });

  it('says where it stopped understanding', () => {
    expect(() => parseScreen('market_cap >')).toThrow(ScreenSyntaxError);
    expect(() => parseScreen('(market_cap > 1')).toThrow(/expected "\)"/);
    expect(() => parseScreen('market_cap > 1 1')).toThrow(/after the expression/);
    expect(() => parseScreen('market_cap ~ 1')).toThrow(/character 11/);
  });
});

describe('resolving a universe', () => {
  it('returns the names that pass, as of the date', () => {
    const u = resolveUniverse('sector == "semis" and market_cap > 100b', rows, '2026-03-11');
    expect(u.members).toEqual(['AMD', 'ARM', 'NVDA']);
  });

  it('includes a name delisted since, and excludes one listed since', () => {
    // As of 2019: WOLF was trading, ARM had not listed.
    const u = resolveUniverse('sector == "semis"', rows, '2019-06-30');
    expect(u.members).toEqual(['AMD', 'NVDA', 'WOLF']);
    expect(u.eligible).toBe(4);
    expect(resolveUniverse('sector == "semis"', rows, '2026-03-11').members).not.toContain('WOLF');
  });

  it('accepts a list with in', () => {
    const u = resolveUniverse('sector in ["energy", "utilities"]', rows, '2026-03-11');
    expect(u.members).toEqual(['XOM']);
  });

  it('treats a missing value as unknown, so not does not admit it', () => {
    // ARM has no short-interest figure. Under two-valued logic it would pass
    // this screen as a low-short-interest name.
    const u = resolveUniverse('sector == "semis" and not short_interest > 5%', rows, '2026-03-11');
    expect(u.members).toEqual(['AMD', 'NVDA']);
    expect(u.undecided).toEqual({ count: 1, byField: { short_interest: 1 } });
  });

  it('still decides what a missing value cannot change', () => {
    // Unknown or true is true; unknown and false is false.
    expect(resolveUniverse('short_interest > 5% or sector == "semis"', rows, '2026-03-11').members).toContain('ARM');
    const u = resolveUniverse('short_interest > 5% and sector == "energy"', rows, '2026-03-11');
    expect(u.undecided.count).toBe(0);
  });

  it('refuses a field nobody has, and suggests the one that was meant', () => {
    // A typo that silently screened everything out would look like a strict screen.
    expect(() => resolveUniverse('markte_cap > 10b', rows, '2026-03-11')).toThrow(UnknownField);
    expect(() => resolveUniverse('markte_cap > 10b', rows, '2026-03-11')).toThrow(/did you mean "market_cap"/);
  });

  it('refuses to compare text with numbers, or to order text', () => {
    expect(() => resolveUniverse('sector > 5', rows, '2026-03-11')).toThrow(TypeMismatch);
    expect(() => resolveUniverse('sector > "m"', rows, '2026-03-11')).toThrow(/only be compared with == or !=/);
  });

  it('never evaluates the expression as code', () => {
    // The parser is the only thing that reads it: a string that would be a
    // program anywhere else is a syntax error here.
    expect(() => resolveUniverse('globalThis.process.exit(1)', rows, '2026-03-11')).toThrow(ScreenSyntaxError);
  });
});

describe('the UniverseNode', () => {
  it('holds a screen and emits a universe', () => {
    const node = createUniverseNode('u1', 'sector == "semis" and market_cap > 100b');
    expect(node.kind).toBe('UniverseNode');
    expect(node.outputs.map((p) => p.type)).toEqual(['universe']);
    expect(node.params.expression).toBe('sector == "semis" and market_cap > 100b');
  });

  it('refuses an expression it cannot parse, at creation', () => {
    expect(() => createUniverseNode('u2', 'sector == ')).toThrow(ScreenSyntaxError);
  });
});
