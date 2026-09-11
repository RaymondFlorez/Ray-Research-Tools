/**
 * Multi-leg repricing across a spot-vol grid (PRD 5.4, Appendix C.2).
 *
 * "A 40-leg book across a 25x15 spot-vol grid is 15,000 repricings, in under
 * 90ms p95." That number is only reachable if the boundary is crossed once:
 * the book is pushed leg by leg, the grid is repriced in a single call, and the
 * cells are read straight out of linear memory as a typed array. A call per
 * cell would spend more time in the bridge than in the arithmetic.
 */

import { readFloats, readUtf8, type PricingExports } from './module.js';
import type { OptionKind } from './pricing.js';

export type ExerciseStyle = 'european' | 'american';

/** One position. `quantity` is signed; negative is short. */
export interface Leg {
  strike: number;
  /** Years to expiry. */
  time: number;
  kind: OptionKind;
  style: ExerciseStyle;
  quantity: number;
  /** Contract multiplier: 100 for listed US equity options. */
  multiplier: number;
  /** Per-leg vol, before the grid's vol shift. */
  vol: number;
}

export interface Market {
  spot: number;
  rate: number;
  dividend: number;
}

export interface GridSpec {
  /** Number of spot levels. The PRD's worked example is 25. */
  spotSteps: number;
  /** Half-width of the spot axis as a fraction: 0.2 spans -20% to +20%. */
  spotRange: number;
  /** Number of vol levels. The PRD's worked example is 15. */
  volSteps: number;
  /** Half-width of the vol axis in vol points: 0.1 spans -10pts to +10pts. */
  volRange: number;
  /** Days of theta decay applied to every leg. */
  decayDays?: number;
}

/** One cell: the book's value and aggregate Greeks under that shock. */
export interface Cell {
  value: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  /** True when the guard escalated this cell to the exact lattice. */
  exact: boolean;
}

export type GuardOutcome = 'not_needed' | 'passed' | 'escalated';

export interface GuardReport {
  outcome: GuardOutcome;
  /** Largest absolute error found in the sample, in currency. */
  maxError: number;
  /** The tolerance that applied, in currency. */
  tolerance: number;
  escalatedCells: number;
  /** Repricings performed: the fast path and any escalation together. */
  repricings: number;
  /** What the node shows the analyst. Composed in Rust, so it cannot drift. */
  badge: string;
}

export interface GridResult {
  cells: Cell[];
  spotCount: number;
  volCount: number;
  /** Spot levels each column was priced at, as the engine used them. */
  spotAxis: Float64Array;
  /** Vol shifts each row was priced at, in vol points. */
  volAxis: Float64Array;
  guard: GuardReport;
  /** Wall time for the WASM call alone, which is what the budget is about. */
  elapsedMs: number;
  /** Row-major by spot, matching the crate's own accessor. */
  cell(spotIndex: number, volIndex: number): Cell;
}

const OUTCOMES: readonly GuardOutcome[] = ['not_needed', 'passed', 'escalated'];

/** Field order of one packed cell, matching `ffi::CELL_STRIDE`. */
const VALUE = 0, DELTA = 1, GAMMA = 2, VEGA = 3, THETA = 4, EXACT = 5;

export class GridPricer {
  constructor(readonly exports: PricingExports) {}

  reprice(book: readonly Leg[], market: Market, spec: GridSpec): GridResult {
    if (book.length === 0) {
      throw new Error('cannot reprice an empty book: a StrategyNode with no legs has no surface');
    }
    const w = this.exports;

    w.pc_book_reset();
    for (const leg of book) {
      w.pc_book_add_leg(
        leg.strike, leg.time,
        leg.kind === 'call' ? 1 : 0,
        leg.style === 'american' ? 1 : 0,
        leg.quantity, leg.multiplier, leg.vol,
      );
    }

    const started = performance.now();
    const count = w.pc_grid_reprice(
      market.spot, market.rate, market.dividend,
      spec.spotSteps, spec.spotRange, spec.volSteps, spec.volRange,
      spec.decayDays ?? 0,
    );
    const elapsedMs = performance.now() - started;
    if (count < 0) throw new Error('the module reports an empty book');

    const stride = w.pc_grid_stride();
    const packed = readFloats(w.memory, w.pc_grid_data(), count * stride);

    const cells: Cell[] = new Array<Cell>(count);
    for (let i = 0; i < count; i += 1) {
      const at = i * stride;
      cells[i] = {
        value: packed[at + VALUE] as number,
        delta: packed[at + DELTA] as number,
        gamma: packed[at + GAMMA] as number,
        vega: packed[at + VEGA] as number,
        theta: packed[at + THETA] as number,
        exact: packed[at + EXACT] !== 0,
      };
    }

    const spotAxis = readFloats(w.memory, w.pc_grid_axis_ptr(0), w.pc_grid_axis_len(0));
    const volAxis = readFloats(w.memory, w.pc_grid_axis_ptr(1), w.pc_grid_axis_len(1));
    const volCount = volAxis.length;

    return {
      cells,
      spotCount: spotAxis.length,
      volCount,
      spotAxis,
      volAxis,
      guard: this.guard(),
      elapsedMs,
      cell(spotIndex: number, volIndex: number): Cell {
        const cell = cells[spotIndex * volCount + volIndex];
        if (cell === undefined) throw new RangeError(`no cell at [${spotIndex}, ${volIndex}]`);
        return cell;
      },
    };
  }

  /** The guard's own report on the grid it just produced. */
  private guard(): GuardReport {
    const w = this.exports;
    return {
      outcome: OUTCOMES[w.pc_guard_value(0)] ?? 'not_needed',
      maxError: w.pc_guard_value(1),
      tolerance: w.pc_guard_value(2),
      escalatedCells: w.pc_guard_value(3),
      repricings: w.pc_guard_value(4),
      badge: readUtf8(w.memory, w.pc_guard_badge_ptr(), w.pc_guard_badge_len()),
    };
  }
}
