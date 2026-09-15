import { describe, expect, it } from 'vitest';
import {
  DIVERGENCE_BPS,
  additive,
  devig,
  liquidityWeightedMid,
  multiplicative,
  power,
  shin,
  spreadBand,
  type Quote,
} from '../src/devig.js';

const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);

describe('the methods each sum to one', () => {
  const book = [0.55, 0.3, 0.2]; // booksum 1.05

  it('multiplicative', () => {
    expect(sum(multiplicative(book))).toBeCloseTo(1, 12);
  });

  it('additive', () => {
    expect(sum(additive(book))).toBeCloseTo(1, 12);
  });

  it('power', () => {
    expect(sum(power(book).probabilities)).toBeCloseTo(1, 10);
  });

  it('shin', () => {
    expect(sum(shin(book).probabilities)).toBeCloseTo(1, 10);
  });
});

describe('Shin', () => {
  // On a balanced book the model has a closed form: z = (booksum - 1)/(n - 1),
  // and the probabilities are 1/n, the same as multiplicative. Anything else
  // means the solver is not solving what it claims to.
  it('matches its closed form on a balanced book', () => {
    for (const n of [2, 3, 5, 8]) {
      const booksum = 1.08;
      const book = Array.from({ length: n }, () => booksum / n);
      const { probabilities, insiderFraction } = shin(book);
      expect(insiderFraction).toBeCloseTo((booksum - 1) / (n - 1), 8);
      for (const p of probabilities) expect(p).toBeCloseTo(1 / n, 10);
    }
  });

  it('finds no insiders in a book with no margin', () => {
    const { insiderFraction, probabilities } = shin([0.6, 0.4]);
    expect(insiderFraction).toBe(0);
    expect(probabilities).toEqual([0.6, 0.4]);
  });

  // The favourite-longshot bias, which is the whole reason the method exists:
  // Shin shrinks the longshot further than a proportional margin does, and
  // gives the difference back to the favourite.
  it('shrinks the longshot further than multiplicative does', () => {
    const book = [0.9, 0.16]; // a heavy favourite, booksum 1.06
    const mult = multiplicative(book);
    const { probabilities } = shin(book);
    expect(probabilities[1]!).toBeLessThan(mult[1]!);
    expect(probabilities[0]!).toBeGreaterThan(mult[0]!);
  });

  it('agrees with multiplicative on a two-way book that is nearly even', () => {
    const book = [0.53, 0.52];
    const mult = multiplicative(book);
    const { probabilities } = shin(book);
    for (let i = 0; i < 2; i += 1) {
      expect(Math.abs(probabilities[i]! - mult[i]!) * 10_000).toBeLessThan(DIVERGENCE_BPS);
    }
  });
});

describe('additive', () => {
  // Not a rounding problem: a flat per-outcome margin larger than the
  // longshot's own price cannot be subtracted from it, and the negative is the
  // method saying its assumption does not hold here.
  it('returns a negative probability rather than clamping one', () => {
    const result = additive([0.8, 0.3, 0.02]); // booksum 1.12, margin 0.04
    expect(result[2]!).toBeLessThan(0);
  });
});

describe('the divergence flag', () => {
  // "which happens almost exclusively in longshot territory where the
  // favourite-longshot bias bites"
  it('fires on a book with a long longshot and names the favourite-longshot bias', () => {
    const quotes: Quote[] = [
      { outcome: 'favourite', price: 0.92 },
      { outcome: 'longshot', price: 0.14 },
    ];
    const result = devig({ marketType: 'sportsbook', quotes });
    expect(result.divergence).toBeDefined();
    expect(result.divergence?.gapBps).toBeGreaterThan(DIVERGENCE_BPS);
    expect(result.divergence?.explanation).toContain('favourite-longshot');
  });

  // Both sets sum to one, so whatever Shin takes from one side it gives to the
  // other: the absolute gaps are equal and ranking on them is a coin flip.
  // 221bps is 2.5 percent of the favourite and 16.7 percent of the longshot,
  // and the analyst sizing off the longshot is the one whose number moved.
  it('points at the longshot, where the same gap is the larger share of the price', () => {
    const quotes: Quote[] = [
      { outcome: 'favourite', price: 0.92 },
      { outcome: 'longshot', price: 0.14 },
    ];
    const result = devig({ marketType: 'sportsbook', quotes });
    expect(result.divergence?.outcome).toBe('longshot');
    expect(result.divergence?.gapBps).toBe(221);
    expect(result.divergence?.multiplicative).toBeCloseTo(0.1321, 4);
    expect(result.divergence?.shin).toBeCloseTo(0.11, 4);
  });

  it('stays quiet on a book where the choice does not change a decision', () => {
    const quotes: Quote[] = [
      { outcome: 'yes', price: 0.53 },
      { outcome: 'no', price: 0.52 },
    ];
    expect(devig({ marketType: 'sportsbook', quotes }).divergence).toBeUndefined();
  });

  // The alarm is an alarm. One that lists six rows is a table.
  it('reports the worst outcome only', () => {
    const quotes: Quote[] = [
      { outcome: 'a', price: 0.6 },
      { outcome: 'b', price: 0.3 },
      { outcome: 'c', price: 0.14 },
      { outcome: 'd', price: 0.06 },
    ];
    const result = devig({ marketType: 'sportsbook', quotes });
    expect(result.divergence).toBeDefined();
    expect(typeof result.divergence?.outcome).toBe('string');
  });

  it('is computed even when the displayed method is multiplicative', () => {
    const quotes: Quote[] = [
      { outcome: 'favourite', price: 0.92 },
      { outcome: 'longshot', price: 0.14 },
    ];
    const result = devig({ marketType: 'sportsbook', quotes });
    expect(result.method).toBe('multiplicative');
    expect(result.divergence?.shin).not.toBe(result.divergence?.multiplicative);
  });
});

