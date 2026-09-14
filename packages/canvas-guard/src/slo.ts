/**
 * SLOs and model-quality monitoring (PRD 7.5).
 *
 * "SLOs: 99.9 percent availability for canvas load and edit, 99.5 percent for
 * real-time data, 99 percent for AI inference with defined degradation."
 *
 * "Model quality monitoring: verification failure rate per model per task
 * class, tracked daily, with automatic rollback if a model's verification
 * failure rate rises above its trailing 30-day baseline by more than 3
 * standard deviations."
 *
 * The rollback rule is the part that needs care, because the naive reading of
 * it fires constantly. Take a model that verified perfectly for thirty days:
 * the sample standard deviation of thirty zeros is zero, so *any* failure on
 * day thirty-one is infinitely many standard deviations above baseline, and
 * the fleet rolls back its best model on one bad answer.
 *
 * The fix is to remember that a daily rate is a binomial estimate and carries
 * sampling noise even when every draw came out the same. The standard
 * deviation used here is the larger of the observed one and the binomial floor
 * `sqrt(p(1-p)/n)` — with `p` itself floored at `1/n`, so thirty perfect days
 * imply "we have not yet seen a failure in this many draws", not "failures are
 * impossible". `test/slo.test.ts` measures the false-rollback rate of a stable
 * model under this rule rather than asserting it is low.
 */

export interface SloTarget {
  name: string;
  /** Fraction of successful requests required. */
  objective: number;
  window: '30d';
}

export const SLOS: readonly SloTarget[] = [
  { name: 'canvas.load_edit', objective: 0.999, window: '30d' },
  { name: 'data.realtime', objective: 0.995, window: '30d' },
  { name: 'ai.inference', objective: 0.99, window: '30d' },
];

export interface SloStatus {
  name: string;
  objective: number;
  observed: number;
  /** Fraction of the allowed failures already spent. Over 1 means the SLO is missed. */
  budgetBurn: number;
  breached: boolean;
}

export function sloStatus(target: SloTarget, total: number, failures: number): SloStatus {
  const observed = total === 0 ? 1 : (total - failures) / total;
  const allowed = total * (1 - target.objective);
  // With no traffic there is no budget and no burn. Dividing by zero here
  // would report a fresh deployment as breached before it served a request.
  const budgetBurn = allowed === 0 ? (failures > 0 ? Number.POSITIVE_INFINITY : 0) : failures / allowed;
  return {
    name: target.name,
    objective: target.objective,
    observed,
    budgetBurn,
    breached: observed < target.objective,
  };
}

// ---------------------------------------------------------------------------
// Per-node-kind latency
// ---------------------------------------------------------------------------

/**
 * "Per-node-kind latency and error-rate dashboards; a regression in
 * `BacktestNode` p95 pages the quant services owner, not a generic on-call."
 *
 * The owner is part of the data, not a lookup somewhere else, because the
 * whole point of the sentence is that the page reaches a person who can fix a
 * backtest.
 */
export interface NodeKindSlo {
  kind: string;
  p95TargetMs: number;
  owner: string;
}

export interface LatencySample {
  kind: string;
  ms: number;
  ok: boolean;
}

export interface KindReport {
  kind: string;
  count: number;
  p95Ms: number;
  errorRate: number;
  breached: boolean;
  pages?: string;
}

/** Nearest-rank p95: the smallest observed value at or above the 95th percentile. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export function kindReports(
  samples: readonly LatencySample[],
  targets: readonly NodeKindSlo[],
): KindReport[] {
  const byKind = new Map<string, LatencySample[]>();
  for (const sample of samples) {
    byKind.set(sample.kind, [...(byKind.get(sample.kind) ?? []), sample]);
  }
  return targets.map((target) => {
    const rows = byKind.get(target.kind) ?? [];
    const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
    const p95Ms = percentile(sorted, 0.95);
    const errorRate = rows.length === 0 ? 0 : rows.filter((r) => !r.ok).length / rows.length;
    const breached = rows.length > 0 && p95Ms > target.p95TargetMs;
    return {
      kind: target.kind,
      count: rows.length,
      p95Ms,
      errorRate,
      breached,
      ...(breached ? { pages: target.owner } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Model quality monitoring and automatic rollback
// ---------------------------------------------------------------------------

export interface DailyVerification {
  /** Dispatches that ran a verifier. */
  verified: number;
  failures: number;
}

export interface RollbackDecision {
  rollback: boolean;
  baseline: number;
  sigma: number;
  today: number;
  /** How many standard deviations above baseline today sits. */
  z: number;
  reason: string;
}

/** The PRD's trigger. */
export const ROLLBACK_SIGMA = 3;

/** Days of history before the rule is allowed to fire at all. */
export const MIN_BASELINE_DAYS = 14;

export function rollbackCheck(
  trailing: readonly DailyVerification[],
  today: DailyVerification,
): RollbackDecision {
  const usable = trailing.filter((d) => d.verified > 0);
  const rates = usable.map((d) => d.failures / d.verified);
  const todayRate = today.verified === 0 ? 0 : today.failures / today.verified;

  if (usable.length < MIN_BASELINE_DAYS || today.verified === 0) {
    return {
      rollback: false,
      baseline: mean(rates),
      sigma: Number.NaN,
      today: todayRate,
      z: Number.NaN,
      reason: `not enough history: ${usable.length} of ${MIN_BASELINE_DAYS} days`,
    };
  }

  const baseline = mean(rates);
  const observedSigma = standardDeviation(rates, baseline);

  // A daily rate is a binomial estimate. Thirty identical days do not mean the
  // underlying rate has no variance; they mean the sample is too small to have
  // shown it yet. `p` is floored at one failure in today's sample so a
  // perfect baseline implies "not seen yet", not "impossible".
  const p = Math.max(baseline, 1 / today.verified);
  const binomialFloor = Math.sqrt((p * (1 - p)) / today.verified);
  const sigma = Math.max(observedSigma, binomialFloor);

  const z = (todayRate - baseline) / sigma;
  const rollback = z > ROLLBACK_SIGMA;
  return {
    rollback,
    baseline,
    sigma,
    today: todayRate,
    z,
    reason: rollback
      ? `verification failure rate ${(todayRate * 100).toFixed(1)}% is ${z.toFixed(1)} sigma above the ${(baseline * 100).toFixed(1)}% baseline`
      : `within ${ROLLBACK_SIGMA} sigma of baseline`,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function standardDeviation(values: readonly number[], m: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

/**
 * "New model versions take 5 percent of traffic in shadow (dispatched, result
 * compared, not shown) before promotion. Regression on any task class above 2
 * percent blocks the promotion."
 */
export const CANARY_SHARE = 0.05;
export const PROMOTION_REGRESSION_LIMIT = 0.02;

export interface CanaryResult {
  taskClass: string;
  incumbentQuality: number;
  candidateQuality: number;
}

export interface PromotionDecision {
  promote: boolean;
  blockedBy: Array<{ taskClass: string; regression: number }>;
}

export function promotionCheck(results: readonly CanaryResult[]): PromotionDecision {
  const blockedBy = results
    .map((r) => ({ taskClass: r.taskClass, regression: r.incumbentQuality - r.candidateQuality }))
    .filter((r) => r.regression > PROMOTION_REGRESSION_LIMIT);
  return { promote: blockedBy.length === 0, blockedBy };
}
