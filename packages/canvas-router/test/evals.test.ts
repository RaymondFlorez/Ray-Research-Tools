import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, modelById, type Model } from '../src/policy.js';
import {
  MIN_ITEMS,
  NotDeterministic,
  assertPinned,
  labelAgreement,
  rewrite,
  runEval,
  staleForModelChange,
  type GoldenItem,
  type GoldenSet,
  type PinnedDispatch,
} from '../src/evals.js';

const frontierA = modelById(DEFAULT_POLICY, 'frontier-a')!;
const open70 = modelById(DEFAULT_POLICY, 'open-70b')!;

/** A mechanically-scored set: the reference result is the reference result. */
function sqlSet(items: number, version = '1.0.0'): GoldenSet {
  return {
    taskClass: 'sql.generate',
    version,
    items: Array.from({ length: items }, (_, i): GoldenItem => ({
      id: `q${i}`,
      input: `question ${i}`,
      expected: i,
    })),
    score: (answer, item) => (answer === item.expected ? 1 : 0),
  };
}

/** A double-labeled set, where two analysts do not always agree. */
function subtextSet(items: number, agreement: number): GoldenSet {
  return {
    taskClass: 'sentiment.subtext',
    version: '1.0.0',
    items: Array.from({ length: items }, (_, i): GoldenItem => {
      // Exactly round(agreement * items) agree, so the fixture delivers the
      // share it advertises rather than one that depends on the item count.
      const agreed = i < Math.round(agreement * items);
      return { id: `s${i}`, input: `span ${i}`, expected: 1, secondLabel: agreed ? 1 : 0 };
    }),
    score: (answer, item) => (answer === item.expected ? 1 : 0),
  };
}

/**
 * A model that answers exactly the advertised share correctly.
 *
 * The first version used `index % 100 < share * 100`, which delivers the
 * advertised share only when the set size is a multiple of 100 — on a
 * 180-item set a nominal 0.85 came out at 0.92, and the test that was meant to
 * show a score *below* the label ceiling showed one above it. The fixture has
 * to hit the number it claims or it is testing something else.
 */
function answerer(shareByModel: Record<string, number>, total: number) {
  return (model: Model, item: GoldenItem) => {
    const share = shareByModel[model.id] ?? 0;
    const index = Number.parseInt(item.id.replace(/\D/g, ''), 10);
    return index < Math.round(share * total) ? item.expected : '__wrong__';
  };
}

describe('the harness measures what it claims to', () => {
  it('scores each model on each set and reports a standard error', async () => {
    const run = await runEval(
      [frontierA, open70],
      [sqlSet(200)],
      answerer({ 'frontier-a': 0.96, 'open-70b': 0.9 }, 200),
      '2026-03-11T00:00:00Z',
    );
    const a = run.scores.find((s) => s.modelId === 'frontier-a')!;
    const b = run.scores.find((s) => s.modelId === 'open-70b')!;
    expect(a.quality).toBeCloseTo(0.96, 2);
    expect(b.quality).toBeCloseTo(0.9, 2);
    expect(a.standardError).toBeGreaterThan(0);
    expect(a.standardError).toBeLessThan(0.05);
  });

  it('records which version of each set produced the run', async () => {
    const run = await runEval([frontierA], [sqlSet(50, '2.1.0')], answerer({ 'frontier-a': 1 }, 50));
    expect(run.setVersions['sql.generate']).toBe('2.1.0');
  });
});

describe('label ceilings', () => {
  // "180 subtext items scored by two analysts". Where two humans disagree
  // there is no single right answer for a model to find.
  it('measure how often the two raters agreed', () => {
    expect(labelAgreement(subtextSet(100, 0.72))).toBeCloseTo(0.72, 6);
    expect(labelAgreement(subtextSet(180, 0.72))).toBeCloseTo(0.72, 2);
  });

  it('are undefined for a set with a mechanical ground truth', () => {
    expect(labelAgreement(sqlSet(50))).toBeUndefined();
  });

  // A model scoring 0.85 against one rater's labels, on a set where the raters
  // agree 0.72 of the time, is partly measuring which rater graded it.
  it('caveat a score that exceeds what the labels can see', async () => {
    const run = await runEval([frontierA], [subtextSet(180, 0.72)], answerer({ 'frontier-a': 0.85 }, 180));
    const score = run.scores[0]!;
    expect(score.labelCeiling).toBeCloseTo(0.72, 2);
    expect(score.caveat).toContain('not skill the labels can see');
  });

  it('leave a score below the ceiling uncaveated', async () => {
    const run = await runEval([frontierA], [subtextSet(180, 0.9)], answerer({ 'frontier-a': 0.85 }, 180));
    expect(run.scores[0]?.caveat).toBeUndefined();
  });
});

