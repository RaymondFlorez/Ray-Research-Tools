import { describe, expect, it } from 'vitest';
import {
  CANARY_SHARE,
  MIN_SHADOW_PER_CLASS,
  PromotionBlocked,
  REGRESSION_LIMIT,
  assertPromotable,
  compareCanary,
  inShadow,
  shadow,
  type CanaryPlan,
  type ShadowRecord,
} from '../src/canary.js';
import type { TaskClass } from '../src/policy.js';

const plan: CanaryPlan = { modelId: 'frontier-a', incumbent: 'v3', candidate: 'v4' };

describe('the shadow sample', () => {
  it('takes five percent of traffic', () => {
    // 20,000 requests; the binomial standard deviation at p=0.05 is 0.0015, so
    // three of them is 0.0046. Deterministic, so this is a fixed number rather
    // than a flake waiting for a bad seed.
    const n = 20_000;
    let sampled = 0;
    for (let i = 0; i < n; i++) if (inShadow(plan, `req-${i}`)) sampled += 1;
    expect(Math.abs(sampled / n - CANARY_SHARE)).toBeLessThan(0.0046);
    // The figure the README quotes. Pinned rather than bounded because the
    // sample is derived: this is the same 1,039 requests on every run, and a
    // change to the hash or the mapping should have to be noticed.
    expect(sampled).toBe(1039);
  });

  it('is derived, so a replay shadows the same requests', () => {
    // The trace store exists so a dispatch can be replayed. A sample drawn
    // from Math.random() cannot say why a given request was shadowed.
    const ids = Array.from({ length: 500 }, (_, i) => `req-${i}`);
    const first = ids.map((id) => inShadow(plan, id));
    const second = ids.map((id) => inShadow(plan, id));
    expect(second).toEqual(first);
    expect(first.some(Boolean)).toBe(true);
  });

  it('gives a different candidate a different five percent', () => {
    // Keying on the request id alone would evaluate every model version that
    // ever ships against one slice of the product.
    const n = 20_000;
    const other: CanaryPlan = { ...plan, candidate: 'v5' };
    let a = 0;
    let b = 0;
    let both = 0;
    for (let i = 0; i < n; i++) {
      const inA = inShadow(plan, `req-${i}`);
      const inB = inShadow(other, `req-${i}`);
      if (inA) a += 1;
      if (inB) b += 1;
      if (inA && inB) both += 1;
    }
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Independent slices overlap at 0.25 percent of traffic, not at 5.
    expect(both / n).toBeLessThan(0.006);
    expect(both).toBe(50);
  });

  it('honours a share of zero and a share of one exactly', () => {
    expect(inShadow({ ...plan, share: 0 }, 'req-1')).toBe(false);
    expect(inShadow({ ...plan, share: 1 }, 'req-1')).toBe(true);
  });
});

async function dispatch(answer: string, costCents = 0.4, latencyMs = 900) {
  return { answer, costCents, latencyMs };
}

describe('a shadowed dispatch', () => {
  const base = {
    plan: { ...plan, share: 1 },
    requestId: 'req-1',
    taskClass: 'sql.generate' as TaskClass,
    at: 1_770_000_000_000,
    score: (answer: string) => (answer === 'right' ? 1 : 0),
  };

  it('returns the incumbent answer and carries no field for the other one', async () => {
    const out = await shadow({
      ...base,
      live: () => dispatch('right'),
      candidate: () => dispatch('also right'),
    });
    expect(out.answer).toBe('right');
    // "Dispatched, result compared, not shown." There is nowhere to show it
    // from: the record holds scores and costs, never the candidate's output.
    expect(Object.keys(out.record!).sort()).toEqual([
      'at',
      'candidate',
      'candidateScore',
      'incumbent',
      'incumbentScore',
      'modelId',
      'requestId',
      'shadowCostCents',
      'shadowLatencyMs',
      'taskClass',
    ]);
    expect(JSON.stringify(out.record)).not.toContain('also right');
  });

  it('does not dispatch the candidate when the request is not sampled', async () => {
    let candidateCalls = 0;
    const out = await shadow({
      ...base,
      plan: { ...plan, share: 0 },
      live: () => dispatch('right'),
      candidate: () => {
        candidateCalls += 1;
        return dispatch('whatever');
      },
    });
    expect(candidateCalls).toBe(0);
    expect(out.record).toBeUndefined();
    expect(out.answer).toBe('right');
  });

  it('scores a candidate failure zero and never surfaces it', async () => {
    const out = await shadow({
      ...base,
      live: () => dispatch('right'),
      candidate: () => Promise.reject(new Error('candidate timed out')),
    });
    // A model under evaluation cannot fail a request that was not routed to it.
    expect(out.answer).toBe('right');
    expect(out.record!.candidateScore).toBe(0);
    expect(out.record!.candidateError).toContain('timed out');
  });

  it('lets the live dispatch fail as the caller expects', async () => {
    await expect(
      shadow({
        ...base,
        live: () => Promise.reject(new Error('the real one broke')),
        candidate: () => dispatch('right'),
      }),
    ).rejects.toThrow('the real one broke');
  });

  it('records what the shadow cost on top of the request', async () => {
    const out = await shadow({
      ...base,
      live: () => dispatch('right', 0.4, 900),
      candidate: () => dispatch('right', 0.6, 1400),
    });
    expect(out.record!.shadowCostCents).toBe(0.6);
    expect(out.record!.shadowLatencyMs).toBe(1400);
  });
});

