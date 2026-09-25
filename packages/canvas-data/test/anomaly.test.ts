import { describe, expect, it } from 'vitest';
import {
  MAD_TO_SIGMA,
  bocpd,
  bocpdFirings,
  logGamma,
  robustScale,
  robustZ,
  robustZFirings,
  stl,
  stlFirings,
} from '../src/anomaly.js';

/** Seeded uniform, then Box-Muller: every number below is reproducible. */
function uniform(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(n: number, seed: number): number[] {
  const r = uniform(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = r() || 1e-12;
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
  }
  return out;
}

const PERIOD = 24;
const CYCLES = 30;

/** Thirty days of hourly data: a trend, a daily cycle, a little noise. */
function seasonal(seed: number): number[] {
  const noise = normals(PERIOD * CYCLES, seed);
  return noise.map((e, i) => 50 + 0.01 * i + 3 * Math.sin((2 * Math.PI * i) / PERIOD) + 0.2 * e);
}

describe('the pieces', () => {
  it('logGamma agrees with factorials and with sqrt(pi)', () => {
    // Values that do not come from the function under test.
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 13);
    expect(logGamma(11)).toBeCloseTo(Math.log(3628800), 12);
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 13);
    expect(logGamma(0.25)).toBeCloseTo(Math.log(3.625609908221908), 12);
  });

  it('scales the MAD to a standard deviation under normality', () => {
    // 20,000 standard normals: the robust scale should read about 1.
    expect(robustScale(normals(20_000, 5))).toBeCloseTo(1, 1);
    expect(MAD_TO_SIGMA).toBe(1.4826);
  });
});

describe('robust z', () => {
  it('scores each point against the window before it, not one containing it', () => {
    const series = [...normals(60, 6).map((x) => 100 + x), 110];
    const z = robustZ(series, { window: 60 });
    const base = series.slice(0, 60);
    const scale = robustScale(base);
    const sorted = [...base].sort((a, b) => a - b);
    const med = (sorted[29]! + sorted[30]!) / 2;
    expect(z[60]).toBeCloseTo((110 - med) / scale, 12);
  });

  it('says nothing about a series with no dispersion', () => {
    // A price stuck on one tick has no scale; the next tick is not infinitely
    // anomalous.
    const stuck = [...new Array<number>(60).fill(100), 100.01];
    expect(robustZ(stuck, { window: 60 })[60]).toBeNaN();
    expect(robustZFirings(stuck, { window: 60 })).toEqual([]);
  });

  it('fires rarely on noise: 29 times in 40,000 points', () => {
    // Gaussian theory at four sd is about 2.5 in 40,000. The MAD over sixty
    // points is itself noisy, which fattens the tails of the score roughly
    // tenfold; the figure is stated rather than tuned away.
    let firings = 0;
    for (let seed = 10; seed < 30; seed++) {
      firings += robustZFirings(normals(2000, seed).map((x) => 100 + x)).length;
    }
    expect(firings).toBe(29);
  });

  it('does not see a three-sigma level shift, which is not its job', () => {
    const shift = normals(1000, 2).map((x, i) => 100 + x + (i >= 500 ? 3 : 0));
    expect(robustZFirings(shift)).toEqual([]);
  });
});

describe('BOCPD', () => {
  it('fires rarely on noise: 27 times in 40,000 points', () => {
    let firings = 0;
    for (let seed = 10; seed < 30; seed++) {
      firings += bocpdFirings(normals(2000, seed).map((x) => 100 + x)).length;
    }
    expect(firings).toBe(27);
  });

  it('catches a three-sigma level shift within a few points, every time', () => {
    const delays: number[] = [];
    const severities: number[] = [];
    for (let seed = 40; seed < 60; seed++) {
      const x = normals(1000, seed).map((v, i) => 100 + v + (i >= 500 ? 3 : 0));
      const first = bocpdFirings(x).find((f) => f.index >= 500);
      expect(first).toBeDefined();
      delays.push(first!.index - 500);
      severities.push(first!.severity);
    }
    // Twenty of twenty, no later than five points after the change.
    expect(Math.max(...delays)).toBeLessThanOrEqual(5);
    // The severity is where the new points sit in the old regime's sd: a
    // shift of three reads between two and four on a handful of new points.
    for (const s of severities) {
      expect(s).toBeGreaterThan(1.8);
      expect(s).toBeLessThan(4);
    }
  });

  it('catches a variance that trebled, which a difference of medians would score at zero', () => {
    let caught = 0;
    for (let seed = 60; seed < 80; seed++) {
      const x = normals(1000, seed).map((v, i) => 100 + v * (i >= 500 ? 3 : 1));
      const first = bocpdFirings(x).find((f) => f.index >= 500 && f.index <= 510);
      if (first) {
        caught += 1;
        expect(first.severity).toBeGreaterThan(1.5);
      }
    }
    expect(caught).toBe(19);
  });

  it('keeps the tail of the run-length posterior rather than dropping it', () => {
    const steps = bocpd(normals(900, 7).map((x) => 100 + x), { maxRunLength: 200 });
    // Past the cap on a quiet series, the mass sits in the merged last bucket,
    // not renormalised into short runs, which would read as a change.
    expect(steps[899]!.mapRunLength).toBe(199);
    expect(steps[899]!.recentChange).toBeLessThan(0.1);
  });

  it('never scores a firing with points that came after it', () => {
    const x = normals(1000, 41).map((v, i) => 100 + v + (i >= 500 ? 3 : 0));
    const first = bocpdFirings(x).find((f) => f.index >= 500)!;
    // Changing everything after the firing changes nothing about it.
    const altered = [...x.slice(0, first.index + 1), ...new Array<number>(999 - first.index).fill(-1e6)];
    const again = bocpdFirings(altered).find((f) => f.index >= 500)!;
    expect(again.index).toBe(first.index);
    expect(again.severity).toBe(first.severity);
  });
});

