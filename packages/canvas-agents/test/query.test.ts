import { describe, expect, it } from 'vitest';
import { addNode, createDocument, createNode } from '@picasso/canvas-core';
import { Blackboard } from '../src/blackboard.js';
import { assembleContext } from '../src/context.js';
import { run } from '../src/coordinator.js';
import {
  APPROVAL_CENTS,
  addStep,
  changeMethod,
  criticalPath,
  deleteStep,
  openQueryNode,
  plan,
  queryScope,
  scope,
  toPlanSteps,
  approve,
  isApproved,
  PlanNotRunnable,
  type PlanAuthor,
  type PlannedStep,
  type Resolver,
} from '../src/query.js';

const analyst: PlanAuthor = { kind: 'analyst', user: 'pm' };
const model: PlanAuthor = { kind: 'model', model: 'qwen2.5-1.5b' };

const resolver: Resolver = (mention) => {
  switch (mention) {
    case 'NVDA':
      return [{ kind: 'instrument', id: 'eq:nvda:us', label: 'NVIDIA Corp' }];
    case 'MU':
      // Two real listings. An entity resolver that picks one is right most of
      // the time, which is exactly the problem.
      return [
        { kind: 'instrument', id: 'eq:mu:us', label: 'Micron Technology', hint: 'NASDAQ' },
        { kind: 'instrument', id: 'eq:mu:de', label: 'Micron Technology', hint: 'Frankfurt' },
      ];
    case 'my portfolio':
      return [{ kind: 'portfolio', id: 'pf:main', label: 'Main book' }];
    default:
      return [];
  }
};

/** The worked example's shape: two branches and a join. */
function branchedSteps(): PlannedStep[] {
  return [
    {
      id: 'retrieve',
      kind: 'retrieval',
      description: 'pull transcripts',
      agent: 'retriever',
      dependsOn: [],
      estimatedCents: 2,
      estimatedMs: 4_000,
    },
    {
      id: 'subtext',
      kind: 'reasoning',
      description: 'read the Q&A',
      agent: 'extractor',
      taskClass: 'sentiment.subtext',
      dependsOn: ['retrieve'],
      estimatedCents: 6,
      estimatedMs: 8_000,
    },
    {
      id: 'portfolio',
      kind: 'compute',
      description: 'load the book',
      agent: 'quant',
      dependsOn: [],
      estimatedCents: 1,
      estimatedMs: 500,
      method: 'local_only',
    },
    {
      id: 'shock',
      kind: 'compute',
      description: 'apply the rate shock',
      agent: 'simulator',
      dependsOn: ['portfolio'],
      estimatedCents: 4,
      estimatedMs: 21_500,
      method: 'historically_estimated_shape',
      alternatives: ['historically_estimated_shape', 'parallel'],
    },
    {
      id: 'scribe',
      kind: 'reasoning',
      description: 'write the answer',
      agent: 'scribe',
      taskClass: 'synthesis.final',
      dependsOn: ['subtext', 'shock'],
      estimatedCents: 9,
      estimatedMs: 5_000,
    },
  ];
}

describe('parse and scope', () => {
  // "Ambiguity produces a disambiguation chip, not a guess."
  it('refuses to pick between two candidates', () => {
    const result = scope({ question: 'How does MU compare to NVDA?', resolve: resolver });
    expect(result.ready).toBe(false);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]?.mention).toBe('MU');
    expect(result.ambiguous[0]?.candidates).toHaveLength(2);
    // Never pre-selected.
    expect(result.resolved.map((r) => r.mention)).toEqual(['NVDA']);
  });

  it('shows a hint on each candidate so the chip is choosable', () => {
    const result = scope({ question: 'What about MU?', resolve: resolver });
    expect(result.ambiguous[0]?.candidates.map((c) => c.hint)).toEqual(['NASDAQ', 'Frankfurt']);
  });

  it('accepts a choice made on a previous pass', () => {
    const result = scope({
      question: 'How does MU compare to NVDA?',
      resolve: resolver,
      choices: { MU: 'eq:mu:us' },
    });
    expect(result.ready).toBe(true);
    expect(result.resolved.find((r) => r.mention === 'MU')?.id).toBe('eq:mu:us');
  });

  it('resolves a possessive reference to a canvas object', () => {
    const result = scope({ question: 'Stress my portfolio against 50bp', resolve: resolver });
    expect(result.resolved.find((r) => r.kind === 'portfolio')?.id).toBe('pf:main');
  });

  // An unrecognized word is almost always an ordinary English word, not a
  // ticker nobody has heard of.
  it('drops an unrecognized mention rather than reporting it as unresolvable', () => {
    const result = scope({ question: 'What about THE outlook for NVDA?', resolve: resolver });
    expect(result.ready).toBe(true);
    expect(result.ambiguous).toEqual([]);
  });

  it('carries the nodes the analyst had selected', () => {
    const result = scope({ question: 'Explain NVDA', resolve: resolver, selectedNodes: ['n1', 'n2'] });
    expect(result.selectedNodes).toEqual(['n1', 'n2']);
  });
});

