import { describe, expect, it } from 'vitest';
import {
  CANARY_SHARE,
  MIN_BASELINE_DAYS,
  PROMOTION_REGRESSION_LIMIT,
  ROLLBACK_SIGMA,
  SLOS,
  kindReports,
  percentile,
  promotionCheck,
  rollbackCheck,
  sloStatus,
  type DailyVerification,
} from '../src/slo.js';

/** SplitMix32, so the measurements below repeat exactly. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4_294_967_296;
  };
}

function binomial(next: () => number, n: number, p: number): number {
  let count = 0;
  for (let i = 0; i < n; i += 1) if (next() < p) count += 1;
  return count;
}

function days(next: () => number, count: number, n: number, p: number): DailyVerification[] {
  return Array.from({ length: count }, () => ({ verified: n, failures: binomial(next, n, p) }));
}

describe('the SLOs', () => {
  it('are the three the PRD names', () => {
    expect(SLOS.map((s) => [s.name, s.objective])).toEqual([
      ['canvas.load_edit', 0.999],
      ['data.realtime', 0.995],
      ['ai.inference', 0.99],
    ]);
  });

  it('report burn against the allowed failures, not against the total', () => {
    const status = sloStatus(SLOS[2]!, 10_000, 50);
    expect(status.observed).toBeCloseTo(0.995, 6);
    expect(status.budgetBurn).toBeCloseTo(0.5, 6);
    expect(status.breached).toBe(false);
  });

  it('call it breached when the objective is missed', () => {
    expect(sloStatus(SLOS[0]!, 10_000, 20).breached).toBe(true);
  });

  // Dividing by zero here would report a fresh deployment as breached before
  // it served a request.
  it('do not report a deployment with no traffic as breached', () => {
    const status = sloStatus(SLOS[0]!, 0, 0);
    expect(status.breached).toBe(false);
    expect(status.budgetBurn).toBe(0);
  });
});

describe('per-node-kind latency', () => {
  it('pages the owner of the kind that regressed, not a generic on-call', () => {
    const samples = [
      ...Array.from({ length: 100 }, (_, i) => ({ kind: 'BacktestNode', ms: 400 + i * 40, ok: true })),
      ...Array.from({ length: 100 }, () => ({ kind: 'ChartNode', ms: 20, ok: true })),
    ];
    const reports = kindReports(samples, [
      { kind: 'BacktestNode', p95TargetMs: 3000, owner: 'quant-services' },
      { kind: 'ChartNode', p95TargetMs: 100, owner: 'canvas' },
    ]);
    expect(reports[0]?.breached).toBe(true);
    expect(reports[0]?.pages).toBe('quant-services');
    expect(reports[1]?.breached).toBe(false);
    expect(reports[1]?.pages).toBeUndefined();
  });

  it('uses nearest-rank so the p95 is a value that was actually observed', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
});

describe('automatic rollback on a quality regression', () => {
  it('waits for enough history before it can fire at all', () => {
    const decision = rollbackCheck(
      Array.from({ length: 5 }, () => ({ verified: 200, failures: 10 })),
      { verified: 200, failures: 120 },
    );
    expect(decision.rollback).toBe(false);
    expect(decision.reason).toContain(`${MIN_BASELINE_DAYS}`);
  });

  // The naive reading of the rule fires here: the sample standard deviation of
  // thirty zeros is zero, so one failure is infinitely many sigma above
  // baseline and the fleet rolls back its best model on one bad answer.
  it('does not roll back a perfect model on its first failure', () => {
    const decision = rollbackCheck(
      Array.from({ length: 30 }, () => ({ verified: 200, failures: 0 })),
      { verified: 200, failures: 1 },
    );
    expect(decision.rollback).toBe(false);
    expect(Number.isFinite(decision.z)).toBe(true);
  });

  it('does roll back a perfect model that suddenly fails a fifth of the time', () => {
    const decision = rollbackCheck(
      Array.from({ length: 30 }, () => ({ verified: 200, failures: 0 })),
      { verified: 200, failures: 40 },
    );
    expect(decision.rollback).toBe(true);
    expect(decision.reason).toContain('sigma above');
  });

  it('rolls back a real regression against a noisy baseline', () => {
    const next = rng(11);
    const decision = rollbackCheck(days(next, 30, 400, 0.05), {
      verified: 400,
      failures: binomial(next, 400, 0.25),
    });
    expect(decision.rollback).toBe(true);
  });

  // The measurement, not an assertion of hope: how often does a model that
  // did not regress get rolled back anyway?
  it('holds the false-rollback rate of a stable model to a usable level', () => {
    const next = rng(2026);
    const trials = 2000;
    let rolled = 0;
    for (let t = 0; t < trials; t += 1) {
      const decision = rollbackCheck(days(next, 30, 400, 0.05), {
        verified: 400,
        failures: binomial(next, 400, 0.05),
      });
      if (decision.rollback) rolled += 1;
    }
    const rate = rolled / trials;
    // eslint-disable-next-line no-console
    console.log(
      `rollback rule: ${(rate * 100).toFixed(2)}% false rollbacks on a stable model over ${trials} trials`,
    );
    expect(rate).toBeLessThan(0.01);
  });

  it('catches a real regression most of the time it happens', () => {
    const next = rng(7);
    const trials = 500;
    let caught = 0;
    for (let t = 0; t < trials; t += 1) {
      const decision = rollbackCheck(days(next, 30, 400, 0.05), {
        verified: 400,
        failures: binomial(next, 400, 0.12),
      });
      if (decision.rollback) caught += 1;
    }
    const power = caught / trials;
    // eslint-disable-next-line no-console
    console.log(
      `rollback rule: catches ${(power * 100).toFixed(0)}% of a 5% -> 12% regression at ${ROLLBACK_SIGMA} sigma`,
    );
    expect(power).toBeGreaterThan(0.5);
  });
});

describe('canary promotion', () => {
  it('blocks on a regression above two percent in any task class', () => {
    const decision = promotionCheck([
      { taskClass: 'doc.extract', incumbentQuality: 0.96, candidateQuality: 0.95 },
      { taskClass: 'sql.generate', incumbentQuality: 0.94, candidateQuality: 0.9 },
    ]);
    expect(decision.promote).toBe(false);
    expect(decision.blockedBy.map((b) => b.taskClass)).toEqual(['sql.generate']);
  });

  it('promotes when every class is within the limit', () => {
    expect(
      promotionCheck([{ taskClass: 'doc.extract', incumbentQuality: 0.96, candidateQuality: 0.95 }])
        .promote,
    ).toBe(true);
  });

  it('keeps the PRD\'s shadow share and limit', () => {
    expect(CANARY_SHARE).toBe(0.05);
    expect(PROMOTION_REGRESSION_LIMIT).toBe(0.02);
  });
});
