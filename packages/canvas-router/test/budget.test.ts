import { describe, expect, it } from 'vitest';
import { Budgets } from '../src/budget.js';
import { TraceStore } from '../src/trace.js';

function budgets() {
  return new Budgets(
    { spentCents: 0, spentTokens: 0, ceilingCents: 100, ceilingTokens: 1_000_000 },
    { ceilingCents: 40, ceilingTokens: 400_000 },
    { ceilingCents: 10, ceilingTokens: 100_000 },
  );
}

describe('budget ceilings', () => {
  it('allows a dispatch inside every ceiling', () => {
    const outcome = budgets().check({ costCents: 5, tokens: 10_000, nodeId: 'n1' });
    expect(outcome.allowed).toBe(true);
  });

  /**
   * PRD 4.3: "The orchestrator refuses dispatch past the ceiling and surfaces a
   * clear 'this node wants $0.42 more, approve?' prompt rather than silently
   * degrading."
   *
   * Silent degradation is the failure mode. A cheaper model produces a worse
   * answer that looks exactly like a better one, and the analyst has no way to
   * tell which they are reading.
   */
  it('refuses and asks, in the words the PRD uses', () => {
    // A 52-cent request against a 10-cent node ceiling is 42 cents short, which
    // is the PRD's own example phrased in dollars.
    const outcome = budgets().check({ costCents: 52, tokens: 1_000, nodeId: 'n1' });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.scope).toBe('node');
    expect(outcome.shortfallCents).toBeCloseTo(42, 9);
    expect(outcome.prompt).toBe('this node wants $0.42 more, approve?');
  });

  /**
   * The prompt has to name the ceiling that actually binds, or raising it
   * changes nothing.
   */
  it('names the tightest ceiling, not the first one checked', () => {
    const b = budgets();
    // Session has 100c of room, agent 40c, node 10c. A 60c request breaks the
    // node by 50 and the agent by 20; the node is what has to be raised.
    const outcome = b.check({ costCents: 60, tokens: 1_000, nodeId: 'n1', agentId: 'a1' });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.scope).toBe('node');
    expect(outcome.shortfallCents).toBeCloseTo(50, 9);
  });

  it('a token ceiling binds too, reported in the same unit as the money', () => {
    const outcome = budgets().check({ costCents: 1, tokens: 200_000, nodeId: 'n1' });
    expect(outcome.allowed).toBe(false);
  });

  it('charges every scope, and approving raises exactly one', () => {
    const b = budgets();
    b.charge({ costCents: 6, tokens: 5_000, nodeId: 'n1', agentId: 'a1' });
    expect(b.spent('node', 'n1').spentCents).toBe(6);
    expect(b.spent('agent', 'a1').spentCents).toBe(6);
    expect(b.spent('session', 'session').spentCents).toBe(6);

    expect(b.check({ costCents: 6, tokens: 1_000, nodeId: 'n1' }).allowed).toBe(false);
    b.approve('node', 'n1', 10);
    expect(b.check({ costCents: 6, tokens: 1_000, nodeId: 'n1' }).allowed).toBe(true);
    // And the other scopes were not quietly raised with it.
    expect(b.spent('session', 'session').ceilingCents).toBe(100);
  });

  it('keeps separate nodes separate', () => {
    const b = budgets();
    b.charge({ costCents: 9, tokens: 1_000, nodeId: 'n1' });
    expect(b.check({ costCents: 9, tokens: 1_000, nodeId: 'n2' }).allowed).toBe(true);
    expect(b.check({ costCents: 9, tokens: 1_000, nodeId: 'n1' }).allowed).toBe(false);
  });
});

describe('the trace store', () => {
  const store = new TraceStore();
  const base = {
    nodeId: 'n1',
    taskClass: 'sql.generate' as const,
    policyVersion: '1.0.0',
    inputTokens: 1_000,
    outputTokens: 200,
    costCents: 0.05,
    latencyMs: 400,
    at: 1,
  };

  it('feeds quality back from what was verified, not from what was claimed', () => {
    for (let i = 0; i < 8; i += 1) {
      store.record({ ...base, id: `a${i}`, modelId: 'qwen-coder-32b', verified: i < 6 });
    }
    for (let i = 0; i < 4; i += 1) {
      store.record({ ...base, id: `b${i}`, modelId: 'frontier-a', verified: true, costCents: 1.1 });
    }
    // An unverified dispatch says nothing about quality and must not count as
    // a pass, or a class with no verifier drifts upward forever.
    store.record({ ...base, id: 'c', modelId: 'qwen-coder-32b' });

    const stats = store.stats();
    const cheap = stats.find((s) => s.modelId === 'qwen-coder-32b');
    expect(cheap?.acceptanceRate).toBeCloseTo(6 / 8, 9);
    expect(cheap?.dispatches).toBe(9);
    expect(stats.find((s) => s.modelId === 'frontier-a')?.acceptanceRate).toBe(1);
  });

  it('reports nothing rather than a number when nothing was verified', () => {
    const fresh = new TraceStore();
    fresh.record({ ...base, id: 'x', modelId: 'server-8b', taskClass: 'summarize.bulk' });
    expect(Number.isNaN(fresh.stats()[0]?.acceptanceRate ?? 0)).toBe(true);
  });

  it('keeps every dispatch a node made, for its provenance', () => {
    expect(store.forNode('n1').length).toBeGreaterThan(10);
    expect(store.spentCents()).toBeGreaterThan(0);
  });
});
