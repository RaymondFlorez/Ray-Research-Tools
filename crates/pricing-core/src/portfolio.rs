//! Multi-asset Monte Carlo (PRD 5.8, `MonteCarloNode`).
//!
//! > Execution: 100k paths x 252 steps x 40 assets runs on Ray across the
//! > cluster; result matrices persist to S3 and the node holds a reference plus
//! > summary statistics, **so the browser never loads a 4GB array.**
//!
//! > Outputs: full `distribution` port (percentiles, moments, CVaR at
//! > configurable alpha, drawdown distribution) plus a path sample for
//! > visualization.
//!
//! The sentence that decides the design is the one about the 4GB array. A cube
//! of 100,000 paths by 252 steps by 40 assets is 8.06 GB of `f64`, and the
//! obvious implementation — march every path, keep the cube, reduce it
//! afterwards — cannot run in a browser and is unpleasant anywhere else. The
//! PRD's answer is to persist the matrix elsewhere and hold summary statistics;
//! this simulator's answer is that the summary statistics never needed the cube
//! in the first place.
//!
//! Everything on the `distribution` port is computable in one pass:
//!
//! - **Percentiles and CVaR** need the terminal portfolio values, one per path.
//! - **Moments** are sums of powers, accumulated as paths finish.
//! - **The drawdown distribution** needs each path's maximum drawdown, and a
//!   maximum drawdown is a running peak and a running worst — two `f64` carried
//!   along the path, not the path.
//! - **The path sample** is a fixed number of paths kept in full, and the PRD
//!   asks for a sample precisely because nobody can look at a hundred thousand.
//!
//! So what is retained is `2 * paths + sample * (steps + 1)` values rather than
//! `paths * steps * assets`. At the PRD's shape that is about 1.7 MB against
//! 8.06 GB, a factor of roughly 4,900, and `retained_values` on the result
//! reports it so the claim is a number rather than a paragraph.
//!
//! **Pseudorandom only, deliberately.** `mc::simulate` offers Sobol with a
//! Brownian bridge, and it is the right default for one asset. Here the
//! dimension is `steps * assets` — 10,080 at the PRD's shape — against
//! `MAX_SOBOL_DIMENSIONS` of 16. A Sobol sequence used far past its constructed
//! dimension is worse than pseudorandom, not better, and it converges without
//! a standard error to warn anyone. Offering the option would be offering a
//! trap, so there is no `sampling` field.
//!
//! **A process that ignores `w` is refused, not silently decorrelated.** The
//! dependence here is induced by correlating the Brownian increment each asset
//! receives, so a pure-jump process that builds its increment out of `extra`
//! instead gets none of it — and the result looks exactly like a correlated
//! simulation. Measured, at a requested correlation of 0.8: GBM pairs return
//! 0.79, Heston 0.67 and Merton 0.69, both diluted by their own independent
//! noise as they should be, and variance-gamma 0.0062 — identical to the last
//! digit to what it returns at a requested correlation of zero. `Process` now
//! answers `uses_brownian` and this refuses on it.
//!
//! **Antithetic pairing costs `steps * assets`, not `paths`.** The mirror of a
//! path is the same draw negated, which requires the draw, so one path's
//! normals are held: 10,080 values at the PRD's shape, 80 KB. Negating the
//! *independent* normals before correlating them is the same as negating the
//! correlated ones — `L(-z) = -(Lz)` — so the dependence structure survives the
//! mirror, which is the property that makes antithetic pairing legitimate here
//! at all.

use crate::copula::Factor;
use crate::mc::{Process, ProcessState};
use crate::rng::Rng;

