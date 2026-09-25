import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode, type CanvasDocument, type Edge } from '@picasso/canvas-core';
import {
  AgentSchedule,
  AgentScope,
  OutsideSubgraph,
  createAgentNode,
  type AgentSpec,
} from '../src/agentNode.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 2, 6, 9, 0);

/** portfolio -> vol-surface -> vol-monitor, and an unrelated rates node. */
function canvas(): CanvasDocument {
  const doc = createDocument('c');
  for (const id of ['portfolio', 'vol-surface', 'vol-monitor', 'rates']) {
    addNode(doc, createNode({ id, kind: 'TransformNode', binding: 'wired', params: { threshold: 2 } }));
  }
  const wire = (from: string, to: string): Edge => ({
    id: `${from}->${to}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'data',
  });
  for (const e of [wire('portfolio', 'vol-surface'), wire('vol-surface', 'vol-monitor')]) doc.edges.set(e.id, e);
  return doc;
}

const spec: AgentSpec = {
  id: 'agent-1',
  role: 'quant',
  subgraph: ['vol-surface', 'vol-monitor'],
  monthlyBudgetCents: 500,
  everyMs: HOUR,
};

describe('the AgentNode', () => {
  it('is created with a role, a subgraph, a budget and a schedule', () => {
    const node = createAgentNode(spec);
    expect(node.kind).toBe('AgentNode');
    expect(node.params).toMatchObject({ role: 'quant', monthlyBudgetCents: 500, everyMs: HOUR });
  });

  it('refuses a spec that would let it run unbounded', () => {
    expect(() => createAgentNode({ ...spec, subgraph: [] })).toThrow(/bound to nothing/);
    expect(() => createAgentNode({ ...spec, monthlyBudgetCents: 0 })).toThrow(/budget/);
    expect(() => createAgentNode({ ...spec, everyMs: 1000 })).toThrow(/once a minute/);
    expect(() => createAgentNode({ ...spec, role: 'trader' as never })).toThrow(/not an agent role/);
  });
});

describe('the scope', () => {
  it('reads its subgraph and what it is computed from', () => {
    const scope = new AgentScope(canvas(), 'agent-1', spec.subgraph);
    expect(scope.canRead('portfolio')).toBe(true);
    expect(scope.read('portfolio')?.id).toBe('portfolio');
    expect(() => scope.read('rates')).toThrow(OutsideSubgraph);
  });

  it('writes only its own nodes, however good its reason', () => {
    const doc = canvas();
    const scope = new AgentScope(doc, 'agent-1', spec.subgraph);
    scope.setParam('vol-monitor', 'threshold', 3);
    expect(doc.nodes.get('vol-monitor')!.params.threshold).toBe(3);
    // Upstream, readable, and still not writable.
    expect(() => scope.setParam('portfolio', 'threshold', 3)).toThrow(OutsideSubgraph);
    expect(doc.nodes.get('portfolio')!.params.threshold).toBe(2);
  });

  it('hands out copies, so a read is not a write by another name', () => {
    const doc = canvas();
    const scope = new AgentScope(doc, 'agent-1', spec.subgraph);
    const copy = scope.read('portfolio')!;
    copy.params.threshold = 99;
    expect(doc.nodes.get('portfolio')!.params.threshold).toBe(2);
  });
});

describe('the schedule and the budget', () => {
  it('runs when due and not before', () => {
    const schedule = new AgentSchedule(spec);
    expect(schedule.decide(T0, 10)).toMatchObject({ run: true, skippedRuns: 0 });
    schedule.record(T0, 10);
    expect(schedule.decide(T0 + HOUR - 1, 10)).toMatchObject({ run: false, reason: 'not_due', nextAt: T0 + HOUR });
    expect(schedule.decide(T0 + HOUR, 10).run).toBe(true);
  });

  it('catches up a long weekend with one run, and counts what it skipped', () => {
    const schedule = new AgentSchedule(spec);
    schedule.record(T0, 10);
    const back = T0 + 72 * HOUR + 5 * 60_000;
    expect(schedule.decide(back, 10)).toMatchObject({ run: true, skippedRuns: 71 });
  });

  it('skips a run the month cannot pay for, rather than running it cheaper', () => {
    const schedule = new AgentSchedule(spec);
    schedule.record(T0, 480);
    const decision = schedule.decide(T0 + HOUR, 30);
    expect(decision).toMatchObject({ run: false, reason: 'budget_exhausted' });
    expect(decision.run === false && decision.nextAt).toBe(Date.UTC(2026, 3, 1));
    expect(schedule.skips).toHaveLength(1);
    expect(schedule.skips[0]!.reason).toContain('not run cheaper');
  });

  it('starts the budget again in a new month', () => {
    const schedule = new AgentSchedule(spec);
    schedule.record(Date.UTC(2026, 2, 31, 23, 0), 500);
    expect(schedule.decide(Date.UTC(2026, 3, 1, 0, 30), 30)).toMatchObject({ run: true, remainingCents: 500 });
  });
});
