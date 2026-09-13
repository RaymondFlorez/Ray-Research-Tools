/**
 * Causal elasticity estimation (PRD Appendix C.3).
 *
 * "Decision: local projection (Jordà) with Newey-West standard errors, 10-year
 * default window, regime split shown automatically. VAR is offered only for
 * closed systems of three or more mutually causal nodes."
 *
 * C.3 gives the reason, and it is about what the *object* is rather than what
 * the econometrics prefers: "A causal edge in Picasso means 'a shock to A moves
 * B by X, h periods later.' That is literally the local projection coefficient
 * at horizon h. A VAR requires you to specify a system, estimate it, and then
 * read impulse responses out of it, which imposes dynamic structure the analyst
 * never asserted."
 *
 * Two defaults here are not really defaults, because the PRD forbids hiding
 * them:
 *
 *  - **Newey-West, always.** A horizon-h local projection has residuals that are
 *    MA(h) *by construction* — the same shock appears in overlapping windows —
 *    so ordinary standard errors are too small at exactly the horizons an
 *    analyst cares about, and they are too small in the direction that makes a
 *    weak edge look strong.
 *  - **The regime split is not optional.** PRD 5.6: "a single elasticity
 *    averaged across a structural break is usually the most confidently wrong
 *    number on the canvas."
 */

/** A fitted coefficient, with everything needed to disbelieve it. */
export interface Coefficient {
  /** Response of `y` to a one-unit shock in `x`, at this horizon. */
  value: number;
  /** Newey-West standard error, robust to the overlap the horizon creates. */
  standardError: number;
  /** `value / standardError`. Roughly a t-statistic. */
  tStatistic: number;
  rSquared: number;
  observations: number;
  /** Bartlett bandwidth actually used. */
  bandwidth: number;
}

export interface LocalProjectionOptions {
  /** Horizons to estimate, in periods. Defaults to 0 through 12. */
  horizons?: readonly number[];
  /**
   * Lags of `y` and `x` included as controls.
   *
   * PRD 5.6 puts lag structure in "an advanced drawer and set to sensible
   * defaults", and four is the sensible default for monthly-ish data: enough to
   * absorb the obvious autocorrelation, few enough not to eat the sample.
   */
  controlLags?: number;
  /**
   * Newey-West bandwidth. Defaults to `horizon + 1`, which is the MA order the
   * overlap induces — the standard choice for local projections rather than a
   * rule of thumb borrowed from a different problem.
   */
  bandwidth?: number;
}

/** The impulse response: one coefficient per horizon. */
export interface ImpulseResponse {
  horizons: number[];
  coefficients: Coefficient[];
  /** The horizon at which the response is largest in absolute value. */
  peakHorizon: number;
  peak: Coefficient;
}

/**
 * Solves `A·x = b` by Gaussian elimination with partial pivoting.
 *
 * Returns `undefined` for a singular system, which here means the regressors
 * are collinear — a real answer about the data, not a numerical accident to
 * work around.
 */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs((m[row] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) {
        pivot = row;
      }
    }
    const pivotRow = m[pivot] as number[];
    if (Math.abs(pivotRow[col] as number) < 1e-12) return undefined;
    m[pivot] = m[col] as number[];
    m[col] = pivotRow;
    for (let row = col + 1; row < n; row += 1) {
      const target = m[row] as number[];
      const factor = (target[col] as number) / (pivotRow[col] as number);
      for (let k = col; k <= n; k += 1) {
        target[k] = (target[k] as number) - factor * (pivotRow[k] as number);
      }
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let col = n - 1; col >= 0; col -= 1) {
    const row = m[col] as number[];
    let sum = row[n] as number;
    for (let k = col + 1; k < n; k += 1) sum -= (row[k] as number) * (x[k] as number);
    x[col] = sum / (row[col] as number);
  }
  return x.every(Number.isFinite) ? x : undefined;
}

/** OLS with a Newey-West covariance for the first slope. */
interface Regression {
  beta: number[];
  residuals: number[];
  rSquared: number;
  xtxInverseFirst: number[];
  design: number[][];
}

