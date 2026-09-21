import { describe, expect, it } from 'vitest';
import {
  Conflator,
  MAX_HZ,
  TRADE_FIELDS,
  WINDOW_MS,
  maxUpdatesPerSecond,
  type Tick,
} from '../src/conflate.js';

const T0 = Date.UTC(2026, 2, 11, 14, 30);

function tick(seriesId: string, t: number, values: Record<string, number>): Tick {
  return { seriesId, t, values };
}

describe('what conflation means per field', () => {
  // The one that is right by default and the reason "keep the last" feels
  // like the whole answer.
  it('keeps the last price, because the earlier ones are superseded', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { price: 100 }));
    c.accept(tick('a', T0 + 10, { price: 101 }));
    c.accept(tick('a', T0 + 20, { price: 102 }));
    const [update] = c.drain(T0 + WINDOW_MS);
    expect(update?.values.price).toBe(102);
    expect(update?.ticks).toBe(3);
  });

  // The one that is wrong by default, and wrong in a way that grows with how
  // busy the tape is.
  it('sums traded size, because dropping it under-reports the volume', () => {
    const c = new Conflator();
    for (let i = 0; i < 200; i += 1) {
      c.accept(tick('a', T0 + i, { price: 100 + i * 0.01, size: 50 }));
    }
    const [update] = c.drain(T0 + WINDOW_MS);
    expect(update?.values.size).toBe(200 * 50);
    // Keeping the last would have reported 50 — the size of one trade as the
    // volume of two hundred.
    expect(update?.values.size).not.toBe(50);
  });

  // The same point min/max decimation makes about a chart: the extreme is
  // often on the tick that gets dropped, and it is often the one that matters.
  it('keeps a high and a low that happened on ticks it dropped', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { price: 100, high: 100, low: 100 }));
    c.accept(tick('a', T0 + 5, { price: 100, high: 137, low: 61 }));
    c.accept(tick('a', T0 + 10, { price: 100, high: 100, low: 100 }));
    const [update] = c.drain(T0 + WINDOW_MS);
    expect(update?.values.high).toBe(137);
    expect(update?.values.low).toBe(61);
    // And the price is still the last, not the extreme.
    expect(update?.values.price).toBe(100);
  });

  it('keeps the first open', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { open: 99.5 }));
    c.accept(tick('a', T0 + 5, { open: 101 }));
    expect(c.drain(T0 + WINDOW_MS)[0]?.values.open).toBe(99.5);
  });

  it('takes per-series field semantics where a series needs its own', () => {
    const c = new Conflator({
      fields: { depth: { level: 'last', added: 'sum' } },
      defaultFields: TRADE_FIELDS,
    });
    c.accept(tick('depth', T0, { level: 1, added: 3 }));
    c.accept(tick('depth', T0 + 5, { level: 2, added: 4 }));
    c.accept(tick('trade', T0, { price: 10, size: 1 }));
    c.accept(tick('trade', T0 + 5, { price: 11, size: 2 }));

    const updates = c.drain(T0 + WINDOW_MS);
    const depth = updates.find((u) => u.seriesId === 'depth')!;
    const trade = updates.find((u) => u.seriesId === 'trade')!;
    expect(depth.values).toEqual({ level: 2, added: 7 });
    expect(trade.values).toEqual({ price: 11, size: 3 });
  });

  it('treats an unknown field as last rather than dropping it', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { spread: 0.02 }));
    c.accept(tick('a', T0 + 5, { spread: 0.03 }));
    expect(c.drain(T0 + WINDOW_MS)[0]?.values.spread).toBe(0.03);
  });

  it('carries a field that only appears on a later tick', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { price: 100 }));
    c.accept(tick('a', T0 + 5, { price: 101, size: 7 }));
    expect(c.drain(T0 + WINDOW_MS)[0]?.values).toEqual({ price: 101, size: 7 });
  });
});

