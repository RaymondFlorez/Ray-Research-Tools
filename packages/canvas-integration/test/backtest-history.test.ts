/**
 * The backtest-history seam: `canvas-data`'s point-in-time store → `canvas-sim`.
 *
 * A backtest loads every version of its facts through `loadHistory` — from the
 * Go data plane in production, whose order and tie-breaks the conformance
 * contract holds to `BitemporalStore`'s — and then reads them through its own
 * `AsOfView`, which is a second implementation of the same rule: on each bar,
 * the newest version known by then of the latest period known by then. Two
 * implementations of one rule drift, so this holds every read the strategy can
 * make to the store's answer for the same instant, on facts with restatements,
 * late knowledge and two versions known at the same instant.
 */

import { describe, expect, it } from 'vitest';
import { BitemporalStore, type Fact } from '@picasso/canvas-data';
import { loadHistory, type VersionSource } from '@picasso/canvas-sim';

/** The store, as the data plane serves it to a user who may see all of it. */
const fromStore = (store: BitemporalStore<number>): VersionSource => ({
  versions: async (key, range) => ({ versions: store.versions(key, range), withheld: [] }),
});

const day = (d: number) => new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10);

function facts(): Fact<number>[] {
  let state = 3;
  const next = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 16) % n;
  };
  const out: Fact<number>[] = [];
  for (let k = 0; k < 600; k += 1) {
    const valid = next(80);
    // Known on the day, or later; a third of them restate an earlier version.
    out.push({ key: `K${next(3)}`, validTime: day(valid), knowledgeTime: day(valid + (next(3) === 0 ? next(40) : 0)), value: k });
  }
  // Two versions known at the same instant: the later append is the correction.
  out.push({ key: 'K0', validTime: day(10), knowledgeTime: day(12), value: -1 });
  out.push({ key: 'K0', validTime: day(10), knowledgeTime: day(12), value: -2 });
  return out;
}

describe('a backtest reads what the point-in-time store would have answered that morning', () => {
  it('on every bar, for every key: latest, window and the settlement price', async () => {
    const store = new BitemporalStore<number>();
    store.appendAll(facts());
    const keys = ['K0', 'K1', 'K2'];
    const history = await loadHistory(fromStore(store), keys);

    let reads = 0;
    for (let d = 0; d < 130; d += 1) {
      const bar = day(d);
      const view = history.viewAt(bar);
      for (const key of keys) {
        const known = store.asOf({ key, knowledgeTime: bar, to: bar });
        expect(view.latest(key), `${key} latest on ${bar}`).toBe(known[known.length - 1]?.value);
        expect(view.window(key, 5), `${key} window on ${bar}`).toEqual(known.slice(-5).map((o) => o.value));
        // What the engine settles at: the final word on that bar, as known today.
        const final = store.history(key, bar);
        expect(history.actualAt(key, bar), `${key} settles on ${bar}`).toBe(final[final.length - 1]?.value);
        reads += 3;
      }
    }
    expect(reads).toBe(1170);
  });

  it('the same-instant correction wins in both', async () => {
    const store = new BitemporalStore<number>();
    store.appendAll(facts());
    const history = await loadHistory(fromStore(store), ['K0']);
    expect(store.valueAt('K0', day(10), day(12))?.value).toBe(-2);
    expect(history.actualAt('K0', day(10))).toBe(store.history('K0', day(10)).at(-1)?.value);
  });
});
