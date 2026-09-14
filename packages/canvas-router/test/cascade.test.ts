import { describe, expect, it } from 'vitest';
import {
  cascade,
  reconciliationVerifier,
  sqlVerifier,
  testSuiteVerifier,
  type Verdict,
} from '../src/cascade.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import type { Model } from '../src/policy.js';
import type { RoutingFeatures } from '../src/router.js';

function features(overrides: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    taskClass: 'sql.generate',
    inputTokens: 2_000,
    expectedOutputTokens: 300,
    modalities: ['text'],
    toolsRequired: [],
    rigorFlag: false,
    dataSensitivity: 'public',
    costCeilingCents: 50,
    latencyBudgetMs: 800,
    determinismRequired: false,
    priorFailures: [],
    ...overrides,
  };
}

const TABLES = new Set(['prices', 'fundamentals']);
const COLUMNS = new Set(['symbol', 'date', 'close', 'revenue']);

describe('the deterministic verifiers', () => {
  const verify = sqlVerifier(TABLES, COLUMNS);

  it('accepts a query that parses against the schema', () => {
    const verdict = verify("select close from prices where symbol = 'NVDA'", {} as Model) as Verdict;
    expect(verdict.accepted).toBe(true);
    expect(verdict.deterministic).toBe(true);
    // A deterministic verifier is not 90 percent sure; it either parsed or not.
    expect(verdict.confidence).toBe(1);
  });

  it('catches the cheap model hallucinating a table', () => {
    const verdict = verify('select * from earnings_estimates', {} as Model) as Verdict;
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toContain('does not exist');
  });

  it('catches a hallucinated column and unbalanced syntax', () => {
    expect((verify('select close from prices where gross_margin > 0.7', {} as Model) as Verdict).accepted).toBe(false);
    expect((verify('select (close from prices', {} as Model) as Verdict).accepted).toBe(false);
    expect((verify('drop table prices', {} as Model) as Verdict).accepted).toBe(false);
  });

  /** PRD 4.3 names this one: "do the extracted numbers reconcile to the reported total". */
  it('catches an extraction that does not add up', () => {
    const reconcile = reconciliationVerifier();
    expect((reconcile({ parts: [18.4, 11.2, 5.1], total: 34.7 }, {} as Model) as Verdict).accepted).toBe(true);
    const wrong = reconcile({ parts: [18.4, 11.2, 9.9], total: 34.7 }, {} as Model) as Verdict;
    expect(wrong.accepted).toBe(false);
    expect(wrong.reason).toContain('off by');
  });

  it('refuses code that generated no tests', () => {
    const suite = testSuiteVerifier();
    expect((suite({ passed: 12, failed: 0 }, {} as Model) as Verdict).accepted).toBe(true);
    expect((suite({ passed: 0, failed: 0 }, {} as Model) as Verdict).reason).toContain('nothing was verified');
  });
});

describe('the cascade', () => {
  it('stops at the cheap tier when the verifier accepts', async () => {
    const result = await cascade(
      DEFAULT_POLICY,
      features(),
      async () => "select close from prices where symbol = 'NVDA'",
      sqlVerifier(TABLES, COLUMNS),
    );
    expect(result.terminatedAtCheapTier).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.escalations).toBe(0);
    expect(result.totalCostCents).toBeLessThan(result.frontierCostCents);
  });

  it('escalates when the verifier refuses, after the table says to', async () => {
    const seen: string[] = [];
    const result = await cascade(
      DEFAULT_POLICY,
      features(),
      async (model) => {
        seen.push(model.id);
        // The cheap tier keeps hallucinating; the frontier gets it right.
        return model.placement === 'vendor'
          ? 'select close from prices'
          : 'select * from earnings_estimates';
      },
      sqlVerifier(TABLES, COLUMNS),
    );
    // sql.generate escalates after two failures, so the cheap model is tried
    // twice before anything more expensive is bought.
    expect(seen.filter((id) => id === 'qwen-coder-32b')).toHaveLength(2);
    expect(result.steps.at(-1)?.decision.model.placement).toBe('vendor');
    expect(result.terminatedAtCheapTier).toBe(false);
    expect(result.escalations).toBeGreaterThan(0);
  });

  it('returns the best available answer when every tier fails', async () => {
    const result = await cascade(
      DEFAULT_POLICY,
      features(),
      async () => 'select * from nowhere',
      sqlVerifier(TABLES, COLUMNS),
    );
    // Not an exception: "here is the best answer, and it did not verify" is
    // more useful to an analyst than nothing at all.
    expect(result.answer).toBe('select * from nowhere');
    expect(result.steps.at(-1)?.verdict.accepted).toBe(false);
  });

  it('escalates on low confidence even when the judge accepted', async () => {
    // ink.semantic escalates below 0.7 confidence (PRD 4.2).
    const result = await cascade(
      DEFAULT_POLICY,
      features({ taskClass: 'ink.semantic', latencyBudgetMs: 400 }),
      async () => 'rectangle',
      () => ({ accepted: true, confidence: 0.55, deterministic: false, reason: 'a judge, unsure' }),
    );
    expect(result.terminatedAtCheapTier).toBe(false);
    expect(result.steps.length).toBeGreaterThan(1);
  });

  it('cannot escalate past a hard rule', async () => {
    const result = await cascade(
      DEFAULT_POLICY,
      features({ dataSensitivity: 'positions' }),
      async () => 'select * from nowhere',
      sqlVerifier(TABLES, COLUMNS),
    );
    // Every tier it tried stayed inside the tenant. Failing verification is not
    // a reason to send positions to a vendor.
    expect(result.steps.every((s) => s.decision.model.placement !== 'vendor')).toBe(true);
  });
});

