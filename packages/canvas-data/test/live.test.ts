import { describe, expect, it } from 'vitest';
import { LiveTiles, parseSse } from '../src/live.js';

const update = (seriesId: string, price: number, t: number) => ({
  event: 'update',
  data: JSON.stringify({ seriesId, t, values: { price, size: 3 }, ticks: 7 }),
});
const health = (list: object[]) => ({ event: 'health', data: JSON.stringify(list) });

describe('parseSse', () => {
  it('emits only whole events, wherever a chunk breaks', () => {
    const stream = 'event: update\ndata: {"a":1}\n\n: keep-alive\n\nevent: health\ndata: [1,\ndata: 2]\n\nevent: upd';
    // Fed one character at a time, the result is the same as all at once.
    let rest = '';
    const seen: Array<{ event: string; data: string }> = [];
    for (const ch of stream) {
      const out = parseSse(rest + ch);
      seen.push(...out.events);
      rest = out.rest;
    }
    expect(seen).toEqual([
      { event: 'update', data: '{"a":1}' },
      { event: 'health', data: '[1,\n2]' },
    ]);
    expect(rest).toBe('event: upd');
    expect(parseSse('event: x\r\ndata: y\r\n\r\n').events).toEqual([{ event: 'x', data: 'y' }]);
  });
});

describe('LiveTiles', () => {
  it('shows waiting before anything arrives, and never a zero', () => {
    expect(new LiveTiles().tile('NVDA', 0)).toEqual({ instrument: 'NVDA', kind: 'waiting', state: 'live' });
  });

  it('shows the latest value with the server time it was true', () => {
    const tiles = new LiveTiles();
    tiles.apply(update('NVDA', 120.5, 1_000), 10);
    tiles.apply(update('NVDA', 121, 1_250), 260);
    const t = tiles.tile('NVDA', 300);
    expect(t).toMatchObject({ kind: 'value', values: { price: 121, size: 3 }, ticks: 7, asOfMs: 1_250, state: 'live', elapsedMs: 40 });
  });

  it('keeps counting a stale tile\'s age between health reports', () => {
    const tiles = new LiveTiles();
    tiles.apply(update('NVDA', 120, 1_000), 0);
    tiles.apply(health([{ instrument: 'NVDA', state: 'stale', elapsedMs: 6_000, reason: 'no update within the staleness threshold' }]), 6_000);
    // Two seconds later with no new report: 8 seconds, not a frozen 6.
    expect(tiles.tile('NVDA', 8_000)).toMatchObject({ state: 'stale', elapsedMs: 8_000, reason: 'no update within the staleness threshold' });
    // An update restarts the count, and the next report clears the state.
    tiles.apply(update('NVDA', 122, 9_000), 9_000);
    expect(tiles.tile('NVDA', 9_100)).toMatchObject({ elapsedMs: 100, values: { price: 122 } });
    tiles.apply(health([{ instrument: 'NVDA', state: 'live', elapsedMs: 200 }]), 9_200);
    expect(tiles.tile('NVDA', 9_200)).toMatchObject({ state: 'live', elapsedMs: 200 });
    expect(tiles.tile('NVDA', 9_200).reason).toBeUndefined();
  });

  it('says recovering after a gap until the server clears it', () => {
    const tiles = new LiveTiles();
    tiles.apply(update('AMD', 150, 1_000), 0);
    tiles.apply(health([{ instrument: 'AMD', state: 'recovering', elapsedMs: 10, reason: 'sequence gap 7-9 on eq' }]), 100);
    expect(tiles.tile('AMD', 100)).toMatchObject({ kind: 'value', state: 'recovering', reason: 'sequence gap 7-9 on eq' });
  });

  it('blocks rather than shows, and drops a value that arrived before the block', () => {
    const tiles = new LiveTiles();
    tiles.apply(update('AMD', 150, 1_000), 0);
    tiles.apply({ event: 'blocked', data: JSON.stringify({ instrument: 'AMD', decision: { reason: 'no_vendor_licence', message: 'Requires a vendor-b licence.' } }) }, 10);
    tiles.apply(update('AMD', 151, 1_250), 20);
    const t = tiles.tile('AMD', 30);
    expect(t).toEqual({ instrument: 'AMD', kind: 'blocked', state: 'live', reason: 'Requires a vendor-b licence.' });
    expect(t.values).toBeUndefined();
  });
});
