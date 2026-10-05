/**
 * Small dense linear algebra shared by the estimators. Not exported from the
 * package: these are means, not results.
 */

/**
 * Solves `A·x = b` by Gaussian elimination with partial pivoting.
 *
 * Returns `undefined` for a singular system, which here means the regressors
 * are collinear — a real answer about the data, not a numerical accident to
 * work around.
 */
export function solve(a: number[][], b: number[]): number[] | undefined {
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

