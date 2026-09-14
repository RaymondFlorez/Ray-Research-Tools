import { describe, expect, it } from 'vitest';
import {
  agrees,
  displayTolerance,
  findNumerals,
  formatLike,
  normalizeUnit,
  parseNumber,
  sameUnit,
  toleranceFor,
} from '../src/numeric.js';

describe('finding numerals in prose', () => {
  it('reads grouping, decimals and both minus signs', () => {
    const found = findNumerals('vega -3,870 and delta 12,450.5 against −6.2%');
    expect(found.map((n) => n.value)).toEqual([-3870, 12450.5, -6.2]);
  });

  it('reports spans that index back into the source', () => {
    const text = 'total vega of -3,870 today';
    const [first] = findNumerals(text);
    expect(text.slice(first?.start, first?.end)).toBe('-3,870');
  });

  it('does not treat a grouped number as two numbers', () => {
    expect(findNumerals('12,450')).toHaveLength(1);
  });

  it('marks a hedged number as hedged', () => {
    const [plain] = findNumerals('vega of 4,200');
    const [hedged] = findNumerals('vega of about 4,200');
    expect(plain?.hedged).toBe(false);
    expect(hedged?.hedged).toBe(true);
  });

  it('does not let a hedge word reach across a sentence', () => {
    const [n] = findNumerals('roughly right. The total is 4,200');
    expect(n?.hedged).toBe(false);
  });
});

describe('the tolerance a rendering claims', () => {
  it('is half a unit in the last displayed place', () => {
    expect(displayTolerance('3,870')).toBe(0.5);
    expect(displayTolerance('3.87')).toBeCloseTo(0.005, 12);
    expect(displayTolerance('0.250')).toBeCloseTo(0.0005, 12);
  });

  it('accepts an honest rounding and rejects a wrong one', () => {
    const [n] = findNumerals('-3,870');
    expect(agrees(n!, -3870.4)).toBe(true);
    expect(agrees(n!, -3880)).toBe(false);
  });

  // The motivating case from PRD 7.4: -4,200 written where the node says
  // -3,870. Any relative tolerance loose enough to be useful elsewhere would
  // still catch this one, but the point of the last-place rule is that it also
  // catches -3,900, which a one percent band would pass.
  it('catches the rounding a relative band would pass', () => {
    const [n] = findNumerals('-3,900');
    expect(agrees(n!, -3870)).toBe(false);
  });

  it('gives a hedged number a relative band instead', () => {
    const [n] = findNumerals('about 12,500');
    expect(toleranceFor(n!)).toBeCloseTo(125, 6);
    expect(agrees(n!, 12450)).toBe(true);
    expect(agrees(n!, 11000)).toBe(false);
  });
});

describe('rendering a correction the way the draft rendered the error', () => {
  it('keeps grouping, precision and sign style', () => {
    expect(formatLike(-3870, '-4,200')).toBe('-3,870');
    expect(formatLike(-3870, '−4,200')).toBe('−3,870');
    expect(formatLike(6.25, '9.9')).toBe('6.3');
    expect(formatLike(1234567, '0')).toBe('1234567');
  });
});

describe('units', () => {
  it('collapses aliases', () => {
    expect(normalizeUnit('%')).toBe('pct');
    expect(sameUnit('percent', 'pct')).toBe(true);
    expect(sameUnit('basis points', 'bps')).toBe(true);
  });

  // Converting here would defeat the purpose: the check exists because
  // somebody wrote the wrong scale down, and a converter would quietly write
  // it down for them.
  it('does not convert a scale', () => {
    expect(sameUnit('usd', 'usd_millions')).toBe(false);
  });
});

describe('parsing', () => {
  it('handles the unicode minus that arrives from a copied cell', () => {
    expect(parseNumber('−3,870')).toBe(-3870);
  });
});
