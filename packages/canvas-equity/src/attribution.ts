/**
 * Factor attribution of a return series (PRD 5.8, the BacktestNode's outputs).
 *
 * > Outputs: equity curve, per-trade log, exposure over time, factor
 * > attribution, and a deflated Sharpe ratio ...
 *
 * ## The static decomposition is exact, and says so
 *
 * Regress the per-bar returns on the factors with an intercept. OLS with an
 * intercept leaves residuals that sum to zero, so over the window
 *
 * ```text
 * sum(r) = T * alpha + sum_k beta_k * sum(f_k)
 * ```
 *
 * holds to rounding, with nothing hidden in a residual line. That identity is
 * in additive return units. A backtest reports a *compounded* total, and the
 * two differ; the usual fix is to rescale the factor lines until they add up to
 * the compounded figure (Carino, Menchero), which makes every line a little
 * wrong so the total can be exactly right. Here the factor lines stay what the
 * regression says, and the compounding difference is reported as its own line.
 *
 * ## Static betas misread a strategy that changes its exposure
 *
 * One regression over the whole window gives one beta per factor. A strategy
 * long the market for half the window and short it for the other half has an
 * average beta near zero, and its market-driven P&L lands in alpha. The tests
 * measure exactly that. `rollingAttribution` estimates each bar's betas from
 * the bars before it only — no look-ahead — and attributes that bar's factor
 * returns with them; its residual does not sum to zero and is reported, not
 * folded into alpha.
 */

import { factorExposure, type FactorSeries } from './factors.js';

export interface AttributionLine {
  source: string;
  /** Contribution in additive return units: the sum of per-bar returns it explains. */
  contribution: number;
}

export interface Attribution {
  lines: AttributionLine[];
  /** Sum of per-bar returns over the window. */
  additiveTotal: number;
  /** The compounded total return, which is what an equity curve shows. */
  compoundedTotal: number;
  /** Compounded less additive: reported, not spread across the factors. */
  compounding: number;
  /** What the lines leave unexplained in additive units. Zero to rounding for the static fit. */
  residual: number;
  warnings: string[];
}

function compound(returns: readonly number[]): number {
  return returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** One regression over the window; the decomposition is exact by construction. */
export function factorAttribution(returns: readonly number[], factors: readonly FactorSeries[]): Attribution {
  const fit = factorExposure(returns, factors);
  const additiveTotal = returns.reduce((a, r) => a + r, 0);
  const lines: AttributionLine[] = [{ source: 'alpha', contribution: fit.alpha * returns.length }];
  for (const [i, exposure] of fit.exposures.entries()) {
    const sum = factors[i]!.values.reduce((a, f) => a + f, 0);
    lines.push({ source: exposure.factor, contribution: exposure.beta * sum });
  }
  const explained = lines.reduce((a, l) => a + l.contribution, 0);
  const compoundedTotal = compound(returns);
  return {
    lines,
    additiveTotal,
    compoundedTotal,
    compounding: compoundedTotal - additiveTotal,
    residual: additiveTotal - explained,
    warnings: [...fit.warnings],
  };
}

/**
 * Each bar attributed with betas estimated on the `window` bars before it.
 *
 * Bars inside the first window have no prior estimate and are left
 * unattributed — counted in the residual — rather than attributed with betas
 * fitted on themselves.
 */
export function rollingAttribution(
  returns: readonly number[],
  factors: readonly FactorSeries[],
  window: number,
): Attribution {
  const contributions = new Map<string, number>([['alpha', 0], ...factors.map((f) => [f.name, 0] as [string, number])]);
  const additiveTotal = returns.reduce((a, r) => a + r, 0);
  const compoundedTotal = compound(returns);
  const mismatched = factors.filter((f) => f.values.length !== returns.length);
  if (mismatched.length > 0) {
    // A short factor series would be read past its end as undefined and the
    // bar silently dropped; a long one would attribute with the wrong dates.
    return {
      lines: [...contributions.keys()].map((source) => ({ source, contribution: Number.NaN })),
      additiveTotal,
      compoundedTotal,
      compounding: compoundedTotal - additiveTotal,
      residual: Number.NaN,
      warnings: [
        `${mismatched.map((f) => f.name).join(', ')}: length does not match the ${returns.length} returns, ` +
          'so the factor and return series cannot be aligned bar for bar.',
      ],
    };
  }
  let explained = 0;
  for (let t = window; t < returns.length; t++) {
    const fit = factorExposure(
      returns.slice(t - window, t),
      factors.map((f) => ({ name: f.name, values: f.values.slice(t - window, t) })),
    );
    if (!Number.isFinite(fit.alpha)) continue;
    contributions.set('alpha', contributions.get('alpha')! + fit.alpha);
    explained += fit.alpha;
    for (const [i, exposure] of fit.exposures.entries()) {
      const c = exposure.beta * factors[i]!.values[t]!;
      contributions.set(exposure.factor, contributions.get(exposure.factor)! + c);
      explained += c;
    }
  }
  return {
    lines: [...contributions.entries()].map(([source, contribution]) => ({ source, contribution })),
    additiveTotal,
    compoundedTotal,
    compounding: compoundedTotal - additiveTotal,
    residual: additiveTotal - explained,
    warnings: [],
  };
}
