import { describe, expect, it } from 'vitest';
import { Blackboard } from '../src/blackboard.js';
import { run } from '../src/coordinator.js';
import {
  APPROVAL_CENTS,
  addStep,
  changeMethod,
  criticalPath,
  deleteStep,
  plan,
  scope,
  toPlanSteps,
  type PlannedStep,
  type Resolver,
} from '../src/query.js';

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
    const result = plan({ scope: ready, steps });
    expect(sum).toBe(39_000);
    // retrieve(4s) -> subtext(8s) = 12s; portfolio(0.5s) -> shock(21.5s) = 22s;
    // the longer branch plus the scribe.
    expect(result.estimatedMs).toBe(27_000);
    expect(criticalPath(steps)).toBe(27_000);
  });

  it('shows itself before running when it costs more than the threshold', () => {
    const result = plan({ scope: ready, steps: branchedSteps() });
    expect(result.totalCents).toBe(22);
    expect(result.needsApproval).toBe(false);

    const expensive = branchedSteps().map((s) => ({ ...s, estimatedCents: s.estimatedCents * 3 }));
    const shown = plan({ scope: ready, steps: expensive });
    expect(shown.needsApproval).toBe(true);
    expect(shown.approvalReason).toContain(`${APPROVAL_CENTS}-cent threshold`);
  });

  it('shows itself whatever it costs when the analyst asked for rigor', () => {
    const result = plan({ scope: ready, steps: branchedSteps(), highRigor: true });
    expect(result.needsApproval).toBe(true);
    expect(result.approvalReason).toBe('flagged high-rigor');
  });

  it('refuses to be runnable while a mention is unresolved', () => {
    const unresolved = scope({ question: 'Compare MU', resolve: resolver });
    const result = plan({ scope: unresolved, steps: branchedSteps() });
    expect(result.warnings.join(' ')).toContain('cannot run until they are chosen');
  });

  it('names a step that depends on something not in the plan', () => {
    const orphan = branchedSteps().filter((s) => s.id !== 'portfolio');
    expect(plan({ scope: ready, steps: orphan }).warnings.join(' ')).toContain('not in the plan');
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
    const before = plan({ scope: ready, steps: branchedSteps() });
    const edit = deleteStep(before, 'portfolio', ready);
    expect(edit.pruned).toEqual(expect.arrayContaining(['shock', 'scribe']));
    expect(edit.note).toContain('depended on it');
    expect(edit.plan.steps.map((s) => s.id)).toEqual(['retrieve', 'subtext']);
  });

  it('says nothing about pruning when nothing depended on the step', () => {
    const before = plan({ scope: ready, steps: branchedSteps() });
    const edit = deleteStep(before, 'scribe', ready);
    expect(edit.pruned).toEqual([]);
    expect(edit.note).toBeUndefined();
  });

  it('re-estimates cost and time after an edit', () => {
    const before = plan({ scope: ready, steps: branchedSteps() });
    const after = deleteStep(before, 'portfolio', ready).plan;
    expect(after.totalCents).toBeLessThan(before.totalCents);
    expect(after.estimatedMs).toBeLessThan(before.estimatedMs);
  });

  it('adds a data source as a new step', () => {
    const before = plan({ scope: ready, steps: branchedSteps() });
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
    const before = plan({ scope: ready, steps: branchedSteps() });
    const edit = changeMethod(before, 'shock', 'parallel', ready);
    expect(edit.plan.steps.find((s) => s.id === 'shock')?.method).toBe('parallel');
    expect(edit.note).toBeUndefined();
  });

  it('flags a method the step never offered', () => {
    const before = plan({ scope: ready, steps: branchedSteps() });
    const edit = changeMethod(before, 'shock', 'invented', ready);
    expect(edit.note).toContain('not one of the alternatives');
  });
});

describe('handing the approved plan to the coordinator', () => {
  it('runs it as waves, with the estimates as budgets', async () => {
    const ready = scope({ question: 'Read the call and stress the book', resolve: resolver });
    const approved = plan({ scope: ready, steps: branchedSteps() });

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