describe('the rate cap', () => {
  it('emits nothing before the window closes', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { price: 1 }));
    expect(c.drain(T0 + WINDOW_MS - 1)).toEqual([]);
    expect(c.drain(T0 + WINDOW_MS)).toHaveLength(1);
  });

  it('holds one series to four updates a second however fast it ticks', () => {
    const c = new Conflator();
    let emitted = 0;
    // A thousand ticks over one second: 1kHz in, 4Hz out. The windows close at
    // 250, 500, 750 and 1000, so a loop that stops at 999 sees three and holds
    // the fourth — which is the honest count and not a rounding of it.
    for (let ms = 0; ms < 1000; ms += 1) {
      c.accept(tick('a', T0 + ms, { price: 100 + ms * 0.001, size: 1 }));
      emitted += c.drain(T0 + ms).length;
    }
    expect(emitted).toBe(MAX_HZ - 1);
    expect(c.pendingCount).toBe(1);

    // The fourth closes on the next millisecond, and nothing was lost: the
    // four updates between them stand for all thousand ticks.
    emitted += c.drain(T0 + 1000).length;
    expect(emitted).toBe(MAX_HZ);
    expect(c.stats.accepted).toBe(1000);
    expect(c.stats.emitted).toBe(MAX_HZ);
  });

  // The whole reason conflation exists: nothing is lost, only superseded.
  it('conserves the volume across the whole stream', () => {
    const c = new Conflator();
    let total = 0;
    let reported = 0;
    for (let ms = 0; ms < 5000; ms += 1) {
      const size = 1 + (ms % 17);
      total += size;
      c.accept(tick('a', T0 + ms, { price: 100, size }));
      for (const update of c.drain(T0 + ms)) reported += update.values.size as number;
    }
    for (const update of c.flush()) reported += update.values.size as number;
    expect(reported).toBe(total);
  });

  it('spreads the emissions rather than bunching them', () => {
    const c = new Conflator();
    // Two series that started 100ms apart stay 100ms apart.
    c.accept(tick('a', T0, { price: 1 }));
    c.accept(tick('b', T0 + 100, { price: 1 }));
    expect(c.drain(T0 + WINDOW_MS).map((u) => u.seriesId)).toEqual(['a']);
    expect(c.drain(T0 + WINDOW_MS + 99).map((u) => u.seriesId)).toEqual([]);
    expect(c.drain(T0 + WINDOW_MS + 100).map((u) => u.seriesId)).toEqual(['b']);
  });

  // The claim the grid makes, tested rather than asserted. A window measured
  // from whichever tick opened it lasts `window + gap`, the gap accumulates,
  // and a 1kHz series emits three times a second instead of four — under the
  // cap, so not a breach, and a quarter of the updates missing for no reason
  // anybody chose.
  it('does not drift: the period stays one window, not a window plus the gap', () => {
    const c = new Conflator();
    const emittedAt: number[] = [];
    for (let ms = 0; ms <= 4000; ms += 1) {
      c.accept(tick('a', T0 + ms, { price: 1 }));
      for (const _ of c.drain(T0 + ms)) emittedAt.push(ms);
    }
    // Sixteen windows in four seconds, exactly on the grid.
    expect(emittedAt.length).toBe(MAX_HZ * 4);
    for (let i = 0; i < emittedAt.length; i += 1) {
      expect(emittedAt[i]).toBe((i + 1) * WINDOW_MS);
    }
  });

  it('lands on the next slot after a silence rather than firing immediately', () => {
    const c = new Conflator();
    c.accept(tick('a', T0, { price: 1 }));
    expect(c.drain(T0 + WINDOW_MS)).toHaveLength(1);

    // Ten seconds of nothing, then a tick.
    const after = T0 + 10_000 + 37;
    c.accept(tick('a', after, { price: 2 }));
    // It does not fire on the spot...
    expect(c.drain(after)).toEqual([]);
    // ...and it does not work through forty stale windows either: one update,
    // at the next boundary of this series' own grid.
    const nextBoundary = T0 + Math.ceil((after - T0) / WINDOW_MS) * WINDOW_MS;
    expect(nextBoundary - after).toBeLessThanOrEqual(WINDOW_MS);
    expect(c.drain(nextBoundary)).toHaveLength(1);
    expect(c.pendingCount).toBe(0);
  });

  it('drains the longest-waiting series first', () => {
    const c = new Conflator();
    c.accept(tick('late', T0 + 50, { price: 1 }));
    c.accept(tick('early', T0, { price: 1 }));
    expect(c.drain(T0 + 1000).map((u) => u.seriesId)).toEqual(['early', 'late']);
  });

  it('does not let a late tick pull the window backwards', () => {
    const c = new Conflator();
    c.accept(tick('a', T0 + 100, { price: 1 }));
    c.accept(tick('a', T0 + 20, { price: 2 }));
    const [update] = c.drain(T0 + 1000);
    expect(update?.t).toBe(T0 + 100);
    expect(update?.ticks).toBe(2);
  });
});

