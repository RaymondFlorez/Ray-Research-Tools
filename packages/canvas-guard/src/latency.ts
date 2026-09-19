/**
 * The latency budgets (PRD 7.1), as data.
 *
 * > These are contractual, monitored per-interaction, and alerted on.
 *
 * A contractual table that exists only in a document is monitored by whoever
 * remembers it. This file is the table, the evidence behind each row, and the
 * function that says whether an observed distribution meets it — so "is Picasso
 * inside its latency budget" has an answer that can be computed rather than
 * argued.
 *
 * The evidence field is the part worth arguing about, and it is deliberately
 * unflattering. Most of these rows have nothing behind them in this repo, for
 * reasons that are structural rather than lazy: there is no ClickHouse here, no
 * DuckDB, and no models at all, so six of the fourteen budgets cannot be
 * measured by any amount of care. Recording that as `unmeasured` with the
 * reason, rather than leaving the row silent, is the difference between a
 * checklist that reports 8/14 and one that reports nothing and implies 14/14.
 *
 * Two rows are measured and **missed**, and they stay recorded as missed. A
 * table where every row passes is a table whose thresholds were chosen after
 * the measurements.
 */

/** One row of PRD 7.1. */
export interface LatencyBudget {
  /** The interaction, in the PRD's own words. */
  interaction: string;
  p50Ms: number;
  p95Ms: number;
  /** The hard ceiling. Absent where the PRD gives a behaviour instead. */
  ceilingMs?: number;
  /** What the PRD says happens at the ceiling, when it is not a number. */
  ceilingNote?: string;
}

export type Evidence =
  | {
      kind: 'measured';
      p50Ms?: number;
      p95Ms?: number;
      /** The harness that produced it. */
      where: string;
      /** What the number does not cover. Required, because every one has one. */
      caveat: string;
    }
  | {
      kind: 'unmeasured';
      /** Why not. "Not yet" is not a reason; naming what is missing is. */
      because: string;
    };

export interface BudgetedInteraction extends LatencyBudget {
  evidence: Evidence;
}

/**
 * PRD 7.1, verbatim, in order.
 *
 * Milliseconds throughout, including where the PRD writes seconds, so the rows
 * are comparable and nothing has to remember a unit.
 */
