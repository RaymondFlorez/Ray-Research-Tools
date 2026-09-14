import { describe, expect, it } from 'vitest';
import { Blackboard } from '../src/blackboard.js';
import { joinAndReconcile, run } from '../src/coordinator.js';
import { baseline } from '../src/redteam.js';
import type { Narrative } from '../src/reconciler.js';

/** The worked example's shape: two independent branches and a join. */
function planned(ceiling = 100): Blackboard {
  const board = new Blackboard('task-1', 'read the call and stress the book', ceiling);
  board.setPlan([
    { id: 'retrieve', description: 'pull transcripts', agent: 'retriever', dependsOn: [], budgetCents: 2 },
    { id: 'extract', description: 'pull guidance language', agent: 'extractor', dependsOn: ['retrieve'], budgetCents: 3 },
    { id: 'quant', description: 'read the portfolio', agent: 'quant', dependsOn: [], budgetCents: 4 },
    { id: 'simulate', description: 'run the shock grid', agent: 'simulator', dependsOn: ['quant'], budgetCents: 20 },
    { id: 'scribe', description: 'write the answer', agent: 'scribe', dependsOn: ['extract', 'simulate'], budgetCents: 10 },
  ]);
  return board;
}

function agents(order: string[], overrides: Record<string, () => never | void> = {}) {
  const make = (id: string) => async () => {
    overrides[id]?.();
    order.push(id);
    return { costCents: 1 };
  };
  return {
    retrieve: make('retrieve'),
    extract: make('extract'),
    quant: make('quant'),
    simulate: make('simulate'),
    scribe: make('scribe'),
  };
}

describe('turn allocation', () => {
  it('runs the two independent branches in the same wave', async () => {
    const order: string[] = [];
    const board = planned();
    const result = await run({ board, agents: agents(order) });
    expect(result.completed).toHaveLength(5);
    // Three waves, not five steps in sequence: {retrieve, quant},
    // {extract, simulate}, {scribe}.
    expect(result.waves).toBe(3);
  });

  it('charges each step against the shared board budget', async () => {
    const board = planned();
    await run({ board, agents: agents([]) });
    expect(board.budgetState().spentCents).toBe(2 + 3 + 4 + 20 + 10);
  });
});

describe('a step that cannot be paid for', () => {
  // PRD 4.4's rule is that the system asks. Quietly substituting a cheaper
  // plan is the thing the analyst would not find out about.
  it('is skipped with a question on the board, not silently downgraded', async () => {
    const board = planned(10);
    const result = await run({ board, agents: agents([]) });
    expect(result.skipped).toContain('simulate');
    expect(board.openQuestions().join(' ')).toContain('Raise it?');
  });

  it('takes everything downstream of it with it, rather than leaving the plan half-pending', async () => {
    const board = planned(10);
    const result = await run({ board, agents: agents([]) });
    expect(result.skipped).toContain('scribe');
    expect(board.steps().every((s) => s.status !== 'pending')).toBe(true);
  });
});

describe('a step that throws', () => {
  it('is recorded as failed and does not take the rest of the wave down', async () => {
    const order: string[] = [];
    const board = planned();
    const result = await run({
      board,
      agents: agents(order, {
        retrieve: () => {
          throw new Error('transcript service timed out');
        },
      }),
    });
    expect(result.failed).toEqual(['retrieve']);
    expect(result.completed).toContain('quant');
    expect(board.step('retrieve')?.note).toContain('timed out');
  });
});

