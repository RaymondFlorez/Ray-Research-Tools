import { describe, expect, it } from 'vitest';
import { History, IncompleteHistory, loadHistory, type VersionSource } from '../src/pointInTime.js';

const source = (withheld = false): VersionSource => ({
  versions: async (key) => ({
    versions: key === 'NVDA.revenue'
      ? [
          { validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04 },
          { validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87 },
        ]
      : [{ validTime: '2024-08-05', knowledgeTime: '2024-08-05', value: 1010 }],
    withheld: withheld && key === 'NVDA.revenue'
      ? [{ validTime: '2024-06-30', knowledgeTime: '2025-11-19', decision: { message: 'Requires a vendor-b licence.' } }]
      : [],
  }),
});

describe('loadHistory', () => {
  it('loads every version, so each bar sees only what was known on it', async () => {
    const history = await loadHistory(source(), ['NVDA.revenue', 'price:NVDA']);
    expect(history.viewAt('2024-08-05').latest('NVDA.revenue')).toBe(30.04);
    expect(history.viewAt('2025-03-01').latest('NVDA.revenue')).toBe(29.87);
    expect(history.dates()).toEqual(['2024-06-30', '2024-08-05']);
  });

  it('refuses a history with anything withheld, rather than run on the rest', async () => {
    await expect(loadHistory(source(true), ['NVDA.revenue'])).rejects.toThrow(IncompleteHistory);
    await expect(loadHistory(source(true), ['NVDA.revenue'])).rejects.toThrow(/2024-06-30 known 2025-11-19: Requires a vendor-b licence/);
  });
});

describe('which version a bar sees', () => {
  it('is the newest known, whatever order the versions were added in', () => {
    const history = new History();
    history.add('x', { validTime: '2024-01-02', knowledgeTime: '2024-03-01', value: 2 });
    history.add('x', { validTime: '2024-01-02', knowledgeTime: '2024-01-02', value: 1 });
    expect(history.viewAt('2024-04-01').window('x', 1)).toEqual([2]);
    expect(history.viewAt('2024-04-01').latest('x')).toBe(2);
    expect(history.viewAt('2024-02-01').window('x', 1)).toEqual([1]);
    expect(history.actualAt('x', '2024-01-02')).toBe(2);
  });

  it('is the later one when two are known at the same instant, as in the point-in-time store', () => {
    const history = new History();
    history.add('x', { validTime: '2024-01-02', knowledgeTime: '2024-01-02', value: 1 });
    history.add('x', { validTime: '2024-01-02', knowledgeTime: '2024-01-02', value: 2 });
    const view = history.viewAt('2024-01-02');
    expect([view.latest('x'), view.window('x', 1)[0], history.actualAt('x', '2024-01-02')]).toEqual([2, 2, 2]);
  });
});
