import { beforeAll, describe, expect, it } from 'vitest';
import {
  GridPricer,
  type Cell,
  type GridSpec,
  type Leg,
  type Market,
  type Quality,
} from '../src/grid.js';
import { Pricer } from '../src/pricing.js';
import { readFloats } from '../src/module.js';
import { loadPricing } from './load.js';

let grid: GridPricer;
let pricer: Pricer;
let exports: Awaited<ReturnType<typeof loadPricing>>;

beforeAll(async () => {
  exports = await loadPricing();
  grid = new GridPricer(exports);
  pricer = new Pricer(exports);
});

const market: Market = { spot: 100, rate: 0.045, dividend: 0.017 };
const spec: GridSpec = { spotSteps: 25, spotRange: 0.2, volSteps: 15, volRange: 0.1 };

/** A call spread: long the 100, short the 110. */
const spread: Leg[] = [
  { strike: 100, time: 0.5, kind: 'call', style: 'european', quantity: 10, multiplier: 100, vol: 0.28 },
  { strike: 110, time: 0.5, kind: 'call', style: 'european', quantity: -10, multiplier: 100, vol: 0.26 },
];

/** The PRD's 40-leg book, spread across strikes and expiries. */
function bigBook(count: number, style: Leg['style'] = 'european'): Leg[] {
  return Array.from({ length: count }, (_, i) => ({
    strike: 80 + (i % 20) * 2.5,
    time: 0.08 + (i % 5) * 0.24,
    kind: i % 2 === 0 ? ('call' as const) : ('put' as const),
    style,
    quantity: i % 3 === 0 ? -5 : 5,
    multiplier: 100,
    vol: 0.22 + (i % 7) * 0.02,
  }));
}

describe('the grid comes back whole', () => {
  it('fills every cell of the requested grid', () => {
    const result = grid.reprice(spread, market, spec);
    expect(result.spotCount).toBe(25);
    expect(result.volCount).toBe(15);
    expect(result.cells).toHaveLength(375);
    expect(result.cells.every((c) => Number.isFinite(c.value))).toBe(true);
  });

  it('labels its axes with the values it priced at, not a reconstruction', () => {
    const result = grid.reprice(spread, market, spec);
    // -20% to +20% of 100, and the centre is the unshocked spot exactly.
    expect(result.spotAxis[0]).toBeCloseTo(80, 12);
    expect(result.spotAxis[24]).toBeCloseTo(120, 12);
    expect(result.spotAxis[12]).toBe(100);
    expect(result.volAxis[7]).toBe(0);
  });

  it('agrees with the scalar path cell for cell', () => {
    const result = grid.reprice(spread, market, { ...spec, spotSteps: 3, volSteps: 3 });
    for (let si = 0; si < result.spotCount; si += 1) {
      for (let vi = 0; vi < result.volCount; vi += 1) {
        const expected = spread.reduce((sum, leg) => {
          const price = pricer.price({
            spot: result.spotAxis[si] as number,
            strike: leg.strike,
            time: leg.time,
            rate: market.rate,
            dividend: market.dividend,
            vol: leg.vol + (result.volAxis[vi] as number),
            kind: leg.kind,
          });
          return sum + price * leg.quantity * leg.multiplier;
        }, 0);
        // Same code, same order of operations: an equality, not an epsilon.
        expect(result.cell(si, vi).value).toBe(expected);
      }
    }
  });

  it('a call spread is capped above and floored below', () => {
    const result = grid.reprice(spread, market, spec);
    const atCentreVol = (si: number) => result.cell(si, 7).value;
    // Deep down the spread is worth nearly nothing; deep up it is worth the
    // 10-point width times 10 contracts times 100.
    expect(atCentreVol(0)).toBeLessThan(atCentreVol(24));
    expect(atCentreVol(24)).toBeLessThan(10 * 10 * 100);
    expect(atCentreVol(0)).toBeGreaterThan(0);
  });

  it('applies time decay to every leg', () => {
    const now = grid.reprice(spread, market, spec).cell(12, 7);
    const later = grid.reprice(spread, market, { ...spec, decayDays: 30 }).cell(12, 7);
    // A call spread struck around the money loses value as the long leg decays.
    expect(later.value).not.toBe(now.value);
  });
});

describe('the guard reports on itself', () => {
  it('says nothing was needed when no leg is American', () => {
    const result = grid.reprice(spread, market, spec);
    expect(result.guard.outcome).toBe('not_needed');
    expect(result.guard.escalatedCells).toBe(0);
    expect(result.guard.repricings).toBe(375 * 2);
  });

  it('samples, and says so, when the book holds American legs', () => {
    const result = grid.reprice(bigBook(40, 'american'), market, spec);
    expect(['passed', 'escalated']).toContain(result.guard.outcome);
    expect(result.guard.badge.length).toBeGreaterThan(0);
    // The badge is the analyst-facing sentence, and it names a number.
    expect(result.guard.badge).toMatch(/\d/);
    expect(result.guard.tolerance).toBeGreaterThan(0);
  });

  it('marks the cells it repriced exactly', () => {
    const result = grid.reprice(bigBook(40, 'american'), market, spec);
    const exact = result.cells.filter((c) => c.exact).length;
    expect(exact).toBe(result.guard.outcome === 'escalated' ? result.guard.escalatedCells : 0);
  });

  it('is deterministic: the same book and grid twice give the same badge', () => {
    const first = grid.reprice(bigBook(40, 'american'), market, spec);
    const second = grid.reprice(bigBook(40, 'american'), market, spec);
    expect(second.guard.badge).toBe(first.guard.badge);
    expect(second.cells.map((c) => c.value)).toEqual(first.cells.map((c) => c.value));
  });
});