export const LATENCY_BUDGETS: readonly BudgetedInteraction[] = [
  {
    interaction: 'Pan / zoom frame',
    p50Ms: 8,
    p95Ms: 16,
    ceilingMs: 33,
    ceilingNote: 'drop to LOD0 rather than exceed',
    evidence: {
      kind: 'measured',
      p50Ms: 7.1,
      p95Ms: 18.8,
      where: 'canvas-gl, apps/canvas-demo/scripts/gl-shots.mjs, 5,000 nodes on screen',
      caveat:
        'headless Chromium on SwiftShader, a CPU rasterizer. The p50 is inside the budget and the p95 is not; on a real GPU the fill-rate half should improve by a wide margin, but that is an inference and this row is recorded as missed until somebody measures it on hardware.',
    },
  },
  {
    interaction: 'Node drag with 20 downstream nodes',
    p50Ms: 16,
    p95Ms: 40,
    ceilingNote: 'recompute deferred to drag-end',
    evidence: {
      kind: 'unmeasured',
      because:
        'there is no interactive drag harness; the scheduler and the deferral are unit-tested in canvas-core, but the frame cost of dragging with a live downstream graph has not been timed.',
    },
  },
  {
    interaction: 'Live tick to tile repaint',
    p50Ms: 90,
    p95Ms: 220,
    ceilingMs: 500,
    evidence: {
      kind: 'unmeasured',
      because: 'no market data feed and no tile service in this repo; there is no tick to time from.',
    },
  },
  {
    interaction: 'Chart interaction (crosshair, range select)',
    p50Ms: 12,
    p95Ms: 30,
    ceilingMs: 60,
    evidence: {
      kind: 'unmeasured',
      because:
        'chart nodes render through the scene assembler, which is measured, but crosshair and range-select are interaction handlers that do not exist yet.',
    },
  },
  {
    interaction: 'Local DuckDB query, 5M rows',
    p50Ms: 60,
    p95Ms: 180,
    ceilingMs: 1_000,
    evidence: {
      kind: 'unmeasured',
      because: 'DuckDB-WASM is not wired up; canvas-data holds the bitemporal semantics, not the engine.',
    },
  },
  {
    interaction: 'Server table query, ClickHouse',
    p50Ms: 120,
    p95Ms: 400,
    ceilingMs: 2_000,
    evidence: {
      kind: 'unmeasured',
      because:
        'there is no ClickHouse and no server; canvas-data models point-in-time reads and entitlements, not the store underneath them.',
    },
  },
  {
    interaction: 'Options book reprice, 40 legs x 375 grid cells',
    p50Ms: 40,
    p95Ms: 90,
    ceilingMs: 300,
    evidence: {
      kind: 'measured',
      p50Ms: 55.9,
      p95Ms: 171.7,
      where: 'canvas-pricing, 40 American legs across a 25x15 grid in Chromium',
      caveat:
        'quality-dependent, and the figure recorded is the one that misses. At `draft` the book reprices in 55.9ms and at `standard` in 171.7ms, because American legs go through Andersen-Lake rather than a closed form — two hundred and seventy times more accurate at four times the cost. The canvas drags at draft and settles at standard, so the budget is met while the analyst is moving and missed when they stop. Recording the draft number alone would be choosing the measurement that passes. 40 European legs reprice in 2.3ms.',
    },
  },
  {
    interaction: 'Ink stroke to screen',
    p50Ms: 6,
    p95Ms: 12,
    ceilingMs: 20,
    ceilingNote: 'this is the one users feel most',
    evidence: {
      kind: 'measured',
      p50Ms: 0.1,
      p95Ms: 0.2,
      where: 'canvas-ink + canvas-gl, apps/canvas-demo/scripts/inkgl-shots.mjs, 600 pointer events',
      caveat:
        'covers tessellation, upload, the draw call and gl.finish(); does not cover the browser delivering the pointer event or the compositor presenting the frame, neither of which is reachable from script. A floor on ink-to-screen and a ceiling on the part this code wrote. SwiftShader again, which makes the rasterization half pessimistic.',
    },
  },
  {
    interaction: 'Ink recognition (shape)',
    p50Ms: 40,
    p95Ms: 90,
    ceilingMs: 200,
    evidence: {
      kind: 'measured',
      p95Ms: 1,
      where: 'canvas-ink, the recognizer over the synthetic stroke set',
      caveat:
        'well under 1ms per stroke, measured under Node rather than in a browser. The budget exists for a model-based recognizer; this one is geometric and offline by design (Appendix C.1), which is why it is two orders of magnitude inside it.',
    },
  },
  {
    interaction: 'Local model intent classify',
    p50Ms: 45,
    p95Ms: 120,
    ceilingMs: 300,
    evidence: {
      kind: 'unmeasured',
      because:
        'no on-device model. The intent classifier is the one place the PRD puts a model on the critical path of a keystroke, and every agent in this repo is a supplied function.',
    },
  },
  {
    interaction: 'Open-weight 32B completion',
    p50Ms: 700,
    p95Ms: 2_400,
    ceilingMs: 8_000,
    evidence: {
      kind: 'unmeasured',
      because:
        'no weights and no inference server. canvas-router chooses a model and enforces the budget it was given; nothing in this repo runs one, so there is no completion to time.',
    },
  },
  {
    interaction: 'Frontier deep read',
    p50Ms: 8_000,
    p95Ms: 25_000,
    ceilingMs: 60_000,
    ceilingNote: 'stream partial',
    evidence: {
      kind: 'unmeasured',
      because:
        'no vendor endpoint is called from here, and the streaming behaviour the ceiling refers to is a transport concern that does not exist yet.',
    },
  },
  {
    interaction: 'Monte Carlo 100k x 252 x 40',
    p50Ms: 4_500,
    p95Ms: 9_000,
    ceilingMs: 30_000,
    evidence: {
      kind: 'unmeasured',
      because:
        'the Monte Carlo path in the Rust core is correctness-tested against closed forms but has never been run at the PRD’s shape — 100,000 paths, 252 steps, 40 assets — and timed.',
    },
  },
  {
    interaction: 'Full Deep Inquiry, high rigor',
    p50Ms: 35_000,
    p95Ms: 70_000,
    ceilingMs: 180_000,
    evidence: {
      kind: 'unmeasured',
      because:
        'the plan is assembled, routed and executed end to end in canvas-integration, but every step is a supplied function returning instantly, so the elapsed time measures the plumbing rather than the inquiry.',
    },
  },
];

