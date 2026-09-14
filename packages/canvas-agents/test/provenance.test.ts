import { describe, expect, it } from 'vitest';
import type { Edge, PicassoNode } from '@picasso/canvas-core';
import type { Fact } from '../src/blackboard.js';
import {
  auditDocument,
  badgeFor,
  checkWire,
  OverrideLog,
  overrideIsValid,
  statusFor,
} from '../src/provenance.js';

function node(id: string, kind: PicassoNode['kind']): PicassoNode {
  return {
    id,
    kind,
    binding: 'wired',
    position: { x: 0, y: 0 },
    size: { w: 100, h: 60 },
    z: 0,
    inputs: [],
    outputs: [],
    params: {},
    state: { status: 'ready' },
    provenance: { datasetSnapshots: {}, asof: '2026-03-11', verified: true },
    entitlementTags: [],
    createdBy: 'agent',
  };
}

function edge(id: string, to: string, klass: Edge['class'] = 'data'): Edge {
  return {
    id,
    from: { nodeId: 'src', portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: klass,
  };
}

const modelFact: Fact = {
  id: 'f-model',
  claim: 'segment gross margin',
  value: { number: 71, unit: 'pct', asof: '2026-03-11' },
  provenance: { kind: 'model', traceId: 'trace-1' },
  confidence: 0.6,
  contested: false,
  assertedBy: 'extractor',
  at: 1,
};

const cellFact: Fact = {
  ...modelFact,
  id: 'f-cell',
  provenance: { kind: 'cell', nodeId: 'agg', cacheKey: 'k1' },
};

describe('the badge', () => {
  it('marks a model-sourced fact unverified and a cell-sourced one verified', () => {
    expect(badgeFor(modelFact)).toBe('unverified');
    expect(badgeFor(cellFact)).toBe('verified');
    expect(statusFor(modelFact)).toBe('unverified');
  });

  it('shows a contested fact as contested whatever its source', () => {
    expect(badgeFor({ ...cellFact, contested: true })).toBe('contested');
  });
});

describe('wiring an unverified value into compute', () => {
  it('is refused without an override', () => {
    const decision = checkWire(modelFact, node('mc', 'MonteCarloNode'), edge('e1', 'mc'));
    expect(decision.allowed).toBe(false);
  });

  it('is allowed with an override that records who, when and why', () => {
    const wire = edge('e1', 'mc');
    wire.unverifiedOverride = {
      approvedBy: 'maya',
      approvedAt: 1_770_000_000_000,
      reason: 'checked the filing by hand',
    };
    const decision = checkWire(modelFact, node('mc', 'MonteCarloNode'), wire);
    expect(decision).toEqual({ allowed: true, overridden: true });
  });

  // An override that does not say who approved it is indistinguishable from
  // no override, which is what it would become after one refactor.
  it('is still refused when the override is a bare flag', () => {
    const wire = edge('e1', 'mc');
    wire.unverifiedOverride = { approvedBy: '', approvedAt: 0, reason: '' };
    const decision = checkWire(modelFact, node('mc', 'MonteCarloNode'), wire);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('approver');
  });

  it('allows the same value onto a text pad, which a person reads and can dismiss', () => {
    expect(checkWire(modelFact, node('pad', 'TextPad'), edge('e1', 'pad')).allowed).toBe(true);
  });

  it('allows it on a reference edge, which carries meaning and not values', () => {
    expect(
      checkWire(modelFact, node('mc', 'MonteCarloNode'), edge('e1', 'mc', 'reference')).allowed,
    ).toBe(true);
  });

  it('never blocks a cell-sourced value', () => {
    expect(checkWire(cellFact, node('mc', 'MonteCarloNode'), edge('e1', 'mc')).allowed).toBe(true);
  });
});

describe('the override log', () => {
  it('records the value as it stood at approval, so later drift is visible', () => {
    const log = new OverrideLog();
    const record = log.approve(modelFact, node('mc', 'MonteCarloNode'), edge('e1', 'mc'), {
      approvedBy: 'maya',
      approvedAt: 1_770_000_000_000,
      reason: 'checked the filing by hand',
    });
    expect(record.valueAtApproval).toBe(71);
    expect(log.forEdge('e1')).toHaveLength(1);
  });

  it('refuses to log an override that says nothing', () => {
    const log = new OverrideLog();
    expect(() =>
      log.approve(modelFact, node('mc', 'MonteCarloNode'), edge('e1', 'mc'), {
        approvedBy: 'maya',
        approvedAt: 0,
        reason: 'ok',
      }),
    ).toThrow();
  });

  it('accepts a bare-flag override as invalid', () => {
    expect(overrideIsValid(undefined)).toBe(false);
  });
});

describe('the sweep', () => {
  // The gate runs at connect time. This catches the wire that was legal when
  // it was made and stopped being legal when its source changed.
  it('finds a wire that became illegal after the fact went unverified', () => {
    const nodes = new Map([['mc', node('mc', 'MonteCarloNode')]]);
    const edges = [edge('e1', 'mc'), edge('e2', 'mc')];
    const facts = new Map<string, Fact>([
      ['e1', modelFact],
      ['e2', cellFact],
    ]);
    const violations = auditDocument(edges, nodes, (e) => facts.get(e.id));
    expect(violations.map((v) => v.edge.id)).toEqual(['e1']);
  });
});
