import { describe, expect, it } from 'vitest';
import {
  ALL_UP,
  LADDER,
  UntruthfulPresentation,
  active,
  present,
  rungFor,
  stillAnswers,
  type SystemHealth,
} from '../src/degradation.js';

const now = 1_772_000_000_000;

describe('the ladder', () => {
  it('has the PRD\'s six rungs in the PRD\'s order', () => {
    expect(LADDER.map((r) => r.subsystem)).toEqual([
      'frontier_vendor',
      'gpu_fleet',
      'realtime_feed',
      'warehouse',
      'collab',
      'sandbox',
    ]);
    expect(LADDER.map((r) => r.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // The card that lists what is degraded is read top to bottom. A list that
  // reorders itself by whichever subsystem failed most recently is a list
  // nobody learns to read.
  it('reports in its own order, not in failure order', () => {
    const health: SystemHealth = { ...ALL_UP, collab: 'down', frontier_vendor: 'degraded' };
    expect(active(health).map((r) => r.subsystem)).toEqual(['frontier_vendor', 'collab']);
  });

  it('gives every rung a badge, because silent substitution is the failure', () => {
    for (const rung of LADDER) {
      expect(rung.badge.trim()).not.toBe('');
      expect(rung.lost.trim()).not.toBe('');
    }
  });

  it('still answers with every model tier but one gone', () => {
    expect(stillAnswers({ ...ALL_UP, frontier_vendor: 'down' })).toBe(true);
    expect(stillAnswers({ ...ALL_UP, frontier_vendor: 'down', gpu_fleet: 'down' })).toBe(false);
  });
});

describe('the rule underneath all six', () => {
  // "The system never shows a number without telling the truth about where it
  // came from and how old it is."
  it('refuses a value with no source', () => {
    expect(() =>
      present(118.5, { source: '', asof: '2026-03-11T14:30:00Z', asofMs: now }, now),
    ).toThrow(UntruthfulPresentation);
  });

  it('refuses a value with no as-of', () => {
    expect(() =>
      present(118.5, { source: 'NVDA last trade', asof: '', asofMs: now }, now),
    ).toThrow(UntruthfulPresentation);
  });

  it('states the age in the caption, live or not', () => {
    const origin = { source: 'NVDA last trade', asof: '2026-03-11T14:30:00Z', asofMs: now };
    expect(present(118.5, origin, now).caption).toContain('live');
    expect(present(118.5, origin, now + 5 * 60_000).caption).toContain('5m old');
    expect(present(118.5, origin, now + 26 * 3_600_000).caption).toContain('26h old');
  });

  // Degrading changes the badge and the age. It never changes whether they
  // exist, which is the whole content of the rule.
  it('carries source and age on every rung of the ladder', () => {
    const origin = { source: 'NVDA last trade', asof: '2026-03-11T14:30:00Z', asofMs: now };
    for (const rung of LADDER) {
      const shown = present(118.5, origin, now + 90_000, rung);
      expect(shown.source).toBe('NVDA last trade');
      expect(shown.ageMs).toBe(90_000);
      expect(shown.badge).toBe(rung.badge);
      expect(shown.caption).toContain(rung.badge);
    }
  });

  it('never reports a negative age from a clock that ran backwards', () => {
    const origin = { source: 's', asof: 'a', asofMs: now + 10_000 };
    expect(present(1, origin, now).ageMs).toBe(0);
  });
});

describe('finding the rung for a value', () => {
  it('returns nothing when the subsystem is healthy', () => {
    expect(rungFor(ALL_UP, 'realtime_feed')).toBeUndefined();
  });

  it('returns the stale-data rung when the feed drops', () => {
    expect(rungFor({ ...ALL_UP, realtime_feed: 'down' }, 'realtime_feed')?.badge).toBe('stale data');
  });
});