export type BudgetStatus = 'met' | 'missed' | 'unmeasured';

export interface BudgetRow {
  interaction: string;
  p50Ms: number;
  p95Ms: number;
  ceilingMs?: number;
  status: BudgetStatus;
  observedP50Ms?: number;
  observedP95Ms?: number;
  /** The harness, or the reason there is none. */
  note: string;
}

export interface LatencyReport {
  rows: BudgetRow[];
  budgets: number;
  measured: number;
  met: number;
  missed: number;
  unmeasured: number;
}

/**
 * The table with its status resolved.
 *
 * A row is `met` only when it was measured *and* the p95 is inside the budget.
 * An unmeasured row is never `met`: the whole reason for the third state is
 * that a missing measurement and a passing one are different, and collapsing
 * them is how a coverage number becomes a ceiling on what anyone will look at.
 */
export function latencyReport(
  budgets: readonly BudgetedInteraction[] = LATENCY_BUDGETS,
): LatencyReport {
  const rows = budgets.map((budget): BudgetRow => {
    if (budget.evidence.kind === 'unmeasured') {
      return {
        interaction: budget.interaction,
        p50Ms: budget.p50Ms,
        p95Ms: budget.p95Ms,
        ...(budget.ceilingMs !== undefined ? { ceilingMs: budget.ceilingMs } : {}),
        status: 'unmeasured',
        note: budget.evidence.because,
      };
    }
    const observed = budget.evidence.p95Ms;
    const status: BudgetStatus = observed === undefined || observed <= budget.p95Ms ? 'met' : 'missed';
    return {
      interaction: budget.interaction,
      p50Ms: budget.p50Ms,
      p95Ms: budget.p95Ms,
      ...(budget.ceilingMs !== undefined ? { ceilingMs: budget.ceilingMs } : {}),
      status,
      ...(budget.evidence.p50Ms !== undefined ? { observedP50Ms: budget.evidence.p50Ms } : {}),
      ...(observed !== undefined ? { observedP95Ms: observed } : {}),
      note: budget.evidence.where,
    };
  });

  return {
    rows,
    budgets: rows.length,
    measured: rows.filter((r) => r.status !== 'unmeasured').length,
    met: rows.filter((r) => r.status === 'met').length,
    missed: rows.filter((r) => r.status === 'missed').length,
    unmeasured: rows.filter((r) => r.status === 'unmeasured').length,
  };
}

export interface ObservedLatency {
  p50Ms: number;
  p95Ms: number;
  /** The single worst sample, when the caller has it. */
  maxMs?: number;
}

export interface BudgetVerdict {
  interaction: string;
  p50: 'met' | 'missed';
  p95: 'met' | 'missed';
  /** Absent when the row has no numeric ceiling, or the caller reported no maximum. */
  ceiling?: 'met' | 'exceeded';
  /** True when anything is outside budget. */
  breached: boolean;
}

export class UnknownInteraction extends Error {
  constructor(interaction: string) {
    super(`${interaction} is not a row in PRD 7.1`);
    this.name = 'UnknownInteraction';
  }
}

/**
 * Check an observed distribution against its row.
 *
 * Throws on an interaction that is not in the table rather than passing it.
 * A monitor that silently accepts an interaction name nobody budgeted reports
 * green for something that was never checked, which is worse than reporting
 * nothing — and a typo in a metric name is how that happens in practice.
 */
export function checkLatency(
  interaction: string,
  observed: ObservedLatency,
  budgets: readonly LatencyBudget[] = LATENCY_BUDGETS,
): BudgetVerdict {
  const budget = budgets.find((b) => b.interaction === interaction);
  if (!budget) throw new UnknownInteraction(interaction);

  const p50 = observed.p50Ms <= budget.p50Ms ? 'met' : 'missed';
  const p95 = observed.p95Ms <= budget.p95Ms ? 'met' : 'missed';
  const ceiling =
    budget.ceilingMs === undefined || observed.maxMs === undefined
      ? undefined
      : observed.maxMs <= budget.ceilingMs
        ? 'met'
        : 'exceeded';

  return {
    interaction,
    p50,
    p95,
    ...(ceiling ? { ceiling } : {}),
    breached: p50 === 'missed' || p95 === 'missed' || ceiling === 'exceeded',
  };
}
