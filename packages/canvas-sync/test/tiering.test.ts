import { describe, expect, it } from 'vitest';
import { ArtifactTiers, COLD_AFTER_MS, MemoryColdStore } from '../src/tiering.js';

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 2, 1);

function tiers() {
  const store = new MemoryColdStore();
  return { store, tiers: new ArtifactTiers(store) };
}

describe('artifact tiering', () => {
  it('keeps a canvas opened within the week hot', async () => {
    const { tiers: t } = tiers();
    t.opened('morning-note', T0);
    t.put('morning-note', 'k1', '{"value":1.4}');
    const report = await t.sweep(T0 + 6 * DAY);
    expect(report.canvases).toEqual([]);
    expect(t.hotCount('morning-note')).toBe(1);
  });

  it('evicts a canvas unopened for seven days, every artifact of it', async () => {
    const { store, tiers: t } = tiers();
    t.opened('q3-review', T0);
    for (let i = 0; i < 40; i++) t.put('q3-review', `k${i}`, `{"value":${i}}`);
    const report = await t.sweep(T0 + COLD_AFTER_MS);
    expect(report).toEqual({ canvases: ['q3-review'], artifacts: 40 });
    expect(t.hotCount('q3-review')).toBe(0);
    expect(store.map.size).toBe(40);
  });

  it('measures coldness from the last open, not the last write', async () => {
    // Read every morning, never edited: the opposite of cold.
    const { tiers: t } = tiers();
    t.put('desk-head', 'k1', '{"value":1}');
    for (let day = 0; day <= 10; day++) t.opened('desk-head', T0 + day * DAY);
    expect((await t.sweep(T0 + 10 * DAY + 1)).canvases).toEqual([]);
  });

  it('rehydrates one artifact on read, not the whole canvas on open', async () => {
    const { store, tiers: t } = tiers();
    t.opened('q3-review', T0);
    for (let i = 0; i < 40; i++) t.put('q3-review', `k${i}`, `{"value":${i}}`);
    await t.sweep(T0 + COLD_AFTER_MS);

    t.opened('q3-review', T0 + COLD_AFTER_MS + DAY);
    // Opening pulls nothing back; the viewport decides what is read.
    expect(t.hotCount('q3-review')).toBe(0);
    expect(await t.read('q3-review', 'k7')).toEqual({ status: 'rehydrated', artifact: '{"value":7}' });
    expect(t.hotCount('q3-review')).toBe(1);
    expect(t.coldCount('q3-review')).toBe(39);
    expect(store.map.size).toBe(39);
    expect(await t.read('q3-review', 'k7')).toEqual({ status: 'hot', artifact: '{"value":7}' });
  });

  it('refuses an artifact that came back different from what went out', async () => {
    const { store, tiers: t } = tiers();
    t.opened('q3-review', T0);
    t.put('q3-review', 'k1', '{"value":1.4}');
    await t.sweep(T0 + COLD_AFTER_MS);
    // One digit changed at rest. The cache key describes the inputs, so it
    // cannot catch this; the digest taken at eviction does.
    store.map.set('q3-review/k1', '{"value":1.5}');
    const outcome = await t.read('q3-review', 'k1');
    expect(outcome.status).toBe('corrupt');
    expect(t.hotCount('q3-review')).toBe(0);
    // And it is gone, so the next read is a miss and the node recomputes.
    expect(await t.read('q3-review', 'k1')).toEqual({ status: 'miss' });
  });

  it('reports an artifact missing from cold storage rather than a quiet miss', async () => {
    const { store, tiers: t } = tiers();
    t.opened('q3-review', T0);
    t.put('q3-review', 'k1', '{"value":1.4}');
    await t.sweep(T0 + COLD_AFTER_MS);
    store.map.clear();
    expect((await t.read('q3-review', 'k1')).status).toBe('corrupt');
  });

  it('lets a fresh write supersede an evicted artifact under the same key', async () => {
    const { tiers: t } = tiers();
    t.opened('q3-review', T0);
    t.put('q3-review', 'k1', '{"value":1}');
    await t.sweep(T0 + COLD_AFTER_MS);
    t.put('q3-review', 'k1', '{"value":2}');
    expect(await t.read('q3-review', 'k1')).toEqual({ status: 'hot', artifact: '{"value":2}' });
    expect(t.coldCount('q3-review')).toBe(0);
  });

  it('does not leave a superseded object in cold storage', async () => {
    const { store, tiers: t } = tiers();
    t.opened('q3-review', T0);
    t.put('q3-review', 'k1', '{"value":1}');
    await t.sweep(T0 + COLD_AFTER_MS);
    t.opened('q3-review', T0 + COLD_AFTER_MS);
    t.put('q3-review', 'k1', '{"value":2}');
    expect(store.map.has('q3-review/k1')).toBe(true);
    await t.sweep(T0 + COLD_AFTER_MS + 1);
    expect(store.map.has('q3-review/k1')).toBe(false);
  });
});