function records(
  taskClass: TaskClass,
  count: number,
  incumbentScore: number,
  candidateScore: number,
): ShadowRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    requestId: `${taskClass}-${i}`,
    taskClass,
    modelId: plan.modelId,
    incumbent: plan.incumbent,
    candidate: plan.candidate,
    incumbentScore,
    candidateScore,
    shadowCostCents: 0.5,
    shadowLatencyMs: 1000,
    at: i,
  }));
}

const CLASSES: TaskClass[] = ['sql.generate', 'quant.codegen'];

describe('the promotion gate', () => {
  it('promotes a candidate that holds up on every class', () => {
    const report = compareCanary(
      plan,
      [...records('sql.generate', 40, 0.80, 0.83), ...records('quant.codegen', 40, 0.74, 0.74)],
      CLASSES,
    );
    expect(report.promote).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(() => assertPromotable(report)).not.toThrow();
  });

  it('blocks on one class regressing, however good the average', () => {
    // Up five points on one class, down four on the other: better on
    // aggregate, and exactly the promotion the rule exists to stop.
    const report = compareCanary(
      plan,
      [...records('sql.generate', 40, 0.70, 0.75), ...records('quant.codegen', 40, 0.78, 0.74)],
      CLASSES,
    );
    const mean = (k: 'incumbentMean' | 'candidateMean') =>
      report.byClass.reduce((a, c) => a + c[k], 0) / report.byClass.length;
    expect(mean('candidateMean')).toBeGreaterThan(mean('incumbentMean'));
    expect(report.promote).toBe(false);
    expect(report.blockers.join()).toContain('quant.codegen');
    expect(() => assertPromotable(report)).toThrow(PromotionBlocked);
  });

  it('allows a regression right at the limit and blocks just past it', () => {
    const at = compareCanary(
      plan,
      [
        ...records('sql.generate', 40, 0.80, 0.80 - REGRESSION_LIMIT),
        ...records('quant.codegen', 40, 0.74, 0.74),
      ],
      CLASSES,
    );
    expect(at.promote).toBe(true);
    const past = compareCanary(
      plan,
      [
        ...records('sql.generate', 40, 0.80, 0.80 - REGRESSION_LIMIT - 0.001),
        ...records('quant.codegen', 40, 0.74, 0.74),
      ],
      CLASSES,
    );
    expect(past.promote).toBe(false);
  });

  it('blocks a class the shadow barely covered', () => {
    const report = compareCanary(
      plan,
      [
        ...records('sql.generate', 40, 0.80, 0.90),
        ...records('quant.codegen', MIN_SHADOW_PER_CLASS - 1, 0.74, 0.99),
      ],
      CLASSES,
    );
    // Promotion is the action that needs justifying, so silence blocks it.
    expect(report.promote).toBe(false);
    expect(report.blockers.join()).toContain('fewer than');
  });

  it('blocks a class the candidate was never asked to do at all', () => {
    const report = compareCanary(plan, records('sql.generate', 40, 0.80, 0.90), CLASSES);
    expect(report.promote).toBe(false);
    expect(report.byClass.find((c) => c.taskClass === 'quant.codegen')!.dispatches).toBe(0);
  });

  it('ignores records from another candidate', () => {
    const stale = records('quant.codegen', 40, 0.74, 0.99).map((r) => ({ ...r, candidate: 'v2' }));
    const report = compareCanary(
      plan,
      [...records('sql.generate', 40, 0.80, 0.83), ...stale],
      CLASSES,
    );
    expect(report.promote).toBe(false);
    expect(report.dispatches).toBe(40);
  });

  it('reports the bill', () => {
    const report = compareCanary(
      plan,
      [...records('sql.generate', 40, 0.8, 0.8), ...records('quant.codegen', 40, 0.8, 0.8)],
      CLASSES,
    );
    expect(report.shadowCostCents).toBeCloseTo(40, 6);
  });

  it('counts the candidate failures separately from the score they produced', () => {
    const failed = records('quant.codegen', 40, 0.9, 0).map((r, i) =>
      i < 5 ? { ...r, candidateError: 'timed out' } : r,
    );
    const report = compareCanary(plan, [...records('sql.generate', 40, 0.8, 0.8), ...failed], CLASSES);
    const codegen = report.byClass.find((c) => c.taskClass === 'quant.codegen')!;
    expect(codegen.candidateErrors).toBe(5);
    expect(report.promote).toBe(false);
  });
});
