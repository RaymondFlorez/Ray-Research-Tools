/**
 * The anomaly detectors (PRD 3.6).
 *
 * > **Anomaly halos.** The `alert-engine` runs three detector families over
 * > every watched series: robust z-score on rolling median absolute deviation,
 * > changepoint detection (BOCPD), and a seasonal residual model (STL) for
 * > series with intraday or weekly structure.
 *
 * Three families, because they see three different things. A robust z sees a
 * point that is far from its neighbours. BOCPD sees that the neighbours
 * themselves have changed — a level or a variance that moved and stayed. STL
 * sees a point that is ordinary in size but wrong for its hour of the day. Each
 * is blind to what the others catch, which the tests show rather than assert.
 *
 * Every detector reports `severity` in the same unit — robust standard
 * deviations of the thing it measures — because the digest ranks events
 * across families (`DetectorEvent.severity` in `canvas-agents`), and a ranking
 * across incomparable scores is a ranking of which detector shouts loudest.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Makes the MAD a consistent estimator of the standard deviation under normality. */
export const MAD_TO_SIGMA = 1.4826;

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Robust scale: 1.4826 times the median absolute deviation. */
export function robustScale(values: readonly number[]): number {
  const m = median(values);
  return MAD_TO_SIGMA * median(values.map((v) => Math.abs(v - m)));
}

