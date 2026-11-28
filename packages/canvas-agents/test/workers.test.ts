import { describe, expect, it } from 'vitest';
import { classifiedSource, type ClassifiedFact, type PointInTimeSource } from '@picasso/canvas-data';
import type { CurveEngine } from '@picasso/canvas-pricing';
import { Blackboard } from '../src/blackboard.js';
import { run } from '../src/coordinator.js';
import { curveShockAgent, factId, inputFact, parInstruments, retrievalAgent } from '../src/workers.js';

// Illustrative values, not a published curve: the refusals are what is under test.
const facts: ClassifiedFact[] = [
  { key: 'UST.par.2Y', validTime: '2026-11-20', knowledgeTime: '2026-11-21T05:00:00Z', value: 3.9, dataClass: 'public', source: 'test' },
  { key: 'UST.par.2Y', validTime: '2026-11-23', knowledgeTime: '2026-11-24T05:00:00Z', value: 3.95, dataClass: 'public', source: 'test' },
  { key: 'UST.par.5Y', validTime: '2026-11-23', knowledgeTime: '2026-11-24T05:00:00Z', value: 4.1, dataClass: 'public', source: 'test' },
  { key: 'VND.close', validTime: '2026-11-23', knowledgeTime: '2026-11-24T05:00:00Z', value: 101.5, dataClass: 'licensed', vendor: 'acme', source: 'test' },
];
const open = classifiedSource(facts, { userId: 'pm', tenantId: 't', vendors: new Set(['acme']), positions: true, mnpi: false });
const unlicensed = classifiedSource(facts, { userId: 'intern', tenantId: 't', vendors: new Set(), positions: false, mnpi: false });

const board = (steps: Array<{ id: string; dependsOn?: string[]; agent?: 'retriever' | 'quant' }>) => {
  const b = new Blackboard('t', 'q', 100);
  b.setPlan(steps.map((s) => ({ id: s.id, description: s.id, agent: s.agent ?? 'retriever', dependsOn: s.dependsOn ?? [], budgetCents: 1 })));
  return b;
};

describe('the retriever', () => {
  it('asserts the latest period known at the knowledge time, as a cell on the tile it materializes', async () => {
    const b = board([{ id: 'rates' }]);
    const agent = retrievalAgent({ source: open, knowledgeTime: '2026-11-22T00:00:00Z', keys: [{ key: 'UST.par.2Y', unit: 'pct' }] });
    const result = await run({ board: b, agents: { rates: agent } });
    expect(result.completed).toEqual(['rates']);
    const fact = b.fact(factId('rates', 'UST.par.2Y'));
    // The 23 November print was not known on the 22nd.
    expect(fact?.value).toEqual({ number: 3.9, unit: 'pct', asof: '2026-11-20' });
    expect(fact?.provenance).toMatchObject({ kind: 'cell', nodeId: 'rates/UST.par.2Y' });
    expect(b.artifacts()).toEqual([{ nodeId: 'rates/UST.par.2Y', kind: 'DataTile', createdBy: 'retriever' }]);
  });

  it('reads the same with and without a batched source', async () => {
    const single: PointInTimeSource = { name: open.name, read: open.read };
    const read = async (source: PointInTimeSource) => {
      const b = board([{ id: 'r' }]);
      await run({ board: b, agents: { r: retrievalAgent({ source, knowledgeTime: '2026-11-25T00:00:00Z', keys: [{ key: 'UST.par.2Y', unit: 'pct' }, { key: 'UST.par.5Y', unit: 'pct' }] }) } });
      return b.facts().map((f) => [f.id, f.value, f.provenance]);
    };
    const batched: PointInTimeSource = { ...single, readMany: async (keys, k) => new Map(await Promise.all(keys.map(async (key) => [key, await single.read({ key, knowledgeTime: k })] as const))) };
    expect(await read(batched)).toEqual(await read(single));
  });

  it('fails on a withheld key, so nothing downstream prices on part of its inputs', async () => {
    const b = board([{ id: 'market' }, { id: 'price', dependsOn: ['market'], agent: 'quant' }]);
    const agent = retrievalAgent({ source: unlicensed, knowledgeTime: '2026-11-25T00:00:00Z', keys: [{ key: 'UST.par.2Y', unit: 'pct' }, { key: 'VND.close', unit: 'usd' }] });
    const result = await run({ board: b, agents: { market: agent, price: () => ({}) } });
    expect(result.failed).toEqual(['market']);
    expect(result.skipped).toEqual(['price']);
    expect(b.step('market')?.note).toMatch(/read 1 of 2 .*VND\.close is withheld/);
    // What it could read is still true, and still on the board.
    expect(b.fact(factId('market', 'UST.par.2Y'))?.value?.number).toBe(3.95);
    expect(b.fact(factId('market', 'VND.close'))).toBeUndefined();
  });

  it('fails on a key with nothing known yet', async () => {
    const b = board([{ id: 'r' }]);
    const result = await run({ board: b, agents: { r: retrievalAgent({ source: open, knowledgeTime: '2020-01-01T00:00:00Z', keys: [{ key: 'UST.par.2Y', unit: 'pct' }] }) } });
    expect(result.failed).toEqual(['r']);
    expect(b.step('r')?.note).toContain('no value known at 2020-01-01T00:00:00Z');
  });
});

