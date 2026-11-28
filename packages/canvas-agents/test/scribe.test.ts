import { describe, expect, it } from 'vitest';
import { Blackboard } from '../src/blackboard.js';
import { run } from '../src/coordinator.js';
import type { CellReading } from '../src/reconciler.js';
import { modelScribe, readCitations } from '../src/scribe.js';

describe('reading a model\'s citations', () => {
  it('puts a handle over the number before each marker and takes the marker out', () => {
    const n = readCitations('The sleeve loses $396,629 [sleeve:pnl] if rates rise 50 [sleeve:shock] basis points.');
    expect(n.text).toBe('The sleeve loses $396,629 if rates rise 50 basis points.');
    expect(n.handles.map((h) => [h.factId, n.text.slice(h.start, h.end)])).toEqual([
      ['sleeve:pnl', '396,629'],
      ['sleeve:shock', '50'],
    ]);
  });

  it('leaves an uncited number uncovered, and a marker with no number covering nothing', () => {
    const n = readCitations('Over 10 years [sleeve:pnl] it loses money [sleeve:base], about 4% a year.');
    expect(n.handles).toEqual([
      { factId: 'sleeve:pnl', start: 5, end: 7 },
      { factId: 'sleeve:base', start: n.text.indexOf(', about'), end: n.text.indexOf(', about') },
    ]);
    expect(n.text).toBe('Over 10 years it loses money, about 4% a year.');
  });

  it('keeps digits inside a marker out of the text', () => {
    expect(readCitations('The 10-year yield is 4.94 [rates:UST.par.10Y].').text).toBe('The 10-year yield is 4.94.');
  });
});

// A scripted stand-in for the model, so the join's rounds can be checked exactly.
const scripted = (answers: string[]) => {
  const prompts: string[] = [];
  return { prompts, complete: async (_system: string, user: string) => { prompts.push(user); return answers.shift() ?? ''; } };
};

const setup = () => {
  const board = new Blackboard('t', 'What does +50bp do to the sleeve?', 100);
  board.setPlan([{ id: 'scribe', description: 'write it up', agent: 'scribe', dependsOn: [], budgetCents: 1 }]);
  const cells: CellReading[] = [
    { nodeId: 'sleeve/sleeve', cacheKey: 'k', port: 'pnl', label: 'P&L', value: -396_629.47, unit: 'usd', asof: '2026-11-27' },
    { nodeId: 'sleeve/sleeve', cacheKey: 'k', port: 'shock', label: 'shock', value: 50, unit: 'bps', asof: '2026-11-27' },
  ];
  for (const c of cells) {
    board.assert({ id: `sleeve:${c.port}`, claim: c.label, value: { number: c.value, unit: c.unit, asof: c.asof }, provenance: { kind: 'cell', nodeId: c.nodeId, cacheKey: c.cacheKey, port: c.port! }, confidence: 1, assertedBy: 'simulator' });
  }
  return { board, cells };
};

