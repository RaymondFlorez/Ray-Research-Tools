import { describe, expect, it } from 'vitest';
import { readPlan } from '../src/planReader.js';
import { plan, scope } from '../src/query.js';

// Prices from the router's side, never the model's: a model step is 5 cents, anything else 1.
const estimate = ({ taskClass }: { taskClass?: string }) => (taskClass ? { cents: 5, ms: 3_000 } : { cents: 1, ms: 500 });
const ready = scope({ question: 'Read the call and stress the book', resolve: () => [] });

const proposed = [
  { id: 'retrieve', kind: 'retrieval', agent: 'retriever', description: 'pull the transcript', dependsOn: [] },
  { id: 'subtext', kind: 'reasoning', agent: 'extractor', taskClass: 'sentiment.subtext', description: 'read the Q&A', dependsOn: ['retrieve'], estimatedCents: 0.01 },
  { id: 'shock', kind: 'compute', agent: 'simulator', description: 'apply the rate shock', dependsOn: [], method: 'parallel' },
  { id: 'answer', kind: 'reasoning', agent: 'scribe', taskClass: 'synthesis.final', description: 'write it up', dependsOn: ['subtext', 'shock'] },
];
const reply = (steps: unknown) => `Here is the plan:\n\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\`\nLet me know.`;

describe('reading a model\'s plan', () => {
  it('reads a plan wrapped in prose and a fence, and prices it from the router, not the model', () => {
    const r = readPlan(reply(proposed), { estimate });
    expect(r.problems).toEqual([]);
    expect(r.steps.map((s) => [s.id, s.estimatedCents])).toEqual([['retrieve', 1], ['subtext', 5], ['shock', 1], ['answer', 5]]);
    expect(r.steps[2]!.method).toBe('parallel');
    const p = plan({ scope: ready, author: { kind: 'model', model: 'a model' }, steps: r.steps });
    expect([p.totalCents, p.estimatedMs, p.warnings, p.needsApproval]).toEqual([12, 6_500, [], true]);
  });

  it('names every fault and runs none of a plan that has one', () => {
    const bad = [
      { id: 'a', kind: 'retrieval', agent: 'librarian', description: 'x', dependsOn: [] },
      { id: 'b', kind: 'reasoning', agent: 'scribe', description: 'y', dependsOn: ['a', 'zz'] },
      { id: 'b', kind: 'guess', agent: 'quant', description: '', dependsOn: ['b'] },
      { id: 'c', kind: 'reasoning', agent: 'scribe', taskClass: 'poetry', description: 'z', dependsOn: [] },
    ];
    const r = readPlan(reply(bad), { estimate });
    expect(r.steps).toEqual([]);
    expect(r.problems).toEqual([
      'step 1 (a): agent "librarian" is not one of coordinator, retriever, extractor, quant, simulator, critic, reconciler, scribe',
      'step 2 (b): a reasoning step names the taskClass it dispatches',
      'step 3 (b): the id is used twice',
      'step 3 (b): kind "guess" is not one of retrieval, compute, reasoning',
      'step 3 (b): no description',
      'step 4 (c): taskClass "poetry" is not one the router knows',
      'b depends on "zz", which is not a step',
      'b depends on itself',
    ]);
  });

  it('refuses a circle of dependencies, which would never start', () => {
    const circle = [
      { id: 'x', kind: 'compute', agent: 'quant', description: 'x', dependsOn: ['z'] },
      { id: 'y', kind: 'compute', agent: 'quant', description: 'y', dependsOn: ['x'] },
      { id: 'z', kind: 'compute', agent: 'quant', description: 'z', dependsOn: ['y'] },
    ];
    expect(readPlan(JSON.stringify(circle), { estimate }).problems).toEqual(['the steps x -> z -> y -> x depend on each other in a circle, so none of them can start']);
  });

  it('takes any short printable label as an id, as models write them, and still refuses a missing or duplicate one', () => {
    const numbered = proposed.map((s, i) => ({ ...s, id: String(i + 1), dependsOn: s.dependsOn.map((d) => String(proposed.findIndex((p) => p.id === d) + 1)) }));
    expect(readPlan(JSON.stringify(numbered), { estimate }).problems).toEqual([]);
    const blank = [{ ...proposed[0], id: '  ' }, { ...proposed[2], id: 'Step 1' }, { ...proposed[2], id: 'Step 1' }];
    expect(readPlan(JSON.stringify(blank), { estimate }).problems).toEqual([
      'step 1: id must be a printable label of 1 to 64 characters',
      'step 3 (Step 1): the id is used twice',
    ]);
  });

  it('says so when there is no plan at all', () => {
    expect(readPlan('I would first look at the transcript.', { estimate }).problems).toEqual(['no plan: the answer has no JSON list of steps']);
    expect(readPlan('{"steps": []}', { estimate }).problems).toEqual(['the plan has no steps']);
  });
});