describe('the plan', () => {
  const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });

  // Summing would quote 39 seconds for a plan that takes 26.5, and the analyst
  // would decline a plan they should have approved.
  it('estimates the critical path, not the sum', () => {
    const steps = branchedSteps();
    const sum = steps.reduce((total, s) => total + s.estimatedMs, 0);
    const result = plan({ scope: ready, author: analyst, steps });
    expect(sum).toBe(39_000);
    // retrieve(4s) -> subtext(8s) = 12s; portfolio(0.5s) -> shock(21.5s) = 22s;
    // the longer branch plus the scribe.
    expect(result.estimatedMs).toBe(27_000);
    expect(criticalPath(steps)).toBe(27_000);
  });

  it('shows itself before running when it costs more than the threshold', () => {
    const result = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    expect(result.totalCents).toBe(22);
    expect(result.needsApproval).toBe(false);

    const expensive = branchedSteps().map((s) => ({ ...s, estimatedCents: s.estimatedCents * 3 }));
    const shown = plan({ scope: ready, author: analyst, steps: expensive });
    expect(shown.needsApproval).toBe(true);
    expect(shown.approvalReason).toContain(`${APPROVAL_CENTS}-cent threshold`);
  });

  it('shows itself whatever it costs when the analyst asked for rigor', () => {
    const result = plan({ scope: ready, author: analyst, steps: branchedSteps(), highRigor: true });
    expect(result.needsApproval).toBe(true);
    expect(result.approvalReason).toBe('flagged high-rigor');
  });

  it('refuses to be runnable while a mention is unresolved', () => {
    const unresolved = scope({ question: 'Compare MU', resolve: resolver });
    const result = plan({ scope: unresolved, author: analyst, steps: branchedSteps() });
    expect(result.warnings.join(' ')).toContain('cannot run until they are chosen');
  });

  it('names a step that depends on something not in the plan', () => {
    const orphan = branchedSteps().filter((s) => s.id !== 'portfolio');
    expect(plan({ scope: ready, author: analyst, steps: orphan }).warnings.join(' ')).toContain('not in the plan');
  });

  it('survives a dependency cycle rather than recursing forever', () => {
    const cyclic: PlannedStep[] = [
      { id: 'a', kind: 'compute', description: 'a', agent: 'quant', dependsOn: ['b'], estimatedCents: 1, estimatedMs: 10 },
      { id: 'b', kind: 'compute', description: 'b', agent: 'quant', dependsOn: ['a'], estimatedCents: 1, estimatedMs: 10 },
    ];
    expect(Number.isFinite(criticalPath(cyclic))).toBe(true);
  });
});

describe('editing a plan', () => {
  const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });

  // Leaving a dependent behind produces a run that stalls at a wave boundary
  // waiting on an input that will never arrive.
  it('prunes what can no longer run, and names it', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const edit = deleteStep(before, 'portfolio', ready);
    expect(edit.pruned).toEqual(expect.arrayContaining(['shock', 'scribe']));
    expect(edit.note).toContain('depended on it');
    expect(edit.plan.steps.map((s) => s.id)).toEqual(['retrieve', 'subtext']);
  });

  it('says nothing about pruning when nothing depended on the step', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const edit = deleteStep(before, 'scribe', ready);
    expect(edit.pruned).toEqual([]);
    expect(edit.note).toBeUndefined();
  });

  it('re-estimates cost and time after an edit', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const after = deleteStep(before, 'portfolio', ready).plan;
    expect(after.totalCents).toBeLessThan(before.totalCents);
    expect(after.estimatedMs).toBeLessThan(before.estimatedMs);
  });

  it('adds a data source as a new step', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const edit = addStep(
      before,
      {
        id: 'ownership',
        kind: 'retrieval',
        description: 'pull 13F ownership',
        agent: 'retriever',
        dependsOn: [],
        estimatedCents: 1,
        estimatedMs: 900,
      },
      ready,
    );
    expect(edit.plan.steps).toHaveLength(6);
    expect(edit.plan.totalCents).toBe(23);
  });

  // "it refuses to pretend a parallel shift is the honest default" — so the
  // parallel shape is an alternative the analyst can pick, not the default.
  it('changes a method to one the step offered', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const edit = changeMethod(before, 'shock', 'parallel', ready);
    expect(edit.plan.steps.find((s) => s.id === 'shock')?.method).toBe('parallel');
    expect(edit.note).toBeUndefined();
  });

  it('flags a method the step never offered', () => {
    const before = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const edit = changeMethod(before, 'shock', 'invented', ready);
    expect(edit.note).toContain('not one of the alternatives');
  });
});