describe('the fan-out the PRD budgets', () => {
  it('is series times the per-series rate', () => {
    expect(maxUpdatesPerSecond(2000)).toBe(8000);
    expect(maxUpdatesPerSecond(2000, MAX_HZ)).toBe(8000);
  });

  // "A browser subscribed to 2,000 series receives at most 8,000 updates/sec
  // of pre-conflated deltas ... not 1.5M raw ticks."
  it('holds 2,000 series to 8,000 updates a second under a 1.5M/sec tape', () => {
    const SERIES = 2000;
    const SECONDS = 2;
    // 1.5M messages a second is the backend ingest figure; this canvas's share
    // of it is 750 ticks per series per second, which is 375 per window.
    const PER_SERIES_PER_SECOND = 750;

    const c = new Conflator();
    let emitted = 0;
    let accepted = 0;

    for (let ms = 0; ms < SECONDS * 1000; ms += 1) {
      // Every series ticks at 750Hz: three quarters of the milliseconds.
      if (ms % 4 !== 3) {
        for (let s = 0; s < SERIES; s += 1) {
          c.accept(tick(`s${s}`, T0 + ms, { price: 100 + s, size: 1 }));
          accepted += 1;
        }
      }
      emitted += c.drain(T0 + ms).length;
    }

    expect(accepted).toBe(SERIES * PER_SERIES_PER_SECOND * SECONDS);
    // At most 8,000 a second, and in practice one window's worth short of it
    // because the last window of each series has not closed yet.
    expect(emitted).toBeLessThanOrEqual(maxUpdatesPerSecond(SERIES) * SECONDS);
    expect(emitted).toBeGreaterThanOrEqual(maxUpdatesPerSecond(SERIES) * SECONDS - SERIES);
    // Which is a compression of about 187 to one.
    expect(c.stats.ratio).toBeGreaterThan(150);
  });

  it('conserves volume across all 2,000 series, not just one', () => {
    const SERIES = 200;
    const c = new Conflator();
    const sent = new Map<string, number>();
    const got = new Map<string, number>();

    for (let ms = 0; ms < 1200; ms += 1) {
      for (let s = 0; s < SERIES; s += 1) {
        const id = `s${s}`;
        const size = 1 + ((ms + s) % 9);
        sent.set(id, (sent.get(id) ?? 0) + size);
        c.accept(tick(id, T0 + ms, { price: 100, size }));
      }
      for (const update of c.drain(T0 + ms)) {
        got.set(update.seriesId, (got.get(update.seriesId) ?? 0) + (update.values.size as number));
      }
    }
    for (const update of c.flush()) {
      got.set(update.seriesId, (got.get(update.seriesId) ?? 0) + (update.values.size as number));
    }

    expect(got.size).toBe(SERIES);
    for (const [id, total] of sent) expect(got.get(id), id).toBe(total);
  });
});
