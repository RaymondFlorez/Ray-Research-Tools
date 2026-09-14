import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, modelById, type RoutingPolicy } from '../src/policy.js';
import { NoEligibleModel, route, type RoutingFeatures } from '../src/router.js';

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

describe('hard rules run first and cannot be outvoted', () => {
  /**
   * PRD 4.3: "Portfolio positions and any document flagged as potentially
   * non-public never leave the tenant boundary."
   *
   * The test that matters is not that the router prefers a local model — it is
   * that no score can reach the vendor one. So the policy is bent to make the
   * frontier model overwhelmingly attractive: free, instant, and perfect. It
   * still must not be chosen.
   */
  it('no score sends positions to a vendor, however good the vendor looks', () => {
    const rigged: RoutingPolicy = {
      ...DEFAULT_POLICY,
      models: DEFAULT_POLICY.models.map((m) =>
        m.placement === 'vendor'
          ? {
              ...m,
              centsPerKiloToken: 0,
              latencyMsP50: 1,
              latencyMsP95: 2,
              quality: { ...m.quality, 'sql.generate': 1 },
            }
          : m,
      ),
    };

    for (const sensitivity of ['positions', 'mnpi_risk'] as const) {
      const decision = route(rigged, features({ dataSensitivity: sensitivity }));
      expect(decision.model.placement).not.toBe('vendor');
      expect(decision.candidates.every((c) => c.model.placement !== 'vendor')).toBe(true);
      // And it says which rule removed them, by name.
      expect(
        decision.excluded.some((e) => e.rule.includes(`${sensitivity} data may not reach a vendor model`)),
      ).toBe(true);
      expect(decision.reasons.some((r) => r.includes('inside the tenant boundary'))).toBe(true);
    }
  });

  it('public data may use a vendor model', () => {
    const decision = route(DEFAULT_POLICY, features({ dataSensitivity: 'public', rigorFlag: true }));
    expect(decision.model.placement).toBe('vendor');
  });

  it('determinism excludes anything that cannot be pinned, and records the seed', () => {
    const loose: RoutingPolicy = {
      ...DEFAULT_POLICY,
      models: DEFAULT_POLICY.models.map((m) =>
        m.id === 'qwen-coder-32b' ? { ...m, deterministic: false } : m,
      ),
    };
    const decision = route(loose, features({ determinismRequired: true }), { seed: 4242 });
    expect(decision.model.id).not.toBe('qwen-coder-32b');
    expect(decision.pinned).toEqual({ temperature: 0, seed: 4242 });
    expect(decision.excluded.some((e) => e.modelId === 'qwen-coder-32b')).toBe(true);
  });

  it('an org vendor pin removes everything outside it', () => {
    const decision = route(DEFAULT_POLICY, features(), { allowedVendors: ['open'] });
    expect(decision.model.vendor).toBe('open');
    expect(decision.excluded.some((e) => e.rule.includes("not in the org's allowed set"))).toBe(true);
  });

  it('will not send a request through a context window too small for it', () => {
    const decision = route(DEFAULT_POLICY, features({ inputTokens: 200_000, taskClass: 'doc.deep_read' }));
    expect(decision.model.contextTokens).toBeGreaterThanOrEqual(200_000);
  });

  it('never returns a model that already failed this request', () => {
    const first = route(DEFAULT_POLICY, features());
    const second = route(
      DEFAULT_POLICY,
      features({ priorFailures: [{ modelId: first.model.id, reason: 'verification', at: 0 }] }),
    );
    expect(second.model.id).not.toBe(first.model.id);
  });

  it('says what is impossible rather than guessing', () => {
    expect(() =>
      route(
        DEFAULT_POLICY,
        features({ taskClass: 'doc.deep_read', dataSensitivity: 'positions' }),
      ),
    ).toThrow(NoEligibleModel);
  });
});