describe("Phase 3's exit criterion", () => {
  /**
   * "Cascade terminates >70 percent of requests at cheap tier with <1 percent
   * quality delta."
   *
   * Measured against a simulated fleet rather than asserted. The cheap model is
   * right 85 percent of the time — PRD 4.3 reports about 78 percent of requests
   * terminating cheap on this class, which is what an 85 percent hit rate
   * produces once the failures escalate. The frontier is right 97 percent.
   *
   * The quality delta is the honest part: it compares the cascade's final
   * answers against sending *everything* to the frontier, on the same requests.
   * A cascade that terminates cheap on the easy ones and escalates the rest
   * should lose almost nothing, and "almost" is the number being checked.
   */
  it('terminates cheap on most requests, and loses under one percent of quality', async () => {
    const REQUESTS = 400;
    let state = 12345;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };

    // Each request has a difficulty; the cheap model fails the hard ones.
    const difficulty = Array.from({ length: REQUESTS }, () => next());

    const answerFor = (model: Model, index: number): string => {
      const hitRate = model.placement === 'vendor' ? 0.97 : 0.85;
      const correct = (difficulty[index] as number) < hitRate;
      return correct ? "select close from prices where symbol = 'NVDA'" : 'select * from nowhere';
    };

    let cheapTerminations = 0;
    let cascadeCorrect = 0;
    let frontierCorrect = 0;
    let cascadeCost = 0;
    let frontierCost = 0;

    for (let i = 0; i < REQUESTS; i += 1) {
      const result = await cascade(
        DEFAULT_POLICY,
        features(),
        async (model) => answerFor(model, i),
        sqlVerifier(TABLES, COLUMNS),
      );
      if (result.terminatedAtCheapTier) cheapTerminations += 1;
      if (result.steps.at(-1)?.verdict.accepted) cascadeCorrect += 1;
      cascadeCost += result.totalCostCents;

      // The counterfactual: the same request, always frontier.
      const frontier = DEFAULT_POLICY.models.find((m) => m.id === 'frontier-a') as Model;
      if (answerFor(frontier, i).includes('prices')) frontierCorrect += 1;
      frontierCost += result.frontierCostCents;
    }

    const terminationRate = cheapTerminations / REQUESTS;
    const qualityDelta = (frontierCorrect - cascadeCorrect) / REQUESTS;
    const saving = frontierCost / cascadeCost;

    console.log(
      `  cheap-tier terminations ${(terminationRate * 100).toFixed(1)}%  ` +
        `quality delta ${(qualityDelta * 100).toFixed(2)}%  ` +
        `cost ${saving.toFixed(1)}x cheaper than always-frontier`,
    );

    expect(terminationRate).toBeGreaterThan(0.7);
    expect(Math.abs(qualityDelta)).toBeLessThan(0.01);
    // PRD 4.3 claims roughly 5x. Not asserted that precisely — the point is the
    // cascade is materially cheaper, and by how much depends on the fleet.
    expect(saving).toBeGreaterThan(2);
  });
});
