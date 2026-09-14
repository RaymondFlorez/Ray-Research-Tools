import { describe, expect, it } from 'vitest';
import { AppendOnlyViolation, Blackboard, type Quantity } from '../src/blackboard.js';

function board(): Blackboard {
  return new Blackboard('task-1', 'stress the book against 50bp', 100);
}

function quantity(number: number, unit = 'usd'): Quantity {
  return { number, unit, asof: '2026-03-11' };
}

describe('the fact board is append-only', () => {
  it('refuses a second fact under an id already used', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'vega',
      value: quantity(-3870),
      provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    expect(() =>
      b.assert({
        id: 'f1',
        claim: 'vega',
        value: quantity(-3000),
        provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
        confidence: 1,
        assertedBy: 'simulator',
      }),
    ).toThrow(AppendOnlyViolation);
  });

  it('keeps both sides of a disagreement', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'vega',
      value: quantity(-3870),
      provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    b.assert({
      id: 'f2',
      claim: 'vega',
      value: quantity(-4200),
      provenance: { kind: 'model', traceId: 't1' },
      confidence: 0.6,
      assertedBy: 'scribe',
    });
    expect(b.facts()).toHaveLength(2);
    expect(b.conflicts()).toHaveLength(1);
    expect(b.fact('f1')?.contested).toBe(true);
    expect(b.fact('f2')?.contested).toBe(true);
  });
});

describe('contested is a property of the set, not of the assertion', () => {
  it('cannot be claimed away by the asserting agent', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'vega',
      value: quantity(-3870),
      provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    const asserted = b.assert({
      id: 'f2',
      claim: 'vega',
      value: quantity(-4200),
      provenance: { kind: 'model', traceId: 't1' },
      // The agent says it is not contested. The board disagrees, because the
      // board can see the other fact and the agent cannot.
      confidence: 1,
      assertedBy: 'scribe',
    });
    expect(asserted.contested).toBe(true);
  });

  it('clears on both sides when the conflict resolves, without deleting either', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'vega',
      value: quantity(-3870),
      provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    b.assert({
      id: 'f2',
      claim: 'vega',
      value: quantity(-4200),
      provenance: { kind: 'model', traceId: 't1' },
      confidence: 0.6,
      assertedBy: 'scribe',
    });
    const conflict = b.conflicts()[0]!;
    b.resolveConflict(conflict.id, 'f1', 'f1 traces to the aggregation node; f2 traces to a dispatch');
    expect(b.fact('f1')?.contested).toBe(false);
    expect(b.fact('f1')?.retracted).toBeUndefined();
    expect(b.fact('f2')?.retracted).toBe(true);
    expect(b.facts()).toHaveLength(2);
  });
});

describe('agreement between two assertions', () => {
  it('is decided at the tighter of the two precisions', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'vega',
      value: quantity(-3870.4),
      provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    // -3870 is inside the band -3870 claims, but not inside the band -3870.4
    // claims, and taking the looser one would let a vague assertion swallow a
    // precise one.
    b.assert({
      id: 'f2',
      claim: 'vega',
      value: quantity(-3870),
      provenance: { kind: 'cell', nodeId: 'agg2', cacheKey: 'k2' },
      confidence: 1,
      assertedBy: 'simulator',
    });
    expect(b.conflicts()).toHaveLength(1);
  });

  it('treats different units as disagreement whatever the digits say', () => {
    const b = board();
    b.assert({
      id: 'f1',
      claim: 'move',
      value: quantity(6.2, 'pct'),
      provenance: { kind: 'cell', nodeId: 'iv', cacheKey: 'k1' },
      confidence: 1,
      assertedBy: 'quant',
    });
    b.assert({
      id: 'f2',
      claim: 'move',
      value: quantity(6.2, 'bps'),
      provenance: { kind: 'cell', nodeId: 'iv2', cacheKey: 'k2' },
      confidence: 1,
      assertedBy: 'extractor',
    });
    expect(b.conflicts()).toHaveLength(1);
  });
});

describe('turn allocation reads the plan as a graph', () => {
  it('releases a step only when every dependency is done', () => {
    const b = board();
    b.setPlan([
      { id: 'a', description: 'branch A', agent: 'retriever', dependsOn: [], budgetCents: 1 },
      { id: 'b', description: 'branch B', agent: 'quant', dependsOn: [], budgetCents: 1 },
      { id: 'join', description: 'join', agent: 'reconciler', dependsOn: ['a', 'b'], budgetCents: 1 },
    ]);
    expect(b.ready().map((s) => s.id)).toEqual(['a', 'b']);
    b.updateStep('a', { status: 'done' });
    expect(b.ready().map((s) => s.id)).toEqual(['b']);
    b.updateStep('b', { status: 'done' });
    expect(b.ready().map((s) => s.id)).toEqual(['join']);
  });
});

describe('the budget', () => {
  it('refuses without spending rather than partially charging', () => {
    const b = new Blackboard('t', 'q', 10);
    expect(b.charge(6, 100)).toBe(true);
    expect(b.charge(6, 100)).toBe(false);
    expect(b.budgetState().spentCents).toBe(6);
    expect(b.budgetState().tokensUsed).toBe(100);
  });
});
