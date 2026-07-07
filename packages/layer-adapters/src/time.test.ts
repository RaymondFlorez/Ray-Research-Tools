import { describe, expect, it } from 'vitest';
import { filterByTime, withinTime } from './time';

describe('withinTime', () => {
  it('keeps rows inside an explicit range', () => {
    expect(withinTime('2026-03-01', ['2026-01-01', '2026-06-30'], null)).toBe(true);
    expect(withinTime('2026-09-01', ['2026-01-01', '2026-06-30'], null)).toBe(false);
  });

  it('keeps rows at or before the cursor when only current is set', () => {
    expect(withinTime('2026-01-01', null, '2026-06-01')).toBe(true);
    expect(withinTime('2026-12-01', null, '2026-06-01')).toBe(false);
  });

  it('fails open for missing or unparseable timestamps', () => {
    expect(withinTime(null, ['2026-01-01', '2026-06-30'], null)).toBe(true);
    expect(withinTime('not-a-date', ['2026-01-01', '2026-06-30'], null)).toBe(true);
  });
});

describe('filterByTime', () => {
  const rows = [
    { id: 'a', ts: '2026-01-15' },
    { id: 'b', ts: '2026-05-20' },
    { id: 'c', ts: '2026-11-02' },
  ];

  it('filters an array by a timestamp field and range', () => {
    const kept = filterByTime(rows, 'ts', ['2026-01-01', '2026-06-30'], null);
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