describe('the boundary is crossed once', () => {
  it('reprices the PRD’s 40-leg book inside the 90ms budget', () => {
    const book = bigBook(40);
    // Warm the module: the first call through a fresh instance pays for
    // tiering-up in the engine, which is not what the budget is about.
    grid.reprice(book, market, spec);

    const runs = Array.from({ length: 20 }, () => grid.reprice(book, market, spec).elapsedMs);
    runs.sort((a, b) => a - b);
    const p95 = runs[Math.min(runs.length - 1, Math.floor(runs.length * 0.95))] as number;
    expect(p95).toBeLessThan(90);
    console.log(
      `  40 legs x 375 cells = 15,000 repricings: p50 ${(runs[10] as number).toFixed(2)}ms, ` +
        `p95 ${p95.toFixed(2)}ms`,
    );
  });

  /**
   * American legs cost far more than European ones, and one scheme does not fit
   * every surface. The engine meets the PRD's 90ms p95 on the hardest book;
   * WASM runs the same code about two and a half times slower and does not.
   * `quality` is the lever, and this is the measurement that says where each
   * level lands.
   */
  it('fits the 90ms budget at the quality a browser should drag at', () => {
    const allAmerican = bigBook(40, 'american');
    const p95 = (quality: Quality): number => {
      const spec2 = { ...spec, quality };
      grid.reprice(allAmerican, market, spec2);
      const runs = Array.from({ length: 8 }, () => grid.reprice(allAmerican, market, spec2).elapsedMs);
      runs.sort((a, b) => a - b);
      return runs[7] as number;
    };

    const draft = p95('draft');
    const standard = p95('standard');
    console.log(`  40 American legs, draft:    p95 ${draft.toFixed(1)}ms`);
    console.log(`  40 American legs, standard: p95 ${standard.toFixed(1)}ms`);

    // The level a browser drags at fits. The level the server computes at does
    // not, on this book, and that is why the lever exists.
    expect(draft).toBeLessThan(90);
    expect(standard).toBeGreaterThan(draft);
  });

  it('says on the badge that a draft grid was never checked', () => {
    const book = bigBook(40, 'american');
    const drafted = grid.reprice(book, market, { ...spec, quality: 'draft' });
    expect(drafted.quality).toBe('draft');
    expect(drafted.guard.badge).toBe('draft, unchecked');
    expect(drafted.guard.outcome).toBe('not_needed');

    // Not a claim of exactness — the difference between "we did not check" and
    // "there was nothing to check" has to survive to the badge.
    const european = grid.reprice(bigBook(40), market, { ...spec, quality: 'draft' });
    expect(european.guard.badge).toBe('exact');
  });

  it('draft and standard agree to well inside a tick', () => {
    const book = bigBook(40, 'american');
    const draft = grid.reprice(book, market, { ...spec, quality: 'draft' });
    const standard = grid.reprice(book, market, { ...spec, quality: 'standard' });

    let worst = 0;
    for (let i = 0; i < draft.cells.length; i += 1) {
      const a = draft.cells[i] as Cell;
      const b = standard.cells[i] as Cell;
      worst = Math.max(worst, Math.abs(a.value - b.value));
    }
    // Book-level, across 40 legs of 5 contracts at a 100 multiplier. Half a
    // tick on that book is 0.5c x 20,000 shares = $100.
    console.log(`  draft vs standard, worst cell: $${worst.toFixed(2)}`);
    expect(worst).toBeLessThan(100);
    // And they are genuinely different numbers, so the cache must not conflate
    // them — which is why the quality comes back on the result.
    expect(worst).toBeGreaterThan(0);
    expect(draft.quality).not.toBe(standard.quality);
  });
});

describe('reading out of linear memory', () => {
  it('copies, so a later call cannot rewrite a result already handed out', () => {
    const first = grid.reprice(spread, market, spec);
    const snapshot = first.cells.map((c) => c.value);
    // A second, much larger grid reallocates the cell vector behind the
    // pointer the first read came from. A retained view would now be showing
    // the second grid's numbers, or freed memory.
    grid.reprice(bigBook(40), market, { ...spec, spotSteps: 61, volSteps: 41 });
    expect(first.cells.map((c) => c.value)).toEqual(snapshot);
  });

  it('survives the memory growth that detaches a retained view', () => {
    const result = grid.reprice(spread, market, spec);
    const copied = result.cell(0, 0).value;
    // What a caller would hold if `readFloats` did not copy: a view aliasing
    // WASM linear memory.
    const aliased = new Float64Array(exports.memory.buffer, exports.pc_grid_data(), 1);
    expect(aliased[0]).toBe(copied);

    // Big enough to force the module to grow its memory.
    grid.reprice(bigBook(200), market, { ...spec, spotSteps: 101, volSteps: 61 });

    // Detached (length 0) if the buffer was replaced, otherwise pointing at
    // whatever now occupies that address. Either way it is no longer the value
    // it was handed out as, which is the whole reason for the copy.
    const stillValid = aliased.length === 1 && aliased[0] === copied;
    expect(stillValid).toBe(false);
    expect(result.cell(0, 0).value).toBe(copied);
    // And a fresh read through the proper path still works.
    expect(readFloats(exports.memory, exports.pc_grid_data(), 1)).toHaveLength(1);
  });

  it('refuses an empty book rather than returning an empty surface', () => {
    expect(() => grid.reprice([], market, spec)).toThrow(/empty book/);
  });
});