describe('a pricer\'s inputs', () => {
  const seeded = () => {
    const b = board([{ id: 'a' }, { id: 'b' }, { id: 'price', dependsOn: ['a'], agent: 'quant' }]);
    const at = (id: string, number: number) =>
      b.assert({ id: factId(id, 'UST.par.2Y'), claim: 'UST.par.2Y, latest known', value: { number, unit: 'pct', asof: '2026-11-23' }, provenance: { kind: 'cell', nodeId: `${id}/x`, cacheKey: id }, confidence: 1, assertedBy: 'retriever' });
    return { b, at };
  };

  it('come only from the steps it depends on', () => {
    const { b, at } = seeded();
    at('b', 3.95);
    expect(() => inputFact(b, b.step('price')!, 'UST.par.2Y')).toThrow('needs UST.par.2Y, which none of a retrieved');
    at('a', 3.95);
    expect(inputFact(b, b.step('price')!, 'UST.par.2Y').id).toBe('a:UST.par.2Y');
  });

  it('are refused while contested', () => {
    const { b, at } = seeded();
    at('a', 3.95);
    at('b', 4.4);
    expect(b.conflicts()).toHaveLength(1);
    expect(() => inputFact(b, b.step('price')!, 'UST.par.2Y')).toThrow(/contested/);
  });

  it('are refused in the wrong unit, before anything is priced', async () => {
    const b = board([{ id: 'rates' }, { id: 'sleeve', dependsOn: ['rates'], agent: 'quant' }]);
    const curves = {} as CurveEngine; // never reached
    const result = await run({
      board: b,
      agents: {
        rates: retrievalAgent({ source: open, knowledgeTime: '2026-11-25T00:00:00Z', keys: [{ key: 'UST.par.2Y', unit: 'bps' }] }),
        sleeve: curveShockAgent({ curves, points: [{ key: 'UST.par.2Y', years: 2 }], book: [{ id: 'n', flows: [[2, 100]], quantity: 1 }], shock: { shape: 'parallel', bps: 50 } }),
      },
    });
    expect(result.failed).toEqual(['sleeve']);
    expect(b.step('sleeve')?.note).toBe('UST.par.2Y is in bps; a par yield is read in pct');
  });
});

describe('par yields to instruments', () => {
  it('sorts by maturity and splits at a year, in decimal', () => {
    expect(parInstruments([{ years: 5, pct: 4.1 }, { years: 0.25, pct: 4.3 }, { years: 1, pct: 4 }])).toEqual([
      { kind: 'deposit', maturity: 0.25, rate: 0.043 },
      { kind: 'deposit', maturity: 1, rate: 0.04 },
      { kind: 'swap', maturity: 5, rate: 0.040999999999999995, frequency: 2 },
    ]);
  });
});