function regress(design: number[][], y: number[]): Regression | undefined {
  const n = y.length;
  const k = (design[0] ?? []).length;
  if (n <= k + 1) return undefined;

  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let t = 0; t < n; t += 1) {
    const row = design[t] as number[];
    for (let i = 0; i < k; i += 1) {
      xty[i] = (xty[i] as number) + (row[i] as number) * (y[t] as number);
      for (let j = 0; j < k; j += 1) {
        (xtx[i] as number[])[j] = ((xtx[i] as number[])[j] as number) + (row[i] as number) * (row[j] as number);
      }
    }
  }

  const beta = solve(xtx.map((row) => [...row]), [...xty]);
  if (!beta) return undefined;

  const residuals = new Array<number>(n).fill(0);
  let ssr = 0;
  let mean = 0;
  for (const value of y) mean += value;
  mean /= n;
  let sst = 0;
  for (let t = 0; t < n; t += 1) {
    const row = design[t] as number[];
    let fitted = 0;
    for (let i = 0; i < k; i += 1) fitted += (row[i] as number) * (beta[i] as number);
    const u = (y[t] as number) - fitted;
    residuals[t] = u;
    ssr += u * u;
    sst += ((y[t] as number) - mean) ** 2;
  }

  // The first column of (X'X)^-1, which is all the sandwich needs for the one
  // coefficient the edge actually reports.
  const unit = new Array<number>(k).fill(0);
  unit[0] = 1;
  const xtxInverseFirst = solve(xtx.map((row) => [...row]), unit);
  if (!xtxInverseFirst) return undefined;

  return {
    beta,
    residuals,
    rSquared: sst === 0 ? 0 : Math.max(0, 1 - ssr / sst),
    xtxInverseFirst,
    design,
  };
}

/**
 * Newey-West standard error of the first coefficient.
 *
 * The sandwich `(X'X)⁻¹ S (X'X)⁻¹` with `S` built from Bartlett-weighted
 * autocovariances of the score. The weights decline linearly to zero at the
 * bandwidth, which is what keeps the estimate positive semi-definite — a
 * truncated sum without them can return a negative variance, and a standard
 * error that comes back as NaN is worse than a conservative one.
 */
function neweyWest(fit: Regression, bandwidth: number): number {
  const n = fit.residuals.length;
  const k = fit.xtxInverseFirst.length;
  const a = fit.xtxInverseFirst;

  // The scalar score for the first coefficient: a'x_t · u_t.
  const score = new Array<number>(n).fill(0);
  for (let t = 0; t < n; t += 1) {
    const row = fit.design[t] as number[];
    let projected = 0;
    for (let i = 0; i < k; i += 1) projected += (a[i] as number) * (row[i] as number);
    score[t] = projected * (fit.residuals[t] as number);
  }

  let variance = 0;
  for (const s of score) variance += s * s;
  for (let lag = 1; lag <= bandwidth; lag += 1) {
    let covariance = 0;
    for (let t = lag; t < n; t += 1) {
      covariance += (score[t] as number) * (score[t - lag] as number);
    }
    variance += 2 * (1 - lag / (bandwidth + 1)) * covariance;
  }

  // Degrees-of-freedom correction, so a short window is not flattered.
  const scaled = (variance * n) / Math.max(1, n - k);
  return Math.sqrt(Math.max(0, scaled));
}

/**
 * One local projection: the response of `y` to `x`, `horizon` periods later.
 *
 * The regression is `y_{t+h} = β·x_t + controls + ε`, which is the definition
 * of the coefficient a causal edge claims. Controls are `controlLags` lags of
 * both series plus a constant.
 */
export function localProjection(
  x: readonly number[],
  y: readonly number[],
  horizon: number,
  options: LocalProjectionOptions = {},
): Coefficient | undefined {
  const lags = options.controlLags ?? 4;
  const n = Math.min(x.length, y.length);
  const start = lags;
  const end = n - horizon;
  if (end - start < 2 * lags + 6) return undefined;

  const design: number[][] = [];
  const response: number[] = [];
  for (let t = start; t < end; t += 1) {
    // The shock first, so the sandwich only has to invert for column zero.
    const row = [x[t] as number, 1];
    for (let lag = 1; lag <= lags; lag += 1) {
      row.push(y[t - lag] as number, x[t - lag] as number);
    }
    design.push(row);
    response.push(y[t + horizon] as number);
  }

  const fit = regress(design, response);
  if (!fit) return undefined;

  const bandwidth = options.bandwidth ?? horizon + 1;
  const standardError = neweyWest(fit, bandwidth);
  const value = fit.beta[0] as number;
  return {
    value,
    standardError,
    tStatistic: standardError > 0 ? value / standardError : 0,
    rSquared: fit.rSquared,
    observations: response.length,
    bandwidth,
  };
}

/** The whole impulse response, horizon by horizon. */
export function impulseResponse(
  x: readonly number[],
  y: readonly number[],
  options: LocalProjectionOptions = {},
): ImpulseResponse | undefined {
  const horizons = options.horizons ?? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
  const coefficients: Coefficient[] = [];
  const kept: number[] = [];
  for (const horizon of horizons) {
    const fitted = localProjection(x, y, horizon, options);
    if (!fitted) continue;
    kept.push(horizon);
    coefficients.push(fitted);
  }
  if (coefficients.length === 0) return undefined;

  let peakIndex = 0;
  for (let i = 1; i < coefficients.length; i += 1) {
    if (Math.abs((coefficients[i] as Coefficient).value) > Math.abs((coefficients[peakIndex] as Coefficient).value)) {
      peakIndex = i;
    }
  }
  return {
    horizons: kept,
    coefficients,
    peakHorizon: kept[peakIndex] as number,
    peak: coefficients[peakIndex] as Coefficient,
  };
}
