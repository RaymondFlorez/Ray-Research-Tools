/**
 * The resample seam: core's connection fix → data's TransformNode (PRD 3.4.5).
 *
 * > Wiring `series(daily)` into a port constrained to `series(intraday)`
 * > fails validation at connect time with an inline explanation and a
 * > one-click "insert resample node" fix.
 *
 * `canvas-core` offers the fix; `canvas-data` is the node it inserts. Each
 * suite passed on its own while they disagreed: the checker offered
 * "Upsample" as a one-click fix and the first version of the transform
 * refused every upsample. Neither could see the other. The PRD's own example
 * is an upsample, so the transform was the side that had to move — it now
 * goes finer by carrying the last known value forward, and only that way.
 */

import { describe, expect, it } from 'vitest';
import { createNode, validateConnection, type PicassoNode } from '@picasso/canvas-core';
import { applyTransforms, TransformRefused, type DataSeries } from '@picasso/canvas-data';

function producer(frequency: 'daily' | 'weekly'): PicassoNode {
  return createNode({
    id: `src-${frequency}`,
    kind: 'DataTile',
    binding: 'wired',
    position: { x: 0, y: 0 },
    outputs: [{ id: 'out', name: 'out', type: 'series', cardinality: 'one', required: false, emits: { frequency } }],
  });
}

function consumer(frequency: 'daily' | 'monthly' | 'intraday'): PicassoNode {
  return createNode({
    id: `dst-${frequency}`,
    kind: 'ChartNode',
    binding: 'wired',
    position: { x: 400, y: 0 },
    inputs: [{ id: 'in', name: 'in', type: 'series', cardinality: 'one', required: true, constraints: { frequency: [frequency] } }],
  });
}

const dailySeries: DataSeries = {
  frequency: 'daily',
  points: ['2024-01-02', '2024-01-03', '2024-01-31', '2024-02-01', '2024-02-29'].map((date, i) => ({ date, value: 100 + i })),
};

describe('the fix the checker offers is one the transform can apply', () => {
  it('downsample: daily into a monthly port', () => {
    const result = validateConnection(producer('daily'), 'out', consumer('monthly'), 'in');
    expect(result.ok).toBe(false);
    if (result.ok || result.fix?.kind !== 'insert_node' || result.fix.op !== 'resample') throw new Error('expected a resample fix');
    const fixed = applyTransforms(dailySeries, [{ op: 'resample', to: result.fix.to, how: 'last' }]);
    expect(fixed.frequency).toBe('monthly');
    expect(fixed.points).toEqual([
      { date: '2024-01-31', value: 102 },
      { date: '2024-02-29', value: 104 },
    ]);
  });

  it('upsample: weekly into a daily port, carried forward onto the daily grid', () => {
    const result = validateConnection(producer('weekly'), 'out', consumer('daily'), 'in');
    if (result.ok || result.fix?.kind !== 'insert_node' || result.fix.op !== 'resample') throw new Error('expected a resample fix');
    expect(result.fix.label).toBe('Upsample to daily');
    const weekly: DataSeries = { frequency: 'weekly', points: [{ date: '2024-01-05', value: 1 }, { date: '2024-01-12', value: 2 }] };
    const fixed = applyTransforms(weekly, [
      { op: 'resample', to: result.fix.to, how: 'carry', grid: ['2024-01-08', '2024-01-09', '2024-01-12', '2024-01-15'] },
    ]);
    expect(fixed.frequency).toBe('daily');
    expect(fixed.points.map((p) => p.value)).toEqual([1, 1, 2, 2]);
  });

  it('the PRD\'s own example needs timestamps this layer does not carry, and says so', () => {
    const result = validateConnection(producer('daily'), 'out', consumer('intraday'), 'in');
    if (result.ok || result.fix?.kind !== 'insert_node' || result.fix.op !== 'resample') throw new Error('expected a resample fix');
    const to = result.fix.to;
    expect(to).toBe('intraday');
    expect(() => applyTransforms(dailySeries, [{ op: 'resample', to, how: 'carry', grid: ['2024-01-02'] }])).toThrow(TransformRefused);
    expect(() =>
      applyTransforms(dailySeries, [{ op: 'resample', to: 'intraday', how: 'carry', grid: ['2024-01-02'] }]),
    ).toThrow(/needs timestamps/);
  });
});
