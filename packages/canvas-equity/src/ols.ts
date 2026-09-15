/**
 * Ordinary least squares, with the diagnostics exposed rather than hidden.
 *
 * PRD 5.3's rule for curve fitting — "a fit with poor residuals shows a warning
 * rather than a smooth lie" — is a house rule, not a curve rule, so every
 * regression in this package returns its R-squared and standard errors
 * alongside the coefficients and the callers surface them. A factor exposure
 * of 1.4 with an R-squared of 0.06 is not a factor exposure.
 *
 * Solved by Gaussian elimination on the normal equations. `X'X` for five or
 * six factors is tiny and well-conditioned once the columns are centered, and
 * the alternative — a QR decomposition — buys numerical stability this problem
 * size does not need at the cost of code nobody in this repo can check by eye.
 */

export interface Fit {
  /** Intercept first, then one per regressor column. */
  coefficients: number[];
  standardErrors: number[];
  tStats: number[];
  residuals: number[];
  rSquared: number;
  adjustedRSquared: number;
  /** Residual standard deviation. */
  sigma: number;
  observations: number;
  /** Set when the design is rank-deficient or too short to fit. */
  warning?: string;
}

export function ols(y: readonly number[], columns: ReadonlyArray<readonly number[]>): Fit {
  const n = y.length;
  const k = columns.length + 1;

  if (n <= k) {
    return degenerate(n, k, `${n} observations cannot fit ${k} parameters`);
  }
  for (const column of columns) {
    if (column.length !== n) return degenerate(n, k, 'regressor length does not match the response');
  }

  // Design matrix with the intercept column.
  const x: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row = [1];
    for (const column of columns) row.push(column[i] ?? Number.NaN);
    x.push(row);
  }

  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    const row = x[i]!;
    for (let a = 0; a < k; a += 1) {
      xty[a] = (xty[a] ?? 0) + (row[a] ?? 0) * (y[i] ?? 0);
      for (let b = 0; b < k; b += 1) {
        xtx[a]![b] = (xtx[a]![b] ?? 0) + (row[a] ?? 0) * (row[b] ?? 0);
      }
    }
  }

  const inverse = invert(xtx, k);
  if (!inverse) return degenerate(n, k, 'the regressors are collinear; no unique fit exists');

  const coefficients = new Array(k).fill(0).map((_, a) => {
    let total = 0;
    for (let b = 0; b < k; b += 1) total += (inverse[a]![b] ?? 0) * (xty[b] ?? 0);
    return total;
  });

  const residuals: number[] = [];
  let rss = 0;
  for (let i = 0; i < n; i += 1) {
    let fitted = 0;
    for (let a = 0; a < k; a += 1) fitted += (coefficients[a] ?? 0) * (x[i]![a] ?? 0);
    const residual = (y[i] ?? 0) - fitted;
    residuals.push(residual);
    rss += residual * residual;
  }

  const mean = y.reduce((a, b) => a + b, 0) / n;
  const tss = y.reduce((total, value) => total + (value - mean) ** 2, 0);
  const rSquared = tss === 0 ? Number.NaN : 1 - rss / tss;
  const variance = rss / (n - k);
  const sigma = Math.sqrt(variance);

  const standardErrors = coefficients.map((_, a) => Math.sqrt(variance * (inverse[a]![a] ?? 0)));
  const tStats = coefficients.map((c, a) => {
    const se = standardErrors[a] ?? 0;
    return se === 0 ? Number.NaN : c / se;
  });

  return {
    coefficients,
    standardErrors,
    tStats,
    residuals,
    rSquared,
    adjustedRSquared: 1 - (1 - rSquared) * ((n - 1) / (n - k)),
    sigma,
    observations: n,
  };
}

function degenerate(n: number, k: number, warning: string): Fit {
  return {
    coefficients: new Array(k).fill(Number.NaN),
    standardErrors: new Array(k).fill(Number.NaN),
    tStats: new Array(k).fill(Number.NaN),
    residuals: [],
    rSquared: Number.NaN,
    adjustedRSquared: Number.NaN,
    sigma: Number.NaN,
    observations: n,
    warning,
  };
}

/** Gauss-Jordan with partial pivoting. Returns undefined on a singular matrix. */
function invert(matrix: readonly number[][], k: number): number[][] | undefined {
  const a = matrix.map((row) => [...row]);
  const inverse: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let column = 0; column < k; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < k; row += 1) {
      if (Math.abs(a[row]![column] ?? 0) > Math.abs(a[pivot]![column] ?? 0)) pivot = row;
    }
    const value = a[pivot]![column] ?? 0;
    if (Math.abs(value) < 1e-12) return undefined;
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    [inverse[column], inverse[pivot]] = [inverse[pivot]!, inverse[column]!];

    const scale = a[column]![column] ?? 1;
    for (let j = 0; j < k; j += 1) {
      a[column]![j] = (a[column]![j] ?? 0) / scale;
      inverse[column]![j] = (inverse[column]![j] ?? 0) / scale;
    }
    for (let row = 0; row < k; row += 1) {
      if (row === column) continue;
      const factor = a[row]![column] ?? 0;
      if (factor === 0) continue;
      for (let j = 0; j < k; j += 1) {
        a[row]![j] = (a[row]![j] ?? 0) - factor * (a[column]![j] ?? 0);
        inverse[row]![j] = (inverse[row]![j] ?? 0) - factor * (inverse[column]![j] ?? 0);
      }
    }
  }
  return inverse;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((total, v) => total + (v - m) ** 2, 0) / (values.length - 1));
}