describe('the utility score', () => {
  /**
   * The score reproduces PRD 4.2's own table without being told it.
   *
   * `summarize.bulk` lists "8B open-weight, batched" as primary and the 32B as
   * fallback. The 32B scores higher on quality and loses on latency — a 32B at
   * 1.1s p95 against an 800ms budget is a 25% chance of missing it — and the
   * router lands on the row the table specifies.
   */
  it('reproduces the table row from the score alone', () => {
    const decision = route(DEFAULT_POLICY, features({ taskClass: 'summarize.bulk' }));
    expect(decision.model.id).toBe('server-8b');
    expect(decision.candidates[0]?.score).toBeGreaterThan(decision.candidates[1]?.score ?? 0);

    // Give it the time and the better model wins, which is what a fallback is.
    const patient = route(DEFAULT_POLICY, features({ taskClass: 'summarize.bulk', latencyBudgetMs: 6_000 }));
    expect(patient.model.id).toBe('qwen-coder-32b');
  });

  /** "High rigor" is the analyst buying quality with money, on purpose. */
  it('lets high rigor outrank cost', () => {
    const thrifty = route(DEFAULT_POLICY, features({ taskClass: 'quant.codegen' }));
    const rigorous = route(DEFAULT_POLICY, features({ taskClass: 'quant.codegen', rigorFlag: true }));
    expect(rigorous.candidates.find((c) => c.model.id === rigorous.model.id)?.quality).toBeGreaterThan(
      thrifty.candidates.find((c) => c.model.id === thrifty.model.id)?.quality ?? 1,
    );
    expect(rigorous.reasons.some((r) => r.includes('quality outranks cost'))).toBe(true);
  });

  it('sends the always-escalate classes straight to the top', () => {
    for (const taskClass of ['doc.deep_read', 'sentiment.subtext'] as const) {
      const decision = route(DEFAULT_POLICY, features({ taskClass, latencyBudgetMs: 25_000 }));
      const best = [...decision.candidates].sort((a, b) => b.quality - a.quality)[0];
      expect(decision.model.id).toBe(best?.model.id);
    }
  });

  it('penalises a model that will miss the latency budget', () => {
    const relaxed = route(DEFAULT_POLICY, features({ taskClass: 'sql.generate', latencyBudgetMs: 10_000 }));
    const tight = route(DEFAULT_POLICY, features({ taskClass: 'sql.generate', latencyBudgetMs: 200 }));
    const riskOf = (d: typeof relaxed) =>
      d.candidates.find((c) => c.model.id === 'frontier-a')?.latencyRisk ?? 0;
    expect(riskOf(tight)).toBeGreaterThan(riskOf(relaxed));
  });

  it('will not pick a model it has never evaluated on the task', () => {
    // local-3b has no quality entry for sql.generate.
    const decision = route(DEFAULT_POLICY, features({ taskClass: 'sql.generate' }));
    expect(decision.candidates.some((c) => c.model.id === 'local-3b')).toBe(false);
    expect(decision.excluded.some((e) => e.modelId === 'local-3b' && e.rule.includes('not evaluated'))).toBe(
      true,
    );
  });

  it('names a model and asks rather than degrading when nothing fits the budget', () => {
    const decision = route(DEFAULT_POLICY, features({ costCeilingCents: 0.0001 }));
    expect(decision.model).toBeDefined();
    expect(decision.reasons.some((r) => r.includes('requires approval'))).toBe(true);
  });
});

describe('the policy is data', () => {
  it('carries a version onto every decision, so a trace can be replayed', () => {
    expect(route(DEFAULT_POLICY, features()).policyVersion).toBe(DEFAULT_POLICY.version);
  });

  it('follows a rewritten quality number without a code change', () => {
    // PRD 4.7 has the eval harness rewriting these. Here the cheap model is
    // measured better than the frontier one, and the router simply believes it.
    const rewritten: RoutingPolicy = {
      ...DEFAULT_POLICY,
      version: '1.1.0',
      models: DEFAULT_POLICY.models.map((m) =>
        m.id === 'qwen-coder-32b' ? { ...m, quality: { ...m.quality, 'sql.generate': 0.99 } } : m,
      ),
    };
    const decision = route(rewritten, features({ rigorFlag: true }));
    expect(decision.model.id).toBe('qwen-coder-32b');
    expect(modelById(rewritten, 'qwen-coder-32b')?.quality['sql.generate']).toBe(0.99);
  });
});
