import { describe, expect, it } from 'vitest';
import { BitemporalStore, detectRestatementLeak, type Fact } from '../src/bitemporal.js';

/** Q3 revenue: reported in October, restated in February, restated again a year on. */
function revenue(): BitemporalStore<number> {
  const store = new BitemporalStore<number>();
  const facts: Array<Fact<number>> = [
    { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-10-24', value: 18.12 },
    {
      key: 'NVDA.revenue',
      validTime: '2024-09-30',
      knowledgeTime: '2025-02-14',
      value: 17.94,
      restatement: true,
    },
    {
      key: 'NVDA.revenue',
      validTime: '2024-09-30',
      knowledgeTime: '2025-10-01',
      value: 17.88,
      restatement: true,
    },
    { key: 'NVDA.revenue', validTime: '2024-12-31', knowledgeTime: '2025-01-28', value: 22.10 },
  ];
  store.appendAll(facts);
  return store;
}

describe('point-in-time reads', () => {
  it('returns the number that was on the tape, not the one that replaced it', () => {
    const store = revenue();

    // Standing in November 2024, only the original report exists.
    expect(store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2024-11-01' })).toEqual([
      { validTime: '2024-09-30', value: 18.12, knownAt: '2024-10-24' },
    ]);

    // Standing in March 2025, the first restatement is in force.
    const march = store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2025-03-01' });
    expect(march.find((o) => o.validTime === '2024-09-30')?.value).toBe(17.94);

    // Today, the second.
    expect(
      store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2026-01-01' })
        .find((o) => o.validTime === '2024-09-30')?.value,
    ).toBe(17.88);
  });

  it('shows nothing before the fact was known', () => {
    const store = revenue();
    // The quarter had ended, but nobody had reported it yet.
    expect(store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2024-10-01' })).toEqual([]);
  });

  it('does not show a later quarter to an earlier reader', () => {
    const store = revenue();
    const asOfNovember = store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2024-11-01' });
    expect(asOfNovember.map((o) => o.validTime)).toEqual(['2024-09-30']);
  });

  it('is stable: the same read twice is the same answer', () => {
    const store = revenue();
    const first = store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2024-11-01' });
    // A restatement arrives after the first read.
    store.append({
      key: 'NVDA.revenue',
      validTime: '2024-09-30',
      knowledgeTime: '2026-06-01',
      value: 17.5,
      restatement: true,
    });
    expect(store.asOf({ key: 'NVDA.revenue', knowledgeTime: '2024-11-01' })).toEqual(first);
  });

  it('never edits or deletes: a correction is another record', () => {
    const store = revenue();
    const history = store.history('NVDA.revenue', '2024-09-30');
    expect(history.map((f) => f.value)).toEqual([18.12, 17.94, 17.88]);
    expect(history.map((f) => f.knowledgeTime)).toEqual([
      '2024-10-24',
      '2025-02-14',
      '2025-10-01',
    ]);
  });

  it('bounds the valid-time window', () => {
    const store = revenue();
    const q4Only = store.asOf({
      key: 'NVDA.revenue',
      knowledgeTime: '2026-01-01',
      from: '2024-10-01',
    });
    expect(q4Only.map((o) => o.validTime)).toEqual(['2024-12-31']);
  });

  it('reads the value in force at a date', () => {
    const store = revenue();
    const observation = store.valueAt('NVDA.revenue', '2024-11-15', '2024-12-01');
    expect(observation?.validTime).toBe('2024-09-30');
    expect(observation?.value).toBe(18.12);
  });

  it('returns nothing for an unknown key rather than throwing', () => {
    const store = revenue();
    expect(store.asOf({ key: 'nope', knowledgeTime: '2026-01-01' })).toEqual([]);
    expect(store.valueAt('nope', '2024-01-01', '2026-01-01')).toBeUndefined();
    expect(store.history('nope', '2024-01-01')).toEqual([]);
  });

  it('takes the later append when two records share a knowledge time', () => {
    const store = new BitemporalStore<number>();
    store.append({ key: 'k', validTime: '2024-01-01', knowledgeTime: '2024-01-02', value: 1 });
    store.append({ key: 'k', validTime: '2024-01-01', knowledgeTime: '2024-01-02', value: 2 });
    // An intra-instant correction is still a correction.
    expect(store.asOf({ key: 'k', knowledgeTime: '2024-02-01' })[0]?.value).toBe(2);
  });
});

describe('restatement leak detection', () => {
  it('names exactly what a backtest using today’s data would have got wrong', () => {
    const store = revenue();
    const report = detectRestatementLeak(store, 'NVDA.revenue', '2024-11-01', '2026-01-01');

    expect(report.differences).toEqual([
      { validTime: '2024-09-30', pointInTime: 18.12, latest: 17.88 },
    ]);
  });

  it('reports nothing when a series has never been restated', () => {
    const store = new BitemporalStore<number>();
    store.append({ key: 'clean', validTime: '2024-01-01', knowledgeTime: '2024-01-02', value: 5 });
    expect(detectRestatementLeak(store, 'clean', '2024-06-01', '2026-01-01').differences).toEqual([]);
  });

  it('lists which valid times were ever restated, and how many times', () => {
    expect(revenue().restatements('NVDA.revenue')).toEqual([
      { validTime: '2024-09-30', versions: 3 },
    ]);
  });

  it('knows its own effective now', () => {
    expect(revenue().latestKnowledgeTime).toBe('2025-10-01');
    expect(new BitemporalStore().latestKnowledgeTime).toBeUndefined();
  });
});