/**
 * log Gamma by Lanczos (g = 7, n = 9), for the Student-t predictive below.
 *
 * Checked in the tests against values that do not come from this function:
 * `ln Gamma(n) = ln (n-1)!` and `ln Gamma(1/2) = ln sqrt(pi)`.
 */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: Gamma(x) Gamma(1-x) = pi / sin(pi x).
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = c[0]!;
  for (let i = 1; i < g + 2; i++) sum += c[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

export type DetectorFamily = 'robust_z' | 'bocpd' | 'stl_residual';

export interface Firing {
  family: DetectorFamily;
  /** Index into the series. */
  index: number;
  /** Robust standard deviations, comparable across families. */
  severity: number;
  /** What the detector saw, in words. */
  detail: string;
  /**
   * Set when the firing used points that arrived after it.
   *
   * STL is a batch decomposition: its trend at an interior point is smoothed
   * over both sides. Re-reading history with it is useful and is not what an
   * alert at that moment could have said, so those firings carry the flag and
   * the live alert is the one at the last index.
   */
  retrospective?: true;
}

// ---------------------------------------------------------------------------
// 1. Robust z on a rolling MAD
// ---------------------------------------------------------------------------

export interface RobustZOptions {
  /** Trailing points the baseline is taken from. */
  window?: number;
  /** Fire at or above this many robust standard deviations. */
  threshold?: number;
}

export const ROBUST_Z_WINDOW = 60;
export const ROBUST_Z_THRESHOLD = 4;

/**
 * Each point's distance from the median of the window *before* it.
 *
 * Before, not around. A window that includes the point being scored lets a
 * spike move its own median and inflate its own MAD, which shrinks the z of
 * exactly the point it exists to flag; on a 20-point window a single 10-sigma
 * spike scored against a window containing itself reads noticeably smaller.
 *
 * A window with zero MAD — a price stuck on one tick for an hour, a rate that
 * has not been reset — has no scale, and dividing by zero would make every
 * subsequent tick infinitely anomalous. Those points are scored `NaN` and never
 * fire: the detector has nothing to say about a series with no dispersion.
 */
export function robustZ(series: readonly number[], options: RobustZOptions = {}): number[] {
  const window = options.window ?? ROBUST_Z_WINDOW;
  return series.map((value, i) => {
    if (i < window) return Number.NaN;
    const base = series.slice(i - window, i);
    const scale = robustScale(base);
    if (!(scale > 0)) return Number.NaN;
    return (value - median(base)) / scale;
  });
}

export function robustZFirings(series: readonly number[], options: RobustZOptions = {}): Firing[] {
  const threshold = options.threshold ?? ROBUST_Z_THRESHOLD;
  const z = robustZ(series, options);
  const firings: Firing[] = [];
  for (const [index, score] of z.entries()) {
    if (!(Math.abs(score) >= threshold)) continue;
    firings.push({
      family: 'robust_z',
      index,
      severity: Math.abs(score),
      detail: `${score.toFixed(1)} robust sd from the trailing ${options.window ?? ROBUST_Z_WINDOW}-point median`,
    });
  }
  return firings;
}

// ---------------------------------------------------------------------------
// 2. Bayesian online changepoint detection
// ---------------------------------------------------------------------------

export interface BocpdOptions {
  /** Expected run length between changes: the hazard is its reciprocal. */
  expectedRunLength?: number;
  /** Points used to scale the prior. */
  warmup?: number;
  /** Run lengths beyond this are merged into the last bucket. */
  maxRunLength?: number;
  /** A change "within the last `lag` points" is what is scored. */
  lag?: number;
  /** Fire when that probability reaches this. */
  threshold?: number;
}

export const BOCPD_EXPECTED_RUN = 250;
export const BOCPD_WARMUP = 30;
export const BOCPD_MAX_RUN = 400;
/**
 * Ten points. Five was tried first and missed a three-sigma level shift
 * outright: the posterior needs a few points in the new regime to be
 * convinced, and by then the new run is already five long and outside the
 * window it is being looked for in.
 */
export const BOCPD_LAG = 10;
export const BOCPD_THRESHOLD = 0.5;

interface Nig {
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
}

function studentLogPdf(x: number, p: Nig): number {
  const nu = 2 * p.alpha;
  const scale2 = (p.beta * (p.kappa + 1)) / (p.alpha * p.kappa);
  const d = (x - p.mu) * (x - p.mu) / (nu * scale2);
  return (
    logGamma((nu + 1) / 2) -
    logGamma(nu / 2) -
    0.5 * Math.log(nu * Math.PI * scale2) -
    ((nu + 1) / 2) * Math.log1p(d)
  );
}

function update(p: Nig, x: number): Nig {
  return {
    mu: (p.kappa * p.mu + x) / (p.kappa + 1),
    kappa: p.kappa + 1,
    alpha: p.alpha + 0.5,
    beta: p.beta + (p.kappa * (x - p.mu) * (x - p.mu)) / (2 * (p.kappa + 1)),
  };
}

export interface BocpdStep {
  /** Posterior probability that a change happened within the last `lag` points. */
  recentChange: number;
  /** The most probable run length overall. */
  mapRunLength: number;
  /** The most probable run length among those shorter than `lag`: where the change was. */
  recentRunLength: number;
}

/**
 * Adams and MacKay (2007), with a Normal-Inverse-Gamma model for each run.
 *
 * The run-length posterior is carried in log space and truncated at
 * `maxRunLength`, so a step costs a fixed amount however long the series is;
 * mass past the cap is merged into the last bucket rather than dropped, which
 * would renormalise it into the short run lengths and read as a change.
 *
 * The prior is scaled from the first `warmup` points — their median and their
 * robust variance — so the same detector means the same thing on a series in
 * basis points and one in dollars. A fixed unit prior would make one of them
 * see changes everywhere and the other nowhere.
 *
 * Under a constant hazard, P(r_t = 0) equals the hazard at every step and says
 * nothing, which is the usual first surprise with this algorithm. What moves is
 * the mass on *short* run lengths, so the score is the probability that the
 * current run began within the last `lag` points.
 */
export function bocpd(series: readonly number[], options: BocpdOptions = {}): BocpdStep[] {
  const hazard = 1 / (options.expectedRunLength ?? BOCPD_EXPECTED_RUN);
  const warmup = Math.min(options.warmup ?? BOCPD_WARMUP, series.length);
  const cap = options.maxRunLength ?? BOCPD_MAX_RUN;
  const lag = options.lag ?? BOCPD_LAG;

  const head = series.slice(0, warmup);
  const scale = robustScale(head);
  const variance = scale > 0 ? scale * scale : 1;
  const prior: Nig = { mu: median(head), kappa: 1, alpha: 1, beta: variance };

  let logR: number[] = [0];
  let params: Nig[] = [prior];
  const logH = Math.log(hazard);
  const log1mH = Math.log1p(-hazard);
  const out: BocpdStep[] = [];

  for (const x of series) {
    const logPred = params.map((p) => studentLogPdf(x, p));
    const growth = logR.map((lr, r) => lr + logPred[r]! + log1mH);
    const change = logSumExp(logR.map((lr, r) => lr + logPred[r]! + logH));
    let next = [change, ...growth];
    let nextParams = [prior, ...params.map((p) => update(p, x))];
    if (next.length > cap) {
      // Merge the tail into the last bucket instead of dropping it.
      const tail = logSumExp(next.slice(cap - 1));
      next = [...next.slice(0, cap - 1), tail];
      nextParams = nextParams.slice(0, cap);
    }
    const norm = logSumExp(next);
    logR = next.map((v) => v - norm);
    params = nextParams;

    let recent = 0;
    let best = 0;
    let bestRecent = 0;
    for (let r = 0; r < logR.length; r++) {
      const p = Math.exp(logR[r]!);
      if (r < lag) {
        recent += p;
        if (logR[r]! > logR[bestRecent]!) bestRecent = r;
      }
      if (logR[r]! > logR[best]!) best = r;
    }
    out.push({ recentChange: recent, mapRunLength: best, recentRunLength: bestRecent });
  }
  return out;
}

function logSumExp(values: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > max) max = v;
  if (max === Number.NEGATIVE_INFINITY) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/**
 * One firing per change, not one per step above the threshold.
 *
 * The recent-change probability stays high for `lag` steps after a change by
 * construction, so every step over the threshold is the same event. A firing
 * is emitted when the probability first crosses and not again until it has
 * fallen back below.
 *
 * Severity is how far the new points sit from the old regime: the median
 * absolute distance of the points since the change from the earlier run's
 * median, in the earlier run's robust standard deviations. One measure covers
 * both kinds of change — a level shift of three sd scores about 3, a variance
 * that trebled scores about 2 — where a difference of medians would score a
 * variance change at zero. With nothing changed it reads about 0.67, the
 * median of a standard normal's absolute value.
 */
export function bocpdFirings(series: readonly number[], options: BocpdOptions = {}): Firing[] {
  const threshold = options.threshold ?? BOCPD_THRESHOLD;
  const warmup = options.warmup ?? BOCPD_WARMUP;
  const steps = bocpd(series, options);
  const firings: Firing[] = [];
  let armed = true;
  let lastChange = 0;
  for (const [index, step] of steps.entries()) {
    if (index < warmup) continue;
    if (step.recentChange < threshold) {
      armed = true;
      continue;
    }
    if (!armed) continue;
    armed = false;
    // Where the change was: the likeliest *short* run, not the likeliest run.
    // At the step the probability crosses, the old long run is often still the
    // single most probable one, and measuring from it scored a three-sigma
    // level shift at 0.67 — the severity of nothing having happened.
    const start = Math.max(lastChange, index - 2 * BOCPD_MAX_RUN);
    const changeAt = Math.max(index - step.recentRunLength, start + 1);
    const before = series.slice(Math.max(start, changeAt - 60), changeAt);
    // Only what has arrived by `index`: the detector runs online, and scoring
    // a firing with points that come after it is look-ahead in the alert
    // engine of all places.
    const after = series.slice(changeAt, index + 1);
    const scale = robustScale(before);
    const centre = median(before);
    const distance = median(after.map((x) => Math.abs(x - centre)));
    const severity = scale > 0 ? distance / scale : Number.POSITIVE_INFINITY;
    firings.push({
      family: 'bocpd',
      index,
      severity,
      detail:
        `the series changed regime ${index - changeAt} point(s) ago; new points sit ` +
        `${severity.toFixed(1)} robust sd from the old level`,
    });
    lastChange = changeAt;
  }
  return firings;
}

// ---------------------------------------------------------------------------
// 3. STL residual
// ---------------------------------------------------------------------------

export interface StlOptions {
  /** Points per seasonal cycle: 24 for hourly data with a daily cycle. */
  period: number;
  /**
   * Seasonal smoothing span, odd and at least 7. Cleveland et al.'s n_s.
   *
   * Defaults to the number of cycles in the series (odd, at least 7): a
   * seasonal pattern allowed to drift slowly across the window, not one
   * re-estimated from each week's neighbours. See `stl` for why the paper's
   * minimum is the wrong default here.
   */
  seasonalSpan?: number;
  /** Trend smoothing span. Defaults to the paper's rule from `period` and `seasonalSpan`. */
  trendSpan?: number;
  /** Low-pass span. Defaults to the smallest odd number at least `period`. */
  lowpassSpan?: number;
  /** Robustness iterations. The paper's robust default is 15; zero disables. */
  outer?: number;
}

export interface Stl {
  trend: number[];
  seasonal: number[];
  remainder: number[];
  /** The final robustness weights: near zero where a point was treated as an outlier. */
  weights: number[];
}

function odd(n: number): number {
  const c = Math.ceil(n);
  return c % 2 === 1 ? c : c + 1;
}

/**
 * Local linear loess on equally spaced points, evaluated at `x0`.
 *
 * `x0` may lie outside the data, which the cycle-subseries step needs: it
 * extends each subseries one period either side. With `span` larger than the
 * data the bandwidth is widened as in the paper, by half the excess.
 */
function loessAt(y: readonly number[], w: readonly number[], span: number, x0: number): number {
  const n = y.length;
  const q = Math.min(span, n);
  let lo = Math.round(x0) - (q >> 1);
  lo = Math.max(0, Math.min(lo, n - q));
  const hi = lo + q - 1;
  let h = Math.max(Math.abs(x0 - lo), Math.abs(hi - x0));
  if (span > n) h += (span - n) / 2;
  if (!(h > 0)) h = 1;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const u = Math.abs(i - x0) / (h * 1.000001);
    if (u >= 1) continue;
    const t = 1 - u * u * u;
    const wi = t * t * t * w[i]!;
    if (!(wi > 0)) continue;
    sw += wi;
    sx += wi * i;
    sy += wi * y[i]!;
    sxx += wi * i * i;
    sxy += wi * i * y[i]!;
  }
  if (!(sw > 0)) return Number.NaN;
  const mx = sx / sw;
  const my = sy / sw;
  const vxx = sxx / sw - mx * mx;
  if (!(vxx > 1e-12)) return my;
  const slope = (sxy / sw - mx * my) / vxx;
  return my + slope * (x0 - mx);
}