/// One asset's starting point and its share of the portfolio.
#[derive(Clone, Copy, Debug)]
pub struct AssetSpec {
    pub spot: f64,
    /// Units held. The portfolio value is `sum(weight * level)`, so a short is
    /// a negative weight and the drawdown statistics follow it correctly.
    pub weight: f64,
    /// Initial instantaneous variance, for stochastic-volatility processes.
    pub initial_variance: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct PortfolioConfig {
    pub paths: usize,
    pub steps: usize,
    pub antithetic: bool,
    pub seed: u64,
    /// Paths kept in full for the visualization port.
    pub sample_paths: usize,
}

impl Default for PortfolioConfig {
    fn default() -> Self {
        PortfolioConfig { paths: 20_000, steps: 252, antithetic: true, seed: 0x5EED, sample_paths: 32 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortfolioError {
    /// `processes`, `assets` and the factor disagree about how many assets there are.
    Shape { processes: usize, assets: usize, factor: usize },
    /// Zero paths or zero steps. There is no sensible empty answer.
    Empty,
    /// An asset whose process does not consume the Brownian increment.
    ///
    /// Cross-asset dependence here is induced by correlating the `w` handed to
    /// each asset, so a pure-jump process that ignores `w` receives none of it.
    /// That failure is silent and looks exactly like a correlated simulation:
    /// measured, a variance-gamma pair asked for a correlation of 0.8 comes
    /// back at 0.0062, the same to the last digit as at zero. Refusing names
    /// the asset instead.
    NotDrivenByBrownian { asset: usize },
}

/// The `distribution` port, plus the sample.
#[derive(Clone, Debug)]
pub struct PortfolioResult {
    pub paths: usize,
    pub steps: usize,
    pub assets: usize,
    pub mean: f64,
    /// Sample variance of the terminal portfolio value.
    pub variance: f64,
    pub skewness: f64,
    /// Excess kurtosis: zero for a normal.
    pub excess_kurtosis: f64,
    /// Standard error of the mean, over antithetic *pairs* where they are used.
    pub standard_error: f64,
    /// Terminal portfolio values, sorted ascending.
    pub terminal: Vec<f64>,
    /// Per-path maximum drawdown, in portfolio currency, sorted ascending.
    ///
    /// Absolute rather than fractional, and that is a correction rather than a
    /// preference. The first version divided by the running peak, guarded with
    /// `if peak > 0.0` so it would not divide by zero — which means a portfolio
    /// whose peak is zero or negative reported a maximum drawdown of zero. A
    /// net-short book, or a spread with more written than bought, reaches that
    /// state routinely, and the guard turned "this position lost money all the
    /// way down" into "this position never drew down". A fraction of a peak
    /// that can be negative is not a quantity; peak minus trough always is.
    /// Callers wanting a percentage divide by whatever denominator they can
    /// defend, which is a decision they should be making rather than inheriting.
    pub drawdown: Vec<f64>,
    /// `sample_paths` rows of `steps + 1` portfolio values, row-major.
    pub sample: Vec<f64>,
    /// Values retained by this result.
    pub retained_values: usize,
    /// Values a materialized path cube would have held: `paths * steps * assets`.
    pub cube_values: usize,
}

impl PortfolioResult {
    /// Linear-interpolated percentile of the terminal value, `p` in [0, 1].
    pub fn percentile(&self, p: f64) -> f64 {
        interpolate(&self.terminal, p)
    }

    /// Percentile of the per-path maximum drawdown, in portfolio currency.
    pub fn drawdown_percentile(&self, p: f64) -> f64 {
        interpolate(&self.drawdown, p)
    }

    /// Mean of the worst `alpha` fraction of terminal values.
    ///
    /// The left tail, so `cvar(0.05)` is the expected value conditional on
    /// landing in the worst 5% — a loss figure, stated as a level rather than
    /// as a positive number, because the caller knows what it started with and
    /// a sign convention invented here would be one more thing to get wrong.
    pub fn cvar(&self, alpha: f64) -> f64 {
        if self.terminal.is_empty() {
            return f64::NAN;
        }
        let alpha = alpha.clamp(f64::EPSILON, 1.0);
        let count = ((self.terminal.len() as f64) * alpha).ceil().max(1.0) as usize;
        let count = count.min(self.terminal.len());
        self.terminal[..count].iter().sum::<f64>() / count as f64
    }

    /// One row of the sample, or `None` when the row was not kept.
    pub fn sample_path(&self, index: usize) -> Option<&[f64]> {
        let width = self.steps + 1;
        let start = index.checked_mul(width)?;
        if start + width > self.sample.len() {
            return None;
        }
        Some(&self.sample[start..start + width])
    }

    /// How much smaller the retained result is than the cube it never built.
    pub fn compression(&self) -> f64 {
        if self.retained_values == 0 {
            return f64::INFINITY;
        }
        self.cube_values as f64 / self.retained_values as f64
    }
}

fn interpolate(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let p = p.clamp(0.0, 1.0);
    let position = p * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = (lower + 1).min(sorted.len() - 1);
    let weight = position - lower as f64;
    sorted[lower] * (1.0 - weight) + sorted[upper] * weight
}

/// March a correlated portfolio and reduce it as it goes.
///
/// `processes` may be forty different models or forty copies of one; the
/// simulator only asks each for a step. `factor` is the Cholesky factor of the
/// asset correlation matrix, which refuses a matrix that is not positive
/// definite rather than nudging it — so an impossible correlation set fails
/// here, naming the block of assets that did it, instead of producing paths
/// nobody can interpret.
pub fn simulate_portfolio(
    processes: &[&dyn Process],
    assets: &[AssetSpec],
    factor: &Factor,
    time: f64,
    config: &PortfolioConfig,
) -> Result<PortfolioResult, PortfolioError> {
    let n = assets.len();
    if processes.len() != n || factor.dimension() != n || n == 0 {
        return Err(PortfolioError::Shape {
            processes: processes.len(),
            assets: n,
            factor: factor.dimension(),
        });
    }
    if config.paths == 0 || config.steps == 0 {
        return Err(PortfolioError::Empty);
    }
    if let Some(asset) = processes.iter().position(|p| !p.uses_brownian()) {
        return Err(PortfolioError::NotDrivenByBrownian { asset });
    }

    let steps = config.steps;
    let dt = time / steps as f64;
    let sqrt_dt = libm::sqrt(dt);

    let mut rng = Rng::new(config.seed);

    // Per-path scratch, allocated once. None of it is proportional to `paths`.
    let mut draw = vec![0.0; steps * n];
    let mut z = vec![0.0; n];
    let mut correlated = vec![0.0; n];
    let mut level = vec![0.0; n];
    let mut state = vec![ProcessState::default(); n];
    let extra_dims = processes.iter().map(|p| p.extra_dimensions()).max().unwrap_or(0);
    let mut step_extras = vec![0.0; extra_dims.max(1)];

    let mut terminal = Vec::with_capacity(config.paths);
    let mut drawdown = Vec::with_capacity(config.paths);
    let sample_paths = config.sample_paths.min(config.paths);
    let mut sample = vec![0.0; sample_paths * (steps + 1)];

    let initial: f64 = assets.iter().map(|a| a.weight * a.spot).sum();

    let mut done = 0usize;
    while done < config.paths {
        for value in draw.iter_mut() {
            *value = rng.next_normal();
        }

        let mirrors = if config.antithetic { 2 } else { 1 };
        for mirror in 0..mirrors {
            if done >= config.paths {
                break;
            }
            let sign = if mirror == 0 { 1.0 } else { -1.0 };

            for (i, asset) in assets.iter().enumerate() {
                level[i] = asset.spot;
                state[i] = ProcessState { variance: asset.initial_variance, time: 0.0, cursor: 0 };
            }

            let mut peak = initial;
            let mut worst = 0.0f64;
            let keep = done < sample_paths;
            if keep {
                sample[done * (steps + 1)] = initial;
            }

            for step in 0..steps {
                for i in 0..n {
                    z[i] = sign * draw[step * n + i];
                }
                factor.apply(&z, &mut correlated);

                let mut value = 0.0;
                for i in 0..n {
                    // Extra dimensions are drawn fresh rather than mirrored.
                    // A jump clock or a rejection-sampled gamma increment does
                    // not have a meaningful mirror — negating it is not the
                    // antithetic path, it is a different and wrong one — and
                    // `mc::simulate` documents the same limitation for the
                    // components that consume the rng directly.
                    for d in 0..extra_dims {
                        step_extras[d] = rng.next_normal();
                    }
                    let increment = correlated[i] * sqrt_dt;
                    level[i] = processes[i].step(
                        level[i],
                        &mut state[i],
                        dt,
                        increment,
                        &step_extras[..extra_dims.max(1)],
                        &mut rng,
                    );
                    state[i].time += dt;
                    value += assets[i].weight * level[i];
                }

                if value > peak {
                    peak = value;
                }
                let fall = peak - value;
                if fall > worst {
                    worst = fall;
                }
                if keep {
                    sample[done * (steps + 1) + step + 1] = value;
                }
            }

            terminal.push(assets.iter().enumerate().map(|(i, a)| a.weight * level[i]).sum());
            drawdown.push(worst);
            done += 1;
        }
    }

    // Moments before sorting, because sorting is about to destroy the pairing
    // the standard error depends on.
    let count = terminal.len() as f64;
    let mean = terminal.iter().sum::<f64>() / count;
    let mut m2 = 0.0;
    let mut m3 = 0.0;
    let mut m4 = 0.0;
    for value in &terminal {
        let d = value - mean;
        let d2 = d * d;
        m2 += d2;
        m3 += d2 * d;
        m4 += d2 * d2;
    }
    let variance = m2 / (count - 1.0).max(1.0);
    let population = m2 / count;
    let sigma = libm::sqrt(population);
    let skewness = if sigma > 0.0 { (m3 / count) / (sigma * sigma * sigma) } else { 0.0 };
    let excess_kurtosis =
        if population > 0.0 { (m4 / count) / (population * population) - 3.0 } else { 0.0 };

    // Antithetic paths come in negatively correlated pairs, so the independent
    // observation is the pair mean. Computing the error over paths ignores the
    // correlation the pairing exists to create — the same trap `mc::simulate`
    // fell into and records.
    let standard_error = {
        let independent: Vec<f64> = if config.antithetic && terminal.len() >= 2 {
            terminal.chunks(2).map(|pair| pair.iter().sum::<f64>() / pair.len() as f64).collect()
        } else {
            terminal.clone()
        };
        let m = independent.len() as f64;
        let centre = independent.iter().sum::<f64>() / m;
        let spread =
            independent.iter().map(|v| (v - centre) * (v - centre)).sum::<f64>() / (m - 1.0).max(1.0);
        libm::sqrt(spread / m)
    };

    terminal.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    drawdown.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));

    let retained_values = terminal.len() + drawdown.len() + sample.len();
    Ok(PortfolioResult {
        paths: config.paths,
        steps,
        assets: n,
        mean,
        variance,
        skewness,
        excess_kurtosis,
        standard_error,
        terminal,
        drawdown,
        sample,
        retained_values,
        cube_values: config.paths.saturating_mul(steps).saturating_mul(n),
    })
}
