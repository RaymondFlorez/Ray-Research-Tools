import { describe, expect, it } from 'vitest';
import { applyTransforms, TransformRefused, type DataSeries } from '../src/transform.js';

/** Business days from 2024-01-01 (a Monday), with values 1, 2, 3, ... */
function daily(count: number, currency?: string): DataSeries {
  const points = [];
  let ms = Date.UTC(2024, 0, 1);
  while (points.length < count) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday !== 0 && weekday !== 6) points.push({ date: new Date(ms).toISOString().slice(0, 10), value: points.length + 1 });
    ms += 86_400_000;
  }
  return { points, frequency: 'daily', ...(currency ? { currency } : {}) };
}

describe('resample', () => {
  const s = daily(70); // Jan 1 to early April 2024

  it('takes the last value of each month, dated by its last observation', () => {
    const monthly = applyTransforms(s, [{ op: 'resample', to: 'monthly', how: 'last' }]);
    expect(monthly.frequency).toBe('monthly');
    // January 2024 has 23 business days, so its last value is 23, on the 31st.
    expect(monthly.points[0]).toEqual({ date: '2024-01-31', value: 23 });
    // February 2024 has 21: values 24..44, last on the 29th (a leap year).
    expect(monthly.points[1]).toEqual({ date: '2024-02-29', value: 44 });
  });

  it('sums flows and averages levels when told to, and keeps ISO weeks', () => {
    const sum = applyTransforms(s, [{ op: 'resample', to: 'weekly', how: 'sum' }]);
    // The first ISO week of 2024 is Mon 1 to Fri 5: 1+2+3+4+5.
    expect(sum.points[0]).toEqual({ date: '2024-01-05', value: 15 });
    const mean = applyTransforms(s, [{ op: 'resample', to: 'quarterly', how: 'mean' }]);
    // Q1 2024 has 65 business days (23 + 21 + 21): the mean of 1..65.
    expect(mean.points[0]!.value).toBeCloseTo(33, 12);
  });

  it('goes finer only by carrying the last known value forward', () => {
    const monthly = applyTransforms(s, [{ op: 'resample', to: 'monthly', how: 'last' }]);
    expect(() => applyTransforms(monthly, [{ op: 'resample', to: 'daily', how: 'mean' }])).toThrow(/would invent the observations/);
    const grid = ['2024-01-15', '2024-01-31', '2024-02-01', '2024-02-29', '2024-03-04'];
    const back = applyTransforms(monthly, [{ op: 'resample', to: 'daily', how: 'carry', grid }]);
    // Before Jan 31 nothing monthly is known yet: dropped, not back-filled.
    expect(back.points).toEqual([
      { date: '2024-01-31', value: 23 },
      { date: '2024-02-01', value: 23 },
      { date: '2024-02-29', value: 44 },
      { date: '2024-03-04', value: 44 },
    ]);
    expect(back.frequency).toBe('daily');
    expect(() => applyTransforms(s, [{ op: 'resample', to: 'monthly', how: 'carry', grid }])).toThrow(/coarser/);
  });
});

describe('lag, z-score and winsorize cannot look ahead', () => {
  const s = daily(40);

  it('lags by shifting values forward, and refuses a lead', () => {
    const lagged = applyTransforms(s, [{ op: 'lag', periods: 2 }]);
    expect(lagged.points[0]).toEqual({ date: s.points[2]!.date, value: 1 });
    expect(() => applyTransforms(s, [{ op: 'lag', periods: -1 }])).toThrow(/the future/);
  });

  it('z-scores against the window before each point', () => {
    const z = applyTransforms(s, [{ op: 'zscore', window: 5 }]);
    // Point 6 (value 6) against 1..5: mean 3, sample sd sqrt(2.5).
    expect(z.points[0]!.value).toBeCloseTo((6 - 3) / Math.sqrt(2.5), 12);
    expect(z.points[0]!.date).toBe(s.points[5]!.date);
  });

  it('gives no earlier output a say in a later input', () => {
    // Change the last point by a lot: every earlier output is unchanged.
    const bumped: DataSeries = { ...s, points: s.points.map((p, i) => (i === s.points.length - 1 ? { ...p, value: 1e6 } : p)) };
    for (const ops of [
      [{ op: 'zscore' as const, window: 10 }],
      [{ op: 'zscore' as const, window: 10, robust: true }],
      [{ op: 'winsorize' as const, window: 10, lower: 0.1, upper: 0.9 }],
      [{ op: 'lag' as const, periods: 3 }],
    ]) {
      const a = applyTransforms(s, ops).points;
      const b = applyTransforms(bumped, ops).points;
      expect(b.slice(0, -1)).toEqual(a.slice(0, -1));
    }
  });

  it('winsorizes at the trailing window\'s quantiles', () => {
    const spiky: DataSeries = { ...s, points: s.points.map((p, i) => (i === 20 ? { ...p, value: 1000 } : p)) };
    const w = applyTransforms(spiky, [{ op: 'winsorize', window: 10, lower: 0, upper: 0.9 }]);
    const clipped = w.points.find((p) => p.date === s.points[20]!.date)!;
    // The ten before are 11..20; their 0.9 quantile is 19.1.
    expect(clipped.value).toBeCloseTo(19.1, 12);
  });
});

describe('convert_currency', () => {
  it('uses the last rate known on each date, and refuses a date before the first', () => {
    const s = daily(5, 'EUR');
    // A rate on Mon and Thu only.
    const rates: DataSeries = { frequency: 'daily', points: [{ date: '2024-01-01', value: 1.1 }, { date: '2024-01-04', value: 1.2 }] };
    const usd = applyTransforms(s, [{ op: 'convert_currency', to: 'USD', rates }]);
    expect(usd.currency).toBe('USD');
    expect(usd.points.map((p) => p.value)).toEqual([1 * 1.1, 2 * 1.1, 3 * 1.1, 4 * 1.2, 5 * 1.2]);
    const late: DataSeries = { frequency: 'daily', points: [{ date: '2024-01-03', value: 1.1 }] };
    expect(() => applyTransforms(s, [{ op: 'convert_currency', to: 'USD', rates: late }])).toThrow(/on or before 2024-01-01/);
  });

  it('records every op in words', () => {
    const out = applyTransforms(daily(70, 'EUR'), [
      { op: 'resample', to: 'monthly', how: 'last' },
      { op: 'lag', periods: 1 },
    ]);
    expect(out.steps).toEqual([
      'resampled to monthly, taking the last of each period, dated by its last observation',
      'lagged 1 period',
    ]);
    expect(() => applyTransforms(daily(5), [{ op: 'convert_currency', to: 'USD', rates: daily(5) }])).toThrow(TransformRefused);
  });
});