describe('STL', () => {
  it('decomposes exactly: trend plus seasonal plus remainder is the series', () => {
    const y = seasonal(4);
    const d = stl(y, { period: PERIOD });
    for (let i = 0; i < y.length; i++) {
      expect(d.trend[i]! + d.seasonal[i]! + d.remainder[i]!).toBeCloseTo(y[i]!, 12);
    }
  });

  it('recovers a known daily cycle', () => {
    const y = seasonal(4);
    const d = stl(y, { period: PERIOD });
    let error = 0;
    let count = 0;
    for (let i = PERIOD; i < y.length - PERIOD; i++) {
      error += Math.abs(d.seasonal[i]! - 3 * Math.sin((2 * Math.PI * i) / PERIOD));
      count += 1;
    }
    // 0.043 mean absolute error away from the ends, against noise of 0.2.
    expect(error / count).toBeLessThan(0.05);
  });

  it('keeps a spike out of the seasonal pattern when robust, and leaks it when not', () => {
    const y = seasonal(4);
    const spiked = [...y];
    spiked[400]! += 15;
    const leak = (outer: number) => {
      const clean = stl(y, { period: PERIOD, outer }).seasonal;
      const dirty = stl(spiked, { period: PERIOD, outer }).seasonal;
      let sum = 0;
      let n = 0;
      for (let i = 400 % PERIOD; i < y.length; i += PERIOD) {
        if (i === 400) continue;
        sum += dirty[i]! - clean[i]!;
        n += 1;
      }
      return sum / n;
    };
    // Non-robust, a 15-unit spike shows up as 0.38 in every other day's
    // seasonal at that hour. Robust, it does not show up at all.
    expect(leak(0)).toBeGreaterThan(0.3);
    expect(Math.abs(leak(15))).toBeLessThan(0.01);
  });

  it('does not manufacture outliers from noise at its default span', () => {
    // At the paper's minimum seasonal span of 7 the robustness loop flagged
    // 26 of these 720 clean points; at the default it flags one.
    const y = seasonal(4);
    const beyond = (seasonalSpan?: number) => {
      const d = stl(y, { period: PERIOD, ...(seasonalSpan ? { seasonalSpan } : {}) });
      const scale = robustScale(d.remainder);
      return d.remainder.filter((r) => Math.abs(r) > 4 * scale).length;
    };
    expect(beyond(7)).toBe(26);
    expect(beyond()).toBe(1);
  });

  it('sees a point that is ordinary in size but wrong for its hour', () => {
    const y = seasonal(4);
    // At a trough, the value from the peak twelve hours earlier: well inside
    // the series' overall range, so the robust z on the raw series is silent.
    const trough = 18 + PERIOD * 20;
    const wrong = [...y];
    wrong[trough] = y[trough - 12]!;
    expect(robustZFirings(wrong).filter((f) => f.index === trough)).toEqual([]);
    const firing = stlFirings(wrong, { period: PERIOD }).find((f) => f.index === trough)!;
    expect(firing.severity).toBeGreaterThan(30);
    // Found by a decomposition that used points after it.
    expect(firing.retrospective).toBe(true);
  });

  it('marks only the last point as a live firing', () => {
    const y = seasonal(4);
    y[y.length - 1]! += 8;
    const firings = stlFirings(y, { period: PERIOD });
    const last = firings.find((f) => f.index === y.length - 1)!;
    expect(last.retrospective).toBeUndefined();
    for (const f of firings.filter((f) => f.index !== y.length - 1)) {
      expect(f.retrospective).toBe(true);
    }
  });

  it('fires rarely on clean seasonal noise: 19 times in 14,400 points', () => {
    let firings = 0;
    for (let seed = 110; seed < 130; seed++) firings += stlFirings(seasonal(seed), { period: PERIOD }).length;
    expect(firings).toBe(19);
  });

  it('refuses fewer than two cycles', () => {
    expect(() => stl(seasonal(4).slice(0, 30), { period: PERIOD })).toThrow(/two full cycles/);
  });
});