describe('rewriting the policy', () => {
  // policy.ts opens by saying the table "lives in a versioned routing policy
  // document that the eval harness rewrites". This is that function.
  it('writes measured quality into a new policy and bumps the version', async () => {
    const run = await runEval(
      [frontierA, open70],
      [sqlSet(200)],
      answerer({ 'frontier-a': 0.91, 'open-70b': 0.93 }, 200),
      '2026-03-11T00:00:00Z',
    );
    const result = rewrite(DEFAULT_POLICY, run);

    expect(result.policy.version).not.toBe(DEFAULT_POLICY.version);
    expect(result.policy.updatedAt).toBe('2026-03-11');
    const updated = modelById(result.policy, 'frontier-a')!;
    expect(updated.quality['sql.generate']).toBeCloseTo(0.91, 2);
    // The measured numbers can move a model down as well as up.
    const change = result.changes.find((c) => c.modelId === 'frontier-a')!;
    expect(change.from).toBe(0.96);
    expect(change.delta).toBeLessThan(0);
  });

  // A routing table that changes under a dispatcher mid-request is a table
  // nobody can reason about.
  it('returns a new policy rather than mutating the old one', async () => {
    const before = modelById(DEFAULT_POLICY, 'frontier-a')!.quality['sql.generate'];
    const run = await runEval([frontierA], [sqlSet(200)], answerer({ 'frontier-a': 0.5 }, 200));
    rewrite(DEFAULT_POLICY, run);
    expect(modelById(DEFAULT_POLICY, 'frontier-a')!.quality['sql.generate']).toBe(before);
  });

  // A model scored on six items has a standard error around 0.2. Promoting it
  // over a rival on that basis is a coin flip wearing a decimal point.
  it('refuses to write a number from too few items, and says so', async () => {
    const run = await runEval([frontierA], [sqlSet(MIN_ITEMS - 1)], answerer({ 'frontier-a': 1 }, MIN_ITEMS - 1));
    const result = rewrite(DEFAULT_POLICY, run);
    expect(result.changes).toEqual([]);
    expect(result.skipped[0]?.reason).toContain(`below the ${MIN_ITEMS}`);
    expect(modelById(result.policy, 'frontier-a')!.quality['sql.generate']).toBe(0.96);
  });

  it('skips a model the policy has never heard of', async () => {
    const stranger: Model = { ...frontierA, id: 'frontier-z' };
    const run = await runEval([stranger], [sqlSet(200)], answerer({ 'frontier-z': 0.9 }, 200));
    const result = rewrite(DEFAULT_POLICY, run);
    expect(result.skipped[0]?.reason).toBe('not in the policy');
  });

  it('adds a class a model had never been tested on', async () => {
    const run = await runEval([open70], [sqlSet(200)], answerer({ 'open-70b': 0.8 }, 200));
    // open-70b has no `asr` score; write one for a class it does have to keep
    // the check honest, then confirm a genuinely new class lands as NaN delta.
    const fresh: GoldenSet = { ...sqlSet(200), taskClass: 'asr' };
    const asrRun = await runEval([open70], [fresh], answerer({ 'open-70b': 0.8 }, 200));
    const result = rewrite(rewrite(DEFAULT_POLICY, run).policy, asrRun);
    const change = result.changes.find((c) => c.taskClass === 'asr')!;
    expect(change.from).toBeUndefined();
    expect(Number.isNaN(change.delta)).toBe(true);
    expect(modelById(result.policy, 'open-70b')!.quality.asr).toBeCloseTo(0.8, 2);
  });
});

describe('determinism on a compute path', () => {
  const pinned: PinnedDispatch = {
    nodeId: 'n1',
    modelId: 'frontier-a',
    modelVersion: '2026-02-01',
    temperature: 0,
    seed: 7,
  };

  it('needs all three pins; any one missing is not a pin', () => {
    expect(() => assertPinned(pinned)).not.toThrow();
    expect(() => assertPinned({ ...pinned, modelVersion: '' })).toThrow(NotDeterministic);
    expect(() => assertPinned({ ...pinned, temperature: 0.2 })).toThrow(NotDeterministic);
    expect(() => assertPinned({ ...pinned, seed: Number.NaN })).toThrow(NotDeterministic);
  });

  // "so the analyst knows a number moved because the model changed, not
  // because the market did" — the reason is the feature, not the staleness.
  it('marks pinned nodes stale with a reason that names the cause', () => {
    const stale = staleForModelChange(
      [pinned, { ...pinned, nodeId: 'n2' }, { ...pinned, nodeId: 'n3', modelId: 'open-70b' }],
      'frontier-a',
      '2026-04-01',
    );
    expect(stale.map((s) => s.nodeId)).toEqual(['n1', 'n2']);
    expect(stale[0]?.reason).toContain('the model changed, not the market');
    expect(stale[0]?.was).toBe('2026-02-01');
    expect(stale[0]?.now).toBe('2026-04-01');
  });

  it('leaves a node already on the new version alone', () => {
    expect(staleForModelChange([pinned], 'frontier-a', '2026-02-01')).toEqual([]);
  });
});
