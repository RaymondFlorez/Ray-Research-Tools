/**
 * `FactorExposureNode` (PRD 5.2).
 *
 * "Fama-French 5 plus quality, plus a custom factor builder."
 *
 * The regression is four lines. Everything else in this file is about the
 * three ways a factor exposure lies to you, and it is worth being explicit
 * that the node's value is in the diagnostics rather than in the betas:
 *
 * 1. **A beta with no fit behind it.** An exposure of 1.4 on a regression with
 *    an R-squared of 0.06 is a number, not an exposure. It is reported with
 *    the R-squared attached and a warning below a floor.
 * 2. **Collinear factors.** HML and CMA are correlated enough in most samples
 *    that their individual loadings swing wildly while the fit barely moves.
 *    The variance inflation factor per regressor is computed and surfaced,
 *    because a loading with a VIF of 12 is not measuring what its name says.
 * 3. **A window chosen after the fact.** Nothing here can fix that, but the
 *    window and the observation count travel with the result so a reader can
 *    see how much sample the number rests on.
 *
 * The custom factor builder takes any series and runs it as an extra column.
 * It does not get special treatment: a custom factor is checked for collinear
 * with the standard set exactly like the standard ones are, and an analyst who
 * builds "quality" out of the same inputs as RMW will see a VIF that says so.
 */

import { ols, type Fit } from './ols.js';

export type StandardFactor = 'mkt' | 'smb' | 'hml' | 'rmw' | 'cma' | 'quality';

export const FAMA_FRENCH_5: readonly StandardFactor[] = ['mkt', 'smb', 'hml', 'rmw', 'cma'];
export const FF5_PLUS_QUALITY: readonly StandardFactor[] = [...FAMA_FRENCH_5, 'quality'];

export interface FactorSeries {
  name: string;
  values: readonly number[];
}

export interface Exposure {
  factor: string;
  beta: number;
  standardError: number;
  tStat: number;
  /** Variance inflation: how much this loading's variance is blown up by the
   *  other regressors. 1 is orthogonal; above 5 is worth reading twice. */
  vif: number;
}

export interface FactorExposure {
  alpha: number;
  alphaStandardError: number;
  alphaTStat: number;
  exposures: Exposure[];
  rSquared: number;
  adjustedRSquared: number;
  residualVolatility: number;
  observations: number;
  window?: [string, string];
  warnings: string[];
}

/** Below this, the loadings are not describing the return series. */
export const WEAK_FIT_R2 = 0.2;
/** Above this, a loading is mostly measuring its neighbours. */
export const HIGH_VIF = 5;

export function factorExposure(
  returns: readonly number[],
  factors: readonly FactorSeries[],
  window?: [string, string],
): FactorExposure {
  const columns = factors.map((f) => f.values);
  const fit = ols(returns, columns);
  const warnings: string[] = [];

  if (fit.warning !== undefined) {
    warnings.push(fit.warning);
    return {
      alpha: Number.NaN,
      alphaStandardError: Number.NaN,
      alphaTStat: Number.NaN,
      exposures: factors.map((f) => ({
        factor: f.name,
        beta: Number.NaN,
        standardError: Number.NaN,
        tStat: Number.NaN,
        vif: Number.NaN,
      })),
      rSquared: Number.NaN,
      adjustedRSquared: Number.NaN,
      residualVolatility: Number.NaN,
      observations: returns.length,
      ...(window ? { window } : {}),
      warnings,
    };
  }

  const vifs = varianceInflation(columns);
  const exposures: Exposure[] = factors.map((factor, i) => ({
    factor: factor.name,
    beta: fit.coefficients[i + 1] ?? Number.NaN,
    standardError: fit.standardErrors[i + 1] ?? Number.NaN,
    tStat: fit.tStats[i + 1] ?? Number.NaN,
    vif: vifs[i] ?? Number.NaN,
  }));

  if (Number.isFinite(fit.rSquared) && fit.rSquared < WEAK_FIT_R2) {
    warnings.push(
      `R-squared is ${fit.rSquared.toFixed(2)}. These loadings explain little of the return series, ` +
        'so they describe the factors more than they describe the position.',
    );
  }

  const collinear = exposures.filter((e) => !Number.isNaN(e.vif) && e.vif > HIGH_VIF);
  if (collinear.length > 0) {
    warnings.push(
      `${collinear.map((e) => `${e.factor} (VIF ${Number.isFinite(e.vif) ? e.vif.toFixed(1) : 'infinite'})`).join(', ')}: ` +
        'these loadings are largely determined by the other factors, and their individual values will ' +
        'swing on small changes to the window while the fit barely moves.',
    );
  }

  return {
    alpha: fit.coefficients[0] ?? Number.NaN,
    alphaStandardError: fit.standardErrors[0] ?? Number.NaN,
    alphaTStat: fit.tStats[0] ?? Number.NaN,
    exposures,
    rSquared: fit.rSquared,
    adjustedRSquared: fit.adjustedRSquared,
    residualVolatility: fit.sigma,
    observations: fit.observations,
    ...(window ? { window } : {}),
    warnings,
  };
}

/**
 * VIF per regressor: `1 / (1 - R^2)` from regressing it on the others.
 *
 * With a single regressor there is nothing to be collinear with, so it is 1 by
 * definition rather than by a special case that happens to return 1.
 */
export function varianceInflation(columns: ReadonlyArray<readonly number[]>): number[] {
  if (columns.length < 2) return columns.map(() => 1);
  return columns.map((target, i) => {
    const others = columns.filter((_, j) => j !== i);
    const fit: Fit = ols(target, others);
    // An exactly collinear column has a variance inflation of infinity, which
    // is both the correct answer and the one that trips the high-VIF warning.
    // Returning NaN here would make the column silently drop out of the check
    // precisely when it is most broken.
    if (fit.warning !== undefined) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(fit.rSquared)) return Number.POSITIVE_INFINITY;
    // A clamp at 1 - 1e-12 would report 1e12 here, which is finite and reads
    // like a measurement. It is not one: the column is a linear combination of
    // the others and its variance inflation is unbounded. Say that.
    if (1 - fit.rSquared <= 1e-12) return Number.POSITIVE_INFINITY;
    return 1 / (1 - fit.rSquared);
  });
}