describe('the binary CLOB carve-out (C.4)', () => {
  const clob: Quote[] = [
    { outcome: 'YES', bid: 0.34, ask: 0.36, bidSize: 50_000, askSize: 200 },
    { outcome: 'NO', bid: 0.64, ask: 0.66, bidSize: 200, askSize: 50_000 },
  ];

  // "These are collateralized two-outcome books with no bookmaker margin.
  // Applying a vig-removal method to them is an error that introduces bias
  // where none existed."
  it('does not de-vig', () => {
    const result = devig({ marketType: 'binary_clob', quotes: clob });
    expect(result.method).toBe('none');
    expect(result.assumption).toContain('no bookmaker margin');
  });

  it('reports the spread as the confidence band, since that is the real uncertainty', () => {
    const result = devig({ marketType: 'binary_clob', quotes: clob });
    expect(result.probabilities[0]?.band).toBeCloseTo(0.01, 12);
  });

  // Size pushes the price *away* from the side carrying it. Fifty thousand
  // lots bid against two hundred offered is a queue that will lift the ask,
  // so the next print is near 0.36 and the plain mid at 0.35 understates it.
  it('puts the price on the side about to be consumed, not the side with the depth', () => {
    const mid = liquidityWeightedMid(clob[0]!);
    expect(mid).toBeCloseTo(0.3599, 4);
    expect(mid).toBeGreaterThan(0.35);
    expect(spreadBand(clob[0]!)).toBeCloseTo(0.01, 12);
  });

  it('reverses when the thick side reverses', () => {
    const flipped = liquidityWeightedMid({
      outcome: 'YES',
      bid: 0.34,
      ask: 0.36,
      bidSize: 200,
      askSize: 50_000,
    });
    expect(flipped).toBeCloseTo(0.3401, 4);
  });

  it('falls back to the plain mid when the book carries no sizes', () => {
    expect(liquidityWeightedMid({ outcome: 'y', bid: 0.4, ask: 0.5 })).toBeCloseTo(0.45, 12);
  });

  // The bias the carve-out prevents, measured rather than guessed.
  //
  // Normalizing the asks as though the spread were vig puts YES at 0.3529.
  // The book's own microprice says 0.3599. That is 70 basis points of pure
  // artefact, on a market where the spread itself is 100 — and the direction
  // depends only on which side happens to be thicker, so the artefact moves
  // when the book does and the analyst has no way to see it.
  it('would shift the price by 70bps if the spread were treated as vig', () => {
    const asIfVig = multiplicative([0.36, 0.66]);
    expect(asIfVig[0]!).toBeCloseTo(0.3529, 4);
    const honest = liquidityWeightedMid(clob[0]!);
    const artefactBps = Math.abs(asIfVig[0]! - honest) * 10_000;
    expect(artefactBps).toBeCloseTo(69.8, 1);
  });

  it('still de-vigs a CLOB when the analyst explicitly asks, and says which method', () => {
    const result = devig({ marketType: 'binary_clob', quotes: clob, method: 'multiplicative' });
    expect(result.method).toBe('multiplicative');
    expect(result.assumption).toContain('proportional');
  });
});

describe('multi-outcome markets', () => {
  it('normalize multiplicatively by default, matching what every venue reports', () => {
    const quotes: Quote[] = [
      { outcome: 'cut', price: 0.36 },
      { outcome: 'hold', price: 0.62 },
      { outcome: 'hike', price: 0.06 },
    ];
    const result = devig({ marketType: 'multi_outcome', quotes });
    expect(result.method).toBe('multiplicative');
    expect(result.booksum).toBeCloseTo(1.04, 12);
    expect(sum(result.probabilities.map((p) => p.probability))).toBeCloseTo(1, 12);
  });
});

describe('every result states what it assumed', () => {
  it('because the assumption is the whole content of the number', () => {
    const quotes: Quote[] = [
      { outcome: 'a', price: 0.6 },
      { outcome: 'b', price: 0.5 },
    ];
    for (const method of ['multiplicative', 'additive', 'shin', 'power'] as const) {
      const result = devig({ marketType: 'sportsbook', quotes, method });
      expect(result.assumption.length).toBeGreaterThan(10);
      expect(result.method).toBe(method);
    }
  });
});
