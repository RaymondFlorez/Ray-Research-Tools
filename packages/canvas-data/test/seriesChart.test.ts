import { describe, expect, it } from 'vitest';
import { BitemporalStore } from '../src/bitemporal.js';
import { localSource, type PointInTimeSource } from '../src/factTile.js';
import { createSeriesChart, evaluateSeriesChart } from '../src/seriesChart.js';

const THE_MORNING = '2024-08-05T09:30:00Z';
const TODAY = () => '2026-09-10T00:00:00Z';

function store() {
  const s = new BitemporalStore<number>();
  s.appendAll([
    { key: 'NVDA.revenue', validTime: '2024-03-31', knowledgeTime: '2024-05-22', value: 26.04 },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04 },
    { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, restatement: true },
    { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08 },
  ]);
  return s;
}

describe('a series chart on a scrubbed canvas', () => {
  it('draws the line known that morning, and today\'s restated line live', async () => {
    const chart = createSeriesChart({ id: 'c', key: 'NVDA.revenue' });
    expect(chart.kind).toBe('ChartNode');
    const morning = await evaluateSeriesChart(chart, localSource(store()), { mode: 'pinned', asof: THE_MORNING }, TODAY);
    expect(morning).toEqual({
      kind: 'series', key: 'NVDA.revenue', asof: THE_MORNING, source: 'local store',
      points: [
        { validTime: '2024-03-31', value: 26.04, knownAt: '2024-05-22' },
        { validTime: '2024-06-30', value: 30.04, knownAt: '2024-07-24' },
      ],
    });
    expect(chart.provenance.asof).toBe(THE_MORNING);
    const today = await evaluateSeriesChart(chart, localSource(store()), { mode: 'live' }, TODAY);
    if (today.kind !== 'series') throw new Error('unreachable');
    expect(today.points.map((p) => ('value' in p ? p.value : null))).toEqual([26.04, 29.87, 35.08]);
  });

  it('keeps its valid-time range', async () => {
    const chart = createSeriesChart({ id: 'c', key: 'NVDA.revenue', from: '2024-06-01', to: '2024-07-31' });
    const v = await evaluateSeriesChart(chart, localSource(store()), { mode: 'live' }, TODAY);
    if (v.kind !== 'series') throw new Error('unreachable');
    expect(v.points.map((p) => p.validTime)).toEqual(['2024-06-30']);
  });

  it('puts a withheld period where it falls, as a gap with its reason', async () => {
    const withholding: PointInTimeSource = {
      name: 'data plane',
      read: async (query) => {
        const r = await localSource(store()).read(query);
        return {
          observations: r.observations.filter((o) => o.validTime !== '2024-06-30'),
          blocked: r.observations.filter((o) => o.validTime === '2024-06-30').map((o) => ({ validTime: o.validTime, message: 'Requires a vendor-b licence.' })),
        };
      },
    };
    const v = await evaluateSeriesChart(createSeriesChart({ id: 'c', key: 'NVDA.revenue' }), withholding, { mode: 'live' }, TODAY);
    if (v.kind !== 'series') throw new Error('unreachable');
    expect(v.points).toEqual([
      { validTime: '2024-03-31', value: 26.04, knownAt: '2024-05-22' },
      { validTime: '2024-06-30', withheld: 'Requires a vendor-b licence.' },
      { validTime: '2024-09-30', value: 35.08, knownAt: '2024-11-20' },
    ]);
  });

  it('discards a read that lands after the canvas moved', async () => {
    const chart = createSeriesChart({ id: 'c', key: 'NVDA.revenue' });
    const slow: PointInTimeSource = {
      name: 'slow',
      read: async (query) => {
        chart.provenance = { ...chart.provenance, asof: '2026-01-01T00:00:00Z' };
        return localSource(store()).read(query);
      },
    };
    expect(await evaluateSeriesChart(chart, slow, { mode: 'pinned', asof: THE_MORNING }, TODAY)).toEqual({ kind: 'superseded', key: 'NVDA.revenue', asof: THE_MORNING });
  });
});