describe('a plan a model wrote', () => {
  const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });

  // The product decision of 27 November: whatever it costs.
  it('is shown before it runs, however cheap, and says who wrote it', () => {
    const mine = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    const theirs = plan({ scope: ready, author: model, steps: branchedSteps() });
    expect(mine.totalCents).toBe(theirs.totalCents);
    expect(mine.needsApproval).toBe(false);
    expect(theirs.needsApproval).toBe(true);
    expect(theirs.approvalReason).toBe("written by qwen2.5-1.5b, and a model's plan is shown before it runs");
    expect(theirs.author).toEqual(model);
  });

  it('gives every reason it is shown, not only the first', () => {
    const expensive = branchedSteps().map((s) => ({ ...s, estimatedCents: s.estimatedCents * 3 }));
    const shown = plan({ scope: ready, author: model, steps: expensive, highRigor: true });
    expect(shown.approvalReason?.split('; ')).toEqual([
      'flagged high-rigor',
      `estimated at 66 cents, above the ${APPROVAL_CENTS}-cent threshold`,
      "written by qwen2.5-1.5b, and a model's plan is shown before it runs",
    ]);
  });

  it('stays a model\'s plan through the analyst\'s edits, so the edited plan is shown again', () => {
    const before = plan({ scope: ready, author: model, steps: branchedSteps() });
    const after = deleteStep(approve(before, { user: 'pm', at: '2026-11-27T10:00:00Z' }), 'scribe', ready).plan;
    expect(after.author).toEqual(model);
    expect(after.needsApproval).toBe(true);
    expect(isApproved(after)).toBe(false);
    expect(() => toPlanSteps(after)).toThrow(PlanNotRunnable);
  });
});

describe('approval', () => {
  const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });

  it('is the only way a plan that must be shown reaches the coordinator', () => {
    const shown = plan({ scope: ready, author: model, steps: branchedSteps() });
    expect(() => toPlanSteps(shown)).toThrow(/must be shown and approved first \(written by qwen2.5-1.5b/);
    const yes = approve(shown, { user: 'pm', at: '2026-11-27T10:00:00Z' });
    expect(yes.approval).toEqual({ by: 'pm', at: '2026-11-27T10:00:00Z' });
    expect(toPlanSteps(yes).map((s) => s.id)).toEqual(shown.steps.map((s) => s.id));
    // The plan that was shown is untouched; the approved copy is a different object.
    expect(shown.approval).toBeUndefined();
    expect(isApproved(shown)).toBe(false);
  });

  it('cannot be forged by copying or by writing the field', () => {
    const shown = plan({ scope: ready, author: model, steps: branchedSteps() });
    const yes = approve(shown, { user: 'pm', at: '2026-11-27T10:00:00Z' });
    expect(() => toPlanSteps({ ...yes })).toThrow(PlanNotRunnable);
    expect(() => toPlanSteps({ ...shown, approval: { by: 'pm', at: 'now' } })).toThrow(PlanNotRunnable);
  });

  it('freezes what was approved, steps included', () => {
    const yes = approve(plan({ scope: ready, author: model, steps: branchedSteps() }), { user: 'pm', at: 'now' });
    expect(() => {
      (yes.steps as PlannedStep[]).push(yes.steps[0]!);
    }).toThrow(TypeError);
    expect(() => {
      (yes.steps[0] as { dependsOn: string[] }).dependsOn.push('elsewhere');
    }).toThrow(TypeError);
  });

  it('is refused for a plan that cannot run, and names the analyst who gave it', () => {
    const unresolved = scope({ question: 'Compare MU', resolve: resolver });
    const stuck = plan({ scope: unresolved, author: analyst, steps: branchedSteps() });
    expect(stuck.blockers.join(' ')).toContain('cannot run until they are chosen');
    expect(() => approve(stuck, { user: 'pm', at: 'now' })).toThrow(PlanNotRunnable);
    expect(() => toPlanSteps(stuck)).toThrow(PlanNotRunnable);
    expect(() => approve(plan({ scope: ready, author: model, steps: branchedSteps() }), { user: ' ', at: 'now' })).toThrow(/names the analyst/);
  });

  it('is not needed for a cheap plan the analyst wrote', () => {
    const mine = plan({ scope: ready, author: analyst, steps: branchedSteps() });
    expect(toPlanSteps(mine)).toHaveLength(5);
  });

  it('refuses a plan with a step whose input is missing, approved or not', () => {
    const orphan = plan({ scope: ready, author: analyst, steps: branchedSteps().filter((s) => s.id !== 'portfolio') });
    expect(() => toPlanSteps(orphan)).toThrow(/depends on a step that is not in the plan/);
  });
});

