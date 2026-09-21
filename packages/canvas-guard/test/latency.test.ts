import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUDGETS,
  UnknownInteraction,
  checkLatency,
  latencyReport,
  type BudgetedInteraction,
} from '../src/latency.js';

describe('the budget table', () => {
  it('carries all fourteen rows of PRD 7.1', () => {
    expect(LATENCY_BUDGETS.length).toBe(14);
    expect(new Set(LATENCY_BUDGETS.map((b) => b.interaction)).size).toBe(14);
  });

  it('is ordered p50 <= p95 <= ceiling in every row', () => {
    for (const budget of LATENCY_BUDGETS) {
      expect(budget.p50Ms, budget.interaction).toBeLessThanOrEqual(budget.p95Ms);
      if (budget.ceilingMs !== undefined) {
        expect(budget.p95Ms, budget.interaction).toBeLessThanOrEqual(budget.ceilingMs);
      }
    }
  });

  // The evidence field is the point of the table, so it is checked rather than
  // trusted: a measured row must name its harness and what it does not cover,
  // and an unmeasured row must say what is missing.
  it('makes every row account for itself', () => {
    for (const budget of LATENCY_BUDGETS) {
      if (budget.evidence.kind === 'measured') {
        expect(budget.evidence.where.length, budget.interaction).toBeGreaterThan(10);
        expect(budget.evidence.caveat.length, budget.interaction).toBeGreaterThan(20);
        expect(
          budget.evidence.p50Ms ?? budget.evidence.p95Ms,
          budget.interaction,
        ).toBeTypeOf('number');
      } else {
        expect(budget.evidence.because.length, budget.interaction).toBeGreaterThan(20);
      }
    }
  });
});

describe('the report', () => {
  const report = latencyReport();

  it('counts the three states separately', () => {
    expect(report.budgets).toBe(14);
    expect(report.met + report.missed + report.unmeasured).toBe(14);
    expect(report.measured).toBe(report.met + report.missed);
  });

  // The figure this repo actually stands behind. It is written here so a change
  // to it has to be deliberate: closing a gap moves this line, and so does
  // quietly downgrading a missed row to unmeasured.
  it('stands at 7 measured, 4 met, 3 missed, 7 unmeasured', () => {
    expect(report.measured).toBe(7);
    expect(report.met).toBe(4);
    expect(report.missed).toBe(3);
    expect(report.unmeasured).toBe(7);
  });

  it('names the three that are missed', () => {
    expect(report.rows.filter((r) => r.status === 'missed').map((r) => r.interaction)).toEqual([
      'Pan / zoom frame',
      'Options book reprice, 40 legs x 375 grid cells',
      'Monte Carlo 100k x 252 x 40',
    ]);
  });

  // An unmeasured row is never `met`. Collapsing the two is how a coverage
  // number becomes a ceiling on what anyone will look at.
  it('never reports an unmeasured row as met', () => {
    for (const row of report.rows) {
      if (row.status === 'unmeasured') {
        expect(row.observedP95Ms, row.interaction).toBeUndefined();
      }
    }
  });

  it('marks a row missed when the observed p95 is outside the budget', () => {
    const fabricated: BudgetedInteraction[] = [
      {
        interaction: 'x',
        p50Ms: 10,
        p95Ms: 20,
        evidence: { kind: 'measured', p95Ms: 21, where: 'a harness somewhere', caveat: 'a caveat of sufficient length' },
      },
      {
        interaction: 'y',
        p50Ms: 10,
        p95Ms: 20,
        evidence: { kind: 'measured', p95Ms: 20, where: 'a harness somewhere', caveat: 'a caveat of sufficient length' },
      },
    ];
    const got = latencyReport(fabricated);
    expect(got.rows.map((r) => r.status)).toEqual(['missed', 'met']);
  });
});

describe('checking an observed distribution', () => {
  const ink = 'Ink stroke to screen';

  it('passes a distribution inside all three thresholds', () => {
    expect(checkLatency(ink, { p50Ms: 0.1, p95Ms: 0.2, maxMs: 1.9 })).toEqual({
      interaction: ink,
      p50: 'met',
      p95: 'met',
      ceiling: 'met',
      breached: false,
    });
  });

  it('breaches on the p95 alone', () => {
    const verdict = checkLatency(ink, { p50Ms: 5, p95Ms: 13 });
    expect(verdict.p50).toBe('met');
    expect(verdict.p95).toBe('missed');
    expect(verdict.breached).toBe(true);
  });

  it('breaches on a single sample past the ceiling', () => {
    const verdict = checkLatency(ink, { p50Ms: 1, p95Ms: 2, maxMs: 21 });
    expect(verdict.p95).toBe('met');
    expect(verdict.ceiling).toBe('exceeded');
    expect(verdict.breached).toBe(true);
  });

  it('treats the threshold as inclusive', () => {
    expect(checkLatency(ink, { p50Ms: 6, p95Ms: 12, maxMs: 20 }).breached).toBe(false);
  });

  it('reports no ceiling verdict where the PRD gives a behaviour instead', () => {
    const verdict = checkLatency('Node drag with 20 downstream nodes', {
      p50Ms: 1,
      p95Ms: 2,
      maxMs: 9_999,
    });
    expect(verdict.ceiling).toBeUndefined();
    expect(verdict.breached).toBe(false);
  });

  // A monitor that accepts a name nobody budgeted reports green for something
  // that was never checked, and a typo in a metric name is how that happens.
  it('refuses an interaction that is not in the table', () => {
    expect(() => checkLatency('Pan/zoom frame', { p50Ms: 1, p95Ms: 2 })).toThrow(UnknownInteraction);
  });
});