describe('a model Scribe at the join', () => {
  it('passes a draft whose every number traces to its cell', async () => {
    const { board, cells } = setup();
    const model = scripted(['A 50 [sleeve:shock] basis point rise changes the sleeve by -$396,629 [sleeve:pnl].']);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl', 'sleeve:shock'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent }, join: scribe.join });
    expect(result.join?.ok).toBe(true);
    expect(result.join?.attempts).toBe(1);
    expect(model.prompts[0]).toContain('[sleeve:pnl] P&L: -396629.47 usd');
  });

  it('hands a mistyped number back with its correction, and passes the rewrite', async () => {
    const { board, cells } = setup();
    const model = scripted([
      'A 50 [sleeve:shock] basis point rise changes the sleeve by -$369,629 [sleeve:pnl].',
      'A 50 [sleeve:shock] basis point rise changes the sleeve by -$396,629 [sleeve:pnl].',
    ]);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl', 'sleeve:shock'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent }, join: scribe.join });
    expect(result.join?.rounds[0]?.map((f) => f.kind)).toEqual(['transcription']);
    expect(model.prompts[1]).toContain('you wrote -$369,629 for [sleeve:pnl]; it is -$396,629');
    expect([result.join?.ok, result.join?.attempts]).toEqual([true, 2]);
  });

  // A writer can drop a number it had no source for, which a patch cannot.
  it('hands back a number with no source, and passes the rewrite that leaves it out', async () => {
    const { board, cells } = setup();
    const model = scripted([
      'Over 10 years the sleeve moves -$396,629 [sleeve:pnl] on a 50 [sleeve:shock] basis point move.',
      'The sleeve moves -$396,629 [sleeve:pnl] on a 50 [sleeve:shock] basis point move.',
    ]);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl', 'sleeve:shock'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent }, join: scribe.join });
    expect(result.join?.rounds[0]?.map((f) => f.kind)).toEqual(['unsourced']);
    expect(model.prompts[1]).toContain('you wrote 10 with no fact behind it');
    expect([result.join?.ok, result.join?.attempts]).toEqual([true, 2]);
  });

  it('fails the join when the rewrites keep a number with no source', async () => {
    const { board, cells } = setup();
    const draft = 'Over 10 years the sleeve moves -$396,629 [sleeve:pnl] on a 50 [sleeve:shock] basis point move.';
    const model = scripted([draft, draft, draft]);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl', 'sleeve:shock'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent }, join: scribe.join });
    expect([result.join?.ok, result.join?.attempts]).toEqual([false, 3]);
    expect(result.join?.findings.map((f) => f.kind)).toEqual(['unsourced']);
  });

  // "Loses" carries the sign; the reconciler reads it as the minus it is.
  it('passes a loss written as a fall of its magnitude', async () => {
    const { board, cells } = setup();
    const model = scripted(['The sleeve loses $396,629 [sleeve:pnl] on a 50 [sleeve:shock] basis point rise.']);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl', 'sleeve:shock'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent }, join: scribe.join });
    expect([result.join?.ok, result.join?.attempts]).toEqual([true, 1]);
  });

  it('hands back a gain written as a loss, and keeps the draft when the rewrite is empty', async () => {
    const { board, cells } = setup();
    cells[1]!.value = 50;
    const gain = new Blackboard('t', 'q', 100);
    gain.setPlan([{ id: 'scribe', description: 'write', agent: 'scribe', dependsOn: [], budgetCents: 1 }]);
    gain.assert({ id: 'sleeve:pnl', claim: 'P&L', value: { number: 396_629.47, unit: 'usd', asof: '2026-11-27' }, provenance: { kind: 'cell', nodeId: 'sleeve/sleeve', cacheKey: 'k', port: 'pnl' }, confidence: 1, assertedBy: 'simulator' });
    const gainCells: CellReading[] = [{ ...cells[0]!, value: 396_629.47 }];
    const model = scripted(['The sleeve loses $396,629 [sleeve:pnl].', '']);
    const scribe = modelScribe({ complete: model.complete, factIds: ['sleeve:pnl'], cells: () => gainCells });
    const result = await run({ board: gain, agents: { scribe: scribe.agent }, join: scribe.join });
    expect(result.join?.rounds[0]?.map((f) => f.kind)).toEqual(['transcription']);
    expect(model.prompts[1]).toContain('[sleeve:pnl] is a gain, not a loss');
    expect(result.join?.ok).toBe(false);
    expect(result.join?.narrative.text).toBe('The sleeve loses $396,629.');
    void board;
  });

  it('fails its step on a draft that cites nothing', async () => {
    const { board, cells } = setup();
    const scribe = modelScribe({ complete: scripted(['Rates went up, which is bad for bonds.']).complete, factIds: ['sleeve:pnl'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent } });
    expect(result.failed).toEqual(['scribe']);
    expect(board.step('scribe')?.note).toContain('the draft cites none of sleeve:pnl');
  });

  it('fails its step when a fact it was told to use is missing', async () => {
    const { board, cells } = setup();
    const scribe = modelScribe({ complete: scripted(['x']).complete, factIds: ['sleeve:vega'], cells: () => cells });
    const result = await run({ board, agents: { scribe: scribe.agent } });
    expect(result.failed).toEqual(['scribe']);
    expect(board.step('scribe')?.note).toBe('the answer needs sleeve:vega, which is not on the board');
  });
});