describe('the join', () => {
  function boardWithFacts(): Blackboard {
    const board = new Blackboard('task-1', 'q', 100);
    for (const fact of baseline().facts) {
      const { contested: _contested, at: _at, ...rest } = fact;
      board.assert(rest);
    }
    return board;
  }

  it('passes a clean draft on the first attempt', async () => {
    const c = baseline();
    const result = await joinAndReconcile(boardWithFacts(), {
      narrative: () => c.narrative,
      cells: () => c.cells,
      documents: c.documents,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('fails, reruns the Scribe with the corrected numbers, and passes', async () => {
    const c = baseline();
    const handle = c.narrative.handles.find((h) => h.factId === 'f-vega')!;
    const broken: Narrative = {
      text: c.narrative.text.slice(0, handle.start) + '-4,200' + c.narrative.text.slice(handle.end),
      handles: c.narrative.handles.map((h) => ({ ...h })),
    };
    let handed: number[] = [];
    const result = await joinAndReconcile(boardWithFacts(), {
      narrative: () => broken,
      cells: () => c.cells,
      documents: c.documents,
      rerunScribe: (corrections) => {
        // The Scribe receives numbers, not prose to transcribe.
        handed = corrections.map((x) => x.value);
        return c.narrative;
      },
    });
    expect(handed).toEqual([-3870]);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  // A Scribe failing the same way three times is not unlucky; it is reading
  // the number from somewhere the corrections do not reach.
  it('keeps every round so a repeated failure reads as a pattern', async () => {
    const c = baseline();
    const handle = c.narrative.handles.find((h) => h.factId === 'f-vega')!;
    const broken: Narrative = {
      text: c.narrative.text.slice(0, handle.start) + '-4,200' + c.narrative.text.slice(handle.end),
      handles: c.narrative.handles.map((h) => ({ ...h })),
    };
    const result = await joinAndReconcile(boardWithFacts(), {
      narrative: () => broken,
      cells: () => c.cells,
      documents: c.documents,
      rerunScribe: () => broken,
      maxAttempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.every((r) => r.some((f) => f.kind === 'transcription'))).toBe(true);
  });

  it('asks rather than redrafting when the budget is spent', async () => {
    const c = baseline();
    const handle = c.narrative.handles.find((h) => h.factId === 'f-vega')!;
    const broken: Narrative = {
      text: c.narrative.text.slice(0, handle.start) + '-4,200' + c.narrative.text.slice(handle.end),
      handles: c.narrative.handles.map((h) => ({ ...h })),
    };
    const board = boardWithFacts();
    board.charge(99, 0);
    const result = await joinAndReconcile(board, {
      narrative: () => broken,
      cells: () => c.cells,
      documents: c.documents,
      rerunCostCents: 5,
      rerunScribe: () => c.narrative,
    });
    expect(result.ok).toBe(false);
    expect(board.openQuestions().join(' ')).toContain('Raise it?');
  });

  it('patches the draft mechanically when no Scribe is available to rerun', async () => {
    const c = baseline();
    const handle = c.narrative.handles.find((h) => h.factId === 'f-vega')!;
    const broken: Narrative = {
      text: c.narrative.text.slice(0, handle.start) + '-4,200' + c.narrative.text.slice(handle.end),
      handles: c.narrative.handles.map((h) => ({ ...h })),
    };
    const result = await joinAndReconcile(boardWithFacts(), {
      narrative: () => broken,
      cells: () => c.cells,
      documents: c.documents,
    });
    expect(result.ok).toBe(true);
    expect(result.narrative.text).toContain('-3,870');
  });
});

describe('the run as a whole', () => {
  it('reaches a join that fails and says so in the transcript', async () => {
    const c = baseline();
    const board = planned();
    for (const fact of c.facts) {
      const { contested: _c, at: _a, ...rest } = fact;
      board.assert(rest);
    }
    const handle = c.narrative.handles.find((h) => h.factId === 'f-delta')!;
    const broken: Narrative = {
      text: c.narrative.text.slice(0, handle.start) + '99,999' + c.narrative.text.slice(handle.end),
      handles: c.narrative.handles.map((h) => ({ ...h })),
    };
    const result = await run({
      board,
      agents: agents([]),
      join: {
        narrative: () => broken,
        cells: () => c.cells,
        documents: c.documents,
        rerunScribe: () => broken,
      },
    });
    expect(result.join?.ok).toBe(false);
    expect(board.transcript().some((m) => m.kind === 'conflict')).toBe(true);
  });
});