function movingAverage(y: readonly number[], length: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < y.length; i++) {
    sum += y[i]!;
    if (i >= length) sum -= y[i - length]!;
    if (i >= length - 1) out.push(sum / length);
  }
  return out;
}

/**
 * Seasonal-trend decomposition by loess (Cleveland, Cleveland, McRae and
 * Terpenning, 1990), with its robustness iterations.
 *
 * Robust by default, because the reason this runs is to find points that do
 * not belong, and the non-robust version absorbs them: a spike leaks into the
 * seasonal component at its own phase and shows up, smaller, in every cycle.
 * The tests measure how much.
 *
 * The robustness iterations have a failure of their own, which measurement
 * found. At the paper's minimum seasonal span of 7, on thirty daily cycles of
 * clean Gaussian noise, fifteen iterations flagged 26 of 720 points beyond four
 * robust sd where the non-robust fit flagged none. The loop feeds itself: a
 * point downweighted once drops out of its subseries fit, its residual grows,
 * and it is downweighted harder. A seasonal span close to the number of cycles
 * breaks the loop — one flagged point at 25, as Gaussian noise predicts — so
 * that is the default, and the minimum is left to callers who have a reason.
 */
export function stl(series: readonly number[], options: StlOptions): Stl {
  const n = series.length;
  const np = options.period;
  if (!(np >= 2) || n < 2 * np) {
    throw new Error(`STL needs at least two full cycles: ${n} points, period ${np}`);
  }
  const ns = odd(Math.max(options.seasonalSpan ?? Math.floor(n / np), 7));
  const nl = options.lowpassSpan ?? odd(np);
  const nt = options.trendSpan ?? odd((1.5 * np) / (1 - 1.5 / ns));
  const outer = options.outer ?? 15;
  const inner = outer > 0 ? 1 : 2;

  let trend = new Array<number>(n).fill(0);
  let seasonal = new Array<number>(n).fill(0);
  let weights = new Array<number>(n).fill(1);

  for (let o = 0; o <= outer; o++) {
    for (let it = 0; it < inner; it++) {
      const detrended = series.map((v, i) => v - trend[i]!);

      // Cycle-subseries smoothing, each extended one period either side.
      const c = new Array<number>(n + 2 * np).fill(0);
      for (let j = 0; j < np; j++) {
        const sub: number[] = [];
        const sw: number[] = [];
        for (let t = j; t < n; t += np) {
          sub.push(detrended[t]!);
          sw.push(weights[t]!);
        }
        for (let k = -1; k <= sub.length; k++) {
          c[(k + 1) * np + j] = loessAt(sub, sw, ns, k);
        }
      }

      // Low-pass filter of the cycle-subseries: MA(np), MA(np), MA(3), loess.
      const low1 = movingAverage(c, np);
      const low2 = movingAverage(low1, np);
      const low3 = movingAverage(low2, 3);
      const ones = new Array<number>(low3.length).fill(1);
      const lowpass = low3.map((_, i) => loessAt(low3, ones, nl, i));

      seasonal = series.map((_, i) => c[np + i]! - lowpass[i]!);
      const deseasonal = series.map((v, i) => v - seasonal[i]!);
      trend = deseasonal.map((_, i) => loessAt(deseasonal, weights, nt, i));
    }
    if (o === outer) break;
    const remainder = series.map((v, i) => v - trend[i]! - seasonal[i]!);
    const h = 6 * median(remainder.map(Math.abs));
    weights = remainder.map((r) => {
      if (!(h > 0)) return 1;
      const u = Math.abs(r) / h;
      if (u >= 1) return 0;
      const b = 1 - u * u;
      return b * b;
    });
  }

  const remainder = series.map((v, i) => v - trend[i]! - seasonal[i]!);
  return { trend, seasonal, remainder, weights };
}

export interface StlFiringOptions extends StlOptions {
  threshold?: number;
}

/**
 * Points whose remainder is large against the remainder's own robust scale.
 *
 * A point can be ordinary in size and wrong for its hour — the overnight print
 * at the daytime level — and only a seasonal model sees that. Every firing but
 * one at the last index is marked `retrospective`: the decomposition used
 * points on both sides of it.
 */
export function stlFirings(series: readonly number[], options: StlFiringOptions): Firing[] {
  const threshold = options.threshold ?? ROBUST_Z_THRESHOLD;
  const { remainder } = stl(series, options);
  const scale = robustScale(remainder);
  if (!(scale > 0)) return [];
  const centre = median(remainder);
  const firings: Firing[] = [];
  for (const [index, r] of remainder.entries()) {
    const z = (r - centre) / scale;
    if (!(Math.abs(z) >= threshold)) continue;
    const firing: Firing = {
      family: 'stl_residual',
      index,
      severity: Math.abs(z),
      detail: `${z.toFixed(1)} robust sd from what this point of the cycle usually looks like`,
    };
    if (index !== series.length - 1) firing.retrospective = true;
    firings.push(firing);
  }
  return firings;
}