describe('handing the approved plan to the coordinator', () => {
  it('runs it as waves, with the estimates as budgets', async () => {
    const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });
    const approved = plan({ scope: ready, author: analyst, steps: branchedSteps() });

    const board = new Blackboard('q1', approved.question, 100);
    board.setPlan(toPlanSteps(approved));

    const agents = Object.fromEntries(
      approved.steps.map((step) => [step.id, () => ({ costCents: step.estimatedCents })]),
    );
    const result = await run({ board, agents });

    expect(result.completed).toHaveLength(5);
    // retrieve+portfolio, subtext+shock, scribe.
    expect(result.waves).toBe(3);
    expect(board.budgetState().spentCents).toBe(approved.totalCents);
  });
});

describe('Cmd J: a query at the cursor, scoped to the selection (PRD 3.8)', () => {
  function canvas() {
    const doc = createDocument('c');
    for (const id of ['curve', 'book', 'vol']) {
      addNode(doc, createNode({ id, kind: 'TransformNode', binding: 'wired' }));
    }
    return doc;
  }
  const viewport = { x: 1000, y: 500, scale: 0.5, width: 1440, height: 900 };

  it('lands where the cursor is, in world space', () => {
    const { node } = openQueryNode({ id: 'q1', doc: canvas(), viewport, cursor: { x: 200, y: 100 }, selection: [] });
    expect(node.kind).toBe('QueryNode');
    expect(node.position).toEqual({ x: 1400, y: 700 });
    expect(node.binding).toBe('bound');
  });

  it('takes a copy of the selection, so clicking on while typing does not change the question', () => {
    const selection = new Set(['book', 'curve']);
    const { node } = openQueryNode({ id: 'q2', doc: canvas(), viewport, cursor: { x: 0, y: 0 }, selection });
    selection.clear();
    selection.add('vol');
    expect(queryScope(node)).toEqual(['book', 'curve']);
  });

  it('reports a selected node a peer has just deleted rather than scoping it', () => {
    const doc = canvas();
    const { node, dropped } = openQueryNode({ id: 'q3', doc, viewport, cursor: { x: 0, y: 0 }, selection: ['book', 'gone'] });
    expect(queryScope(node)).toEqual(['book']);
    expect(dropped).toEqual(['gone']);
  });

  it('carries the scope into planning and into the context', () => {
    const doc = canvas();
    const { node } = openQueryNode({ id: 'q4', doc, viewport, cursor: { x: 0, y: 0 }, selection: ['book'] });
    const scoped = scope({ question: 'stress this against 50bps', resolve: resolver, selectedNodes: queryScope(node) });
    expect(scoped.selectedNodes).toEqual(['book']);
    const context = assembleContext({
      doc,
      question: scoped.question,
      selected: queryScope(node),
      policy: { ceiling: 1000 },
    });
    expect(context.items.map((i) => i.nodeId)).toContain('book');
  });

  it('carries the scope as a param, where the cache key reads it', () => {
    const a = openQueryNode({ id: 'q5', doc: canvas(), viewport, cursor: { x: 0, y: 0 }, selection: ['book'] }).node;
    const b = openQueryNode({ id: 'q5', doc: canvas(), viewport, cursor: { x: 0, y: 0 }, selection: ['book', 'vol'] }).node;
    expect(a.params.scope).not.toEqual(b.params.scope);
  });
});
