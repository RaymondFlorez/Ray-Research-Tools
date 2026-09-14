//! Monte Carlo (PRD 5.8).
//!
//! "Processes: GBM, Heston, Merton jump-diffusion, variance-gamma, historical
//! bootstrap, stationary block bootstrap (Politis-Romano) ... Variance
//! reduction: antithetic variates, control variates against a closed-form-priced
//! instrument, quasi-random Sobol sequences with Brownian bridge construction."
//!
//! Every process here has to answer to something. GBM has a closed form in this
//! same crate, so `test::gbm_converges_to_black_scholes` prices a European call
//! both ways and checks they agree inside the simulation's own standard error —
//! which is a stronger statement than "close", because it says the error is the
//! sampling error and nothing else. Heston and Merton reduce to GBM when their
//! extra parameters go to zero, and those limits are tested too.
//!
//! **What is not here:** "100k paths x 252 steps x 40 assets runs on Ray across
//! the cluster; result matrices persist to S3". There is no Ray and no S3. What
//! is built is the per-path arithmetic those would distribute, and it runs in
//! one thread.

use crate::bsm::{Inputs, OptionType};
use crate::rng::{BrownianBridge, Rng, Sobol};

/// How the randomness is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sampling {
    /// Pseudorandom. Converges at 1/sqrt(N), and always works.
    Pseudo,
    /// Sobol with a Brownian bridge. Converges faster on smooth payoffs, and
    /// its error is not a standard error — quasi-random error is deterministic,
    /// so a confidence interval computed from it is a fiction.
    Quasi,
}

#[derive(Clone, Copy, Debug)]
pub struct McConfig {
    pub paths: usize,
    pub steps: usize,
    pub sampling: Sampling,
    /// Pair each path with its mirror image. Free variance reduction on any
    /// payoff that is monotone in the driving noise.
    pub antithetic: bool,
    pub seed: u64,
}

impl Default for McConfig {
    fn default() -> Self {
        McConfig { paths: 20_000, steps: 64, sampling: Sampling::Pseudo, antithetic: true, seed: 0x5EED }
    }
}

/// A price process that can be marched along a Brownian path.
pub trait Process {
    /// Extra normals per step beyond the one driving the asset.
    fn extra_dimensions(&self) -> usize {
        0
    }
    /// Advances one step. `w` is the Brownian increment for this step.
    ///
    /// `rng` is for processes whose increments need rejection sampling — a
    /// gamma clock cannot be produced from a fixed number of normals. Anything
    /// using it is pseudorandom in that component whatever `Sampling` says,
    /// because a rejection method consumes a variable number of draws and that
    /// destroys the dimension alignment a Sobol point depends on.
    fn step(
        &self,
        spot: f64,
        state: &mut ProcessState,
        dt: f64,
        w: f64,
        extra: &[f64],
        rng: &mut Rng,
    ) -> f64;
}

/// Anything a process needs to carry between steps.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessState {
    /// Instantaneous variance, for stochastic-volatility models.
    pub variance: f64,
    /// Accumulated jump compensator, for jump models.
    pub time: f64,
}

/// Geometric Brownian motion: the model everything else is measured against.
#[derive(Clone, Copy, Debug)]
pub struct Gbm {
    pub rate: f64,
    pub dividend: f64,
    pub vol: f64,
}

impl Process for Gbm {
    fn step(
        &self,
        spot: f64,
        _state: &mut ProcessState,
        dt: f64,
        w: f64,
        _extra: &[f64],
        _rng: &mut Rng,
    ) -> f64 {
        let drift = (self.rate - self.dividend - 0.5 * self.vol * self.vol) * dt;
        spot * libm::exp(drift + self.vol * w)
    }
}

/// Heston stochastic volatility, by full-truncation Euler.
///
/// Full truncation rather than reflection: when the discretised variance goes
/// negative — which it does, because the Feller condition rarely holds on
/// fitted parameters — truncation sets the diffusion to zero and lets mean
/// reversion pull it back, while reflection injects variance that is not in the
/// model. Truncation biases low and is the standard choice for that reason.
#[derive(Clone, Copy, Debug)]
pub struct Heston {
    pub rate: f64,
    pub dividend: f64,
    /// Long-run variance.
    pub theta: f64,
    /// Mean reversion speed.
    pub kappa: f64,
    /// Volatility of variance.
    pub sigma: f64,
    /// Correlation between the spot and variance shocks. Negative is the
    /// equity case, and is what produces a skew.
    pub rho: f64,
    pub initial_variance: f64,
}

impl Process for Heston {
    fn extra_dimensions(&self) -> usize {
        1
    }

    fn step(
        &self,
        spot: f64,
        state: &mut ProcessState,
        dt: f64,
        w: f64,
        extra: &[f64],
        _rng: &mut Rng,
    ) -> f64 {
        let variance = state.variance.max(0.0);
        let vol = libm::sqrt(variance);

        // Correlate the variance shock with the spot shock. `w` is already
        // scaled by sqrt(dt), so the independent part is scaled to match.
        let independent = extra.first().copied().unwrap_or(0.0) * libm::sqrt(dt);
        let w_variance = self.rho * w + libm::sqrt((1.0 - self.rho * self.rho).max(0.0)) * independent;

        state.variance = state.variance
            + self.kappa * (self.theta - variance) * dt
            + self.sigma * vol * w_variance;

        let drift = (self.rate - self.dividend - 0.5 * variance) * dt;
        spot * libm::exp(drift + vol * w)
    }
}

/// Merton jump diffusion: GBM plus a compound Poisson of lognormal jumps.
#[derive(Clone, Copy, Debug)]
pub struct Merton {
    pub rate: f64,
    pub dividend: f64,
    pub vol: f64,
    /// Jumps per year.
    pub intensity: f64,
    /// Mean of the log jump size.
    pub jump_mean: f64,
    /// Standard deviation of the log jump size.
    pub jump_vol: f64,
}

impl Process for Merton {
    fn extra_dimensions(&self) -> usize {
        // One uniform to count jumps, one normal to size them.
        2
    }

    fn step(
        &self,
        spot: f64,
        _state: &mut ProcessState,
        dt: f64,
        w: f64,
        extra: &[f64],
        _rng: &mut Rng,
    ) -> f64 {
        // The compensator keeps the discounted price a martingale: without it
        // the jumps add drift and the model no longer prices its own forward.
        let expected_jump = libm::exp(self.jump_mean + 0.5 * self.jump_vol * self.jump_vol) - 1.0;
        let drift = (self.rate - self.dividend - self.intensity * expected_jump
            - 0.5 * self.vol * self.vol)
            * dt;

        // Poisson count by inversion. Rates are small per step, so the loop
        // almost always exits at zero or one.
        let uniform = crate::normal::cdf(extra.first().copied().unwrap_or(0.0));
        let lambda_dt = self.intensity * dt;
        let mut count = 0.0;
        let mut cumulative = libm::exp(-lambda_dt);
        let mut term = cumulative;
        let mut k = 0.0;
        while cumulative < uniform && k < 32.0 {
            k += 1.0;
            term *= lambda_dt / k;
            cumulative += term;
            count = k;
        }

        let jump = if count > 0.0 {
            let z = extra.get(1).copied().unwrap_or(0.0);
            count * self.jump_mean + libm::sqrt(count) * self.jump_vol * z
        } else {
            0.0
        };

        spot * libm::exp(drift + self.vol * w + jump)
    }
}

/// Variance gamma: Brownian motion run on a gamma-distributed clock.
///
/// Pure jump, no diffusion — the "time" the asset experiences in a step is
/// itself random, which produces the fat tails and the skew without a second
/// Brownian factor.
#[derive(Clone, Copy, Debug)]
pub struct VarianceGamma {
    pub rate: f64,
    pub dividend: f64,
    /// Volatility of the subordinated Brownian motion.
    pub sigma: f64,
    /// Variance rate of the gamma clock. Higher means fatter tails.
    pub nu: f64,
    /// Drift of the subordinated Brownian motion. Negative produces a left skew.
    pub theta: f64,
}

impl Process for VarianceGamma {
    fn extra_dimensions(&self) -> usize {
        1
    }

    fn step(
        &self,
        spot: f64,
        _state: &mut ProcessState,
        dt: f64,
        _w: f64,
        extra: &[f64],
        rng: &mut Rng,
    ) -> f64 {
        // The gamma clock. Shape is dt/nu, which for any realistic step count
        // is well below one — a 32-step year at nu = 0.35 gives 0.09 — so this
        // has to be a sampler that is correct there rather than an expansion
        // that assumes a large shape. Wilson-Hilferty was the first attempt and
        // it produced terminal values twice the forward.
        let shape = dt / self.nu.max(1e-12);
        let gamma = sample_gamma(shape, rng) * self.nu;

        // The martingale correction for the VG process.
        let omega = libm::log(1.0 - self.theta * self.nu - 0.5 * self.sigma * self.sigma * self.nu)
            / self.nu;
        let normal = extra.first().copied().unwrap_or(0.0);
        let increment = self.theta * gamma + self.sigma * libm::sqrt(gamma) * normal;
        spot * libm::exp((self.rate - self.dividend + omega) * dt + increment)
    }
}

/// A Gamma(shape, 1) variate by Marsaglia-Tsang, with the small-shape boost.
///
/// Rejection sampling, so it consumes an unpredictable number of draws. That is
/// why it takes the stream rather than a slice of pre-drawn normals, and why a
/// process using it cannot be driven by a Sobol point.
fn sample_gamma(shape: f64, rng: &mut Rng) -> f64 {
    if shape <= 0.0 {
        return 0.0;
    }
    if shape < 1.0 {
        // Gamma(a) = Gamma(a+1) * U^(1/a), which is exact rather than an
        // approximation, and is what makes the sub-unit shapes correct.
        let boosted = sample_gamma(shape + 1.0, rng);
        return boosted * libm::pow(rng.next_uniform(), 1.0 / shape);
    }

    let d = shape - 1.0 / 3.0;
    let c = 1.0 / libm::sqrt(9.0 * d);
    loop {
        let z = rng.next_normal();
        let v = 1.0 + c * z;
        if v <= 0.0 {
            continue;
        }
        let v3 = v * v * v;
        let u = rng.next_uniform();
        if libm::log(u) < 0.5 * z * z + d - d * v3 + d * libm::log(v3) {
            return d * v3;
        }
    }
}

/// What a simulation reports.
#[derive(Clone, Debug)]
pub struct McResult {
    pub mean: f64,
    /// Standard error of the mean. Meaningless under quasi-random sampling, and
    /// reported as NaN there rather than as a number that invites a confidence
    /// interval the sequence cannot support.
    pub standard_error: f64,
    pub paths: usize,
    /// The terminal values, for percentiles and tail statistics.
    pub terminal: Vec<f64>,
    /// Payoff per path, before discounting.
    pub payoffs: Vec<f64>,
}

impl McResult {
    pub fn percentile(&self, p: f64) -> f64 {
        if self.terminal.is_empty() {
            return f64::NAN;
        }
        let mut sorted = self.terminal.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let position = (sorted.len() - 1) as f64 * p.clamp(0.0, 1.0);
        let lower = position as usize;
        let upper = (lower + 1).min(sorted.len() - 1);
        let weight = position - lower as f64;
        sorted[lower] * (1.0 - weight) + sorted[upper] * weight
    }

    /// Mean of the worst `alpha` tail of the payoff distribution.
    pub fn cvar(&self, alpha: f64) -> f64 {
        if self.payoffs.is_empty() {
            return f64::NAN;
        }
        let mut sorted = self.payoffs.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let cut = ((sorted.len() as f64 * alpha) as usize).max(1);
        sorted[..cut].iter().sum::<f64>() / cut as f64
    }
}

/// A variate with a known expectation, used to cancel shared error.
pub type ControlVariate = (fn(f64) -> f64, f64);

/// Runs a simulation, applying `payoff` to each path's terminal value.
///
/// `control` supplies a variate with a known expectation; supplying one cancels
/// the part of the error the two share. PRD 5.8 asks for "control variates
/// against a closed-form-priced instrument", and the natural choice is the
/// terminal spot itself, whose expectation under the risk-neutral measure is
/// the forward.
pub fn simulate<P: Process>(
    process: &P,
    spot: f64,
    time: f64,
    config: &McConfig,
    initial_variance: f64,
    payoff: impl Fn(f64) -> f64,
    control: Option<ControlVariate>,
) -> McResult {
    let steps = config.steps.max(1);
    let dt = time / steps as f64;
    let sqrt_dt = libm::sqrt(dt);
    let extra_dims = process.extra_dimensions();

    let bridge = BrownianBridge::new(steps);
    let mut rng = Rng::new(config.seed);
    let mut sobol = Sobol::new((steps + extra_dims * steps).min(crate::rng::MAX_SOBOL_DIMENSIONS));

    let mut normals = vec![0.0; steps];
    let mut extras = vec![0.0; extra_dims.max(1) * steps];
    let mut path = vec![0.0; steps];
    let mut sobol_point = vec![0.0; sobol.dimensions()];

    let mut terminal = Vec::with_capacity(config.paths);
    let mut payoffs = Vec::with_capacity(config.paths);
    let mut controls = Vec::with_capacity(config.paths);

    let mut drawn = 0usize;
    while drawn < config.paths {
        // Draw once; use it twice when antithetic.
        match config.sampling {
            Sampling::Pseudo => {
                for value in normals.iter_mut() {
                    *value = rng.next_normal();
                }
                for value in extras.iter_mut() {
                    *value = rng.next_normal();
                }
            }
            Sampling::Quasi => {
                sobol.next_normals(&mut sobol_point);
                for (i, value) in normals.iter_mut().enumerate() {
                    *value = sobol_point.get(i).copied().unwrap_or_else(|| rng.next_normal());
                }
                for (i, value) in extras.iter_mut().enumerate() {
                    *value = sobol_point.get(steps + i).copied().unwrap_or_else(|| rng.next_normal());
                }
            }
        }

        let mirrors = if config.antithetic { 2 } else { 1 };
        for mirror in 0..mirrors {
            if drawn >= config.paths {
                break;
            }
            let sign = if mirror == 0 { 1.0 } else { -1.0 };

            // The bridge builds a standard Brownian path; scaling to the real
            // timescale happens on the increments below.
            let signed: Vec<f64> = normals.iter().map(|z| sign * z).collect();
            bridge.build(&signed, &mut path);

            let mut state = ProcessState { variance: initial_variance, time: 0.0 };
            let mut level = spot;
            let mut previous = 0.0;
            let mut step_extras = vec![0.0; extra_dims.max(1)];
            for step in 0..steps {
                let increment = (path[step] - previous) * sqrt_dt;
                previous = path[step];
                for d in 0..extra_dims {
                    step_extras[d] = sign * extras[step * extra_dims.max(1) + d];
                }
                level = process.step(level, &mut state, dt, increment, &step_extras, &mut rng);
                state.time += dt;
            }

            terminal.push(level);
            payoffs.push(payoff(level));
            if let Some((f, _)) = control {
                controls.push(f(level));
            }
            drawn += 1;
        }
    }

    let n = payoffs.len().max(1) as f64;
    let mut adjusted = payoffs.clone();

    // Control variate: regress the payoff on the control and subtract the part
    // the control explains. The optimal coefficient is the regression slope, so
    // a useless control costs nothing rather than adding noise.
    if let Some((_, expectation)) = control {
        let mean_payoff = payoffs.iter().sum::<f64>() / n;
        let mean_control = controls.iter().sum::<f64>() / n;
        let mut covariance = 0.0;
        let mut variance = 0.0;
        for i in 0..payoffs.len() {
            let dc = controls[i] - mean_control;
            covariance += (payoffs[i] - mean_payoff) * dc;
            variance += dc * dc;
        }
        if variance > 0.0 {
            let beta = covariance / variance;
            for i in 0..adjusted.len() {
                adjusted[i] -= beta * (controls[i] - expectation);
            }
        }
    }

    let mean = adjusted.iter().sum::<f64>() / n;

    // Antithetic paths come in negatively correlated pairs, so the independent
    // observation is the *pair mean*, not the path. Computing the error over
    // paths ignores the correlation the pairing exists to create, and reports
    // the variance reduction as though it had not happened — which is what the
    // first version did, and why its antithetic test showed no improvement.
    let independent: Vec<f64> = if config.antithetic && adjusted.len() >= 2 {
        adjusted.chunks(2).map(|pair| pair.iter().sum::<f64>() / pair.len() as f64).collect()
    } else {
        adjusted.clone()
    };

    let standard_error = if config.sampling == Sampling::Quasi {
        // A Sobol sequence is deterministic, so the spread of its points is not
        // a sampling distribution and a standard error computed from it would
        // be a confidence interval with no probability behind it.
        f64::NAN
    } else {
        let m = independent.len() as f64;
        let mean_of_pairs = independent.iter().sum::<f64>() / m;
        let variance = independent
            .iter()
            .map(|p| (p - mean_of_pairs) * (p - mean_of_pairs))
            .sum::<f64>()
            / (m - 1.0).max(1.0);
        libm::sqrt(variance / m)
    };

    McResult { mean, standard_error, paths: payoffs.len(), terminal, payoffs: adjusted }
}

/// A European option by Monte Carlo, discounted.
pub fn european_mc<P: Process>(
    process: &P,
    inputs: &Inputs,
    config: &McConfig,
    initial_variance: f64,
    control: bool,
) -> McResult {
    let strike = inputs.strike;
    let kind = inputs.kind;
    let discount = libm::exp(-inputs.rate * inputs.time);
    let forward = inputs.spot * libm::exp((inputs.rate - inputs.dividend) * inputs.time);

    let mut result = simulate(
        process,
        inputs.spot,
        inputs.time,
        config,
        initial_variance,
        move |terminal| match kind {
            OptionType::Call => (terminal - strike).max(0.0),
            OptionType::Put => (strike - terminal).max(0.0),
        },
        // The terminal spot itself: its expectation is the forward, exactly, and
        // it is strongly correlated with any vanilla payoff.
        if control { Some(((|s: f64| s) as fn(f64) -> f64, forward)) } else { None },
    );

    result.mean *= discount;
    result.standard_error *= discount;
    result
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::bsm;

    fn call(spot: f64, strike: f64, time: f64, vol: f64) -> Inputs {
        Inputs { spot, strike, time, rate: 0.04, dividend: 0.015, vol, kind: OptionType::Call }
    }

    /// The check the whole file answers to.
    ///
    /// GBM has a closed form in this crate, so the simulation can be held to
    /// its own standard error rather than to a tolerance someone chose. Three
    /// standard errors is a 99.7% interval; a simulation that misses it is not
    /// noisy, it is wrong.
    #[test]
    fn gbm_converges_to_black_scholes() {
        for &(moneyness, time, vol) in &[
            (0.8, 0.5, 0.25),
            (1.0, 1.0, 0.30),
            (1.2, 2.0, 0.40),
            (1.0, 0.25, 0.15),
        ] {
            let inputs = call(100.0, 100.0 * moneyness, time, vol);
            let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
            let config = McConfig { paths: 200_000, steps: 32, ..Default::default() };
            let result = european_mc(&process, &inputs, &config, 0.0, true);
            let exact = bsm::price(&inputs);

            let error = libm::fabs(result.mean - exact);
            assert!(
                error < 3.0 * result.standard_error.max(1e-9),
                "K/S {moneyness}: mc {} vs exact {exact}, error {error:e} against 3se {:e}",
                result.mean,
                3.0 * result.standard_error,
            );
        }
    }

    /// Variance reduction has to actually reduce variance, or it is decoration.
    #[test]
    fn the_control_variate_shrinks_the_error() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
        let config = McConfig { paths: 40_000, steps: 16, antithetic: false, ..Default::default() };

        let plain = european_mc(&process, &inputs, &config, 0.0, false);
        let controlled = european_mc(&process, &inputs, &config, 0.0, true);
        assert!(
            controlled.standard_error < plain.standard_error * 0.8,
            "control variate barely helped: {} vs {}",
            controlled.standard_error,
            plain.standard_error,
        );
    }

    #[test]
    fn antithetic_pairing_shrinks_the_error_too() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
        let base = McConfig { paths: 40_000, steps: 16, antithetic: false, ..Default::default() };
        let paired = McConfig { antithetic: true, ..base };

        let plain = european_mc(&process, &inputs, &base, 0.0, false);
        let mirrored = european_mc(&process, &inputs, &paired, 0.0, false);
        assert!(
            mirrored.standard_error < plain.standard_error,
            "antithetic {} vs plain {}",
            mirrored.standard_error,
            plain.standard_error,
        );
    }

    /// Sobol should beat pseudorandom at the same path count on a smooth payoff.
    #[test]
    fn quasi_random_converges_faster() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
        let exact = bsm::price(&inputs);

        let pseudo = european_mc(
            &process,
            &inputs,
            &McConfig { paths: 8192, steps: 8, sampling: Sampling::Pseudo, antithetic: false, seed: 11 },
            0.0,
            false,
        );
        let quasi = european_mc(
            &process,
            &inputs,
            &McConfig { paths: 8192, steps: 8, sampling: Sampling::Quasi, antithetic: false, seed: 11 },
            0.0,
            false,
        );

        assert!(quasi.standard_error.is_nan(), "a quasi-random spread is not a standard error");
        assert!(
            libm::fabs(quasi.mean - exact) < libm::fabs(pseudo.mean - exact),
            "quasi {} vs pseudo {} against exact {exact}",
            quasi.mean,
            pseudo.mean,
        );
    }

    /// Heston with no vol-of-vol is GBM, and has to price like it.
    #[test]
    fn heston_reduces_to_black_scholes_when_the_variance_stops_moving() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Heston {
            rate: inputs.rate,
            dividend: inputs.dividend,
            theta: 0.09,
            kappa: 0.0,
            sigma: 0.0,
            rho: 0.0,
            initial_variance: 0.09,
        };
        let config = McConfig { paths: 100_000, steps: 64, ..Default::default() };
        let result = european_mc(&process, &inputs, &config, 0.09, true);
        let exact = bsm::price(&inputs);
        assert!(
            libm::fabs(result.mean - exact) < 4.0 * result.standard_error.max(1e-9),
            "heston {} vs bs {exact}",
            result.mean,
        );
    }

    /// A negative correlation has to produce a left skew, or the model is not
    /// doing the one thing it is chosen for.
    #[test]
    fn heston_correlation_produces_skew() {
        let config = McConfig { paths: 60_000, steps: 64, ..Default::default() };
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let make = |rho: f64| Heston {
            rate: inputs.rate,
            dividend: inputs.dividend,
            theta: 0.09,
            kappa: 2.0,
            sigma: 0.5,
            rho,
            initial_variance: 0.09,
        };

        let symmetric = european_mc(&make(0.0), &inputs, &config, 0.09, false);
        let skewed = european_mc(&make(-0.7), &inputs, &config, 0.09, false);

        // A left skew fattens the downside and thins the upside, so an
        // out-of-the-money put is worth more and the low percentile is lower.
        assert!(skewed.percentile(0.01) < symmetric.percentile(0.01),
            "1st percentile: skewed {} vs symmetric {}", skewed.percentile(0.01), symmetric.percentile(0.01));
    }

    /// Merton with no jumps is GBM.
    #[test]
    fn merton_reduces_to_black_scholes_without_jumps() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Merton {
            rate: inputs.rate,
            dividend: inputs.dividend,
            vol: inputs.vol,
            intensity: 0.0,
            jump_mean: 0.0,
            jump_vol: 0.0,
        };
        let config = McConfig { paths: 100_000, steps: 32, ..Default::default() };
        let result = european_mc(&process, &inputs, &config, 0.0, true);
        assert!(libm::fabs(result.mean - bsm::price(&inputs)) < 4.0 * result.standard_error.max(1e-9));
    }

    /// Jumps have to fatten the tails without moving the forward.
    #[test]
    fn merton_jumps_fatten_the_tails_and_keep_the_forward() {
        let inputs = call(100.0, 100.0, 1.0, 0.25);
        let config = McConfig { paths: 120_000, steps: 64, ..Default::default() };
        let jumpy = Merton {
            rate: inputs.rate,
            dividend: inputs.dividend,
            vol: 0.2,
            intensity: 1.0,
            jump_mean: -0.08,
            jump_vol: 0.15,
        };
        let result = european_mc(&jumpy, &inputs, &config, 0.0, false);

        // The compensator's job: the mean terminal value is still the forward.
        let forward = inputs.spot * libm::exp((inputs.rate - inputs.dividend) * inputs.time);
        let mean_terminal = result.terminal.iter().sum::<f64>() / result.terminal.len() as f64;
        assert!(
            libm::fabs(mean_terminal / forward - 1.0) < 0.02,
            "mean terminal {mean_terminal} against forward {forward}",
        );

        // And the tail is fatter than a diffusion of the same total variance.
        let plain = european_mc(
            &Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: 0.2 },
            &inputs,
            &config,
            0.0,
            false,
        );
        assert!(result.percentile(0.005) < plain.percentile(0.005));
    }

    #[test]
    fn variance_gamma_keeps_the_forward_and_skews_left() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let config = McConfig { paths: 120_000, steps: 32, ..Default::default() };
        let vg = VarianceGamma {
            rate: inputs.rate,
            dividend: inputs.dividend,
            sigma: 0.22,
            nu: 0.35,
            theta: -0.25,
        };
        let result = european_mc(&vg, &inputs, &config, 0.0, false);
        let forward = inputs.spot * libm::exp((inputs.rate - inputs.dividend) * inputs.time);
        let mean_terminal = result.terminal.iter().sum::<f64>() / result.terminal.len() as f64;
        assert!(
            libm::fabs(mean_terminal / forward - 1.0) < 0.05,
            "mean terminal {mean_terminal} against forward {forward}",
        );
        // Left skew, tested as a controlled comparison rather than as a shape.
        // In absolute price terms the upside tail is longer whatever theta does,
        // because a lognormal-ish distribution is bounded below at zero and
        // unbounded above — so measuring the raw distances tests lognormality,
        // not the parameter. What theta controls is where the *downside* goes.
        let symmetric = european_mc(
            &VarianceGamma { theta: 0.0, ..vg },
            &inputs,
            &config,
            0.0,
            false,
        );
        assert!(
            result.percentile(0.01) < symmetric.percentile(0.01),
            "negative theta should deepen the left tail: {} vs {}",
            result.percentile(0.01),
            symmetric.percentile(0.01),
        );
    }

    #[test]
    fn reports_percentiles_and_a_tail() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
        let result = european_mc(&process, &inputs, &McConfig { paths: 20_000, ..Default::default() }, 0.0, false);
        assert!(result.percentile(0.05) < result.percentile(0.5));
        assert!(result.percentile(0.5) < result.percentile(0.95));
        // A long call's worst tail is worthless, not negative.
        assert!(result.cvar(0.05) >= 0.0);
    }

    #[test]
    fn the_same_seed_is_the_same_simulation() {
        let inputs = call(100.0, 100.0, 1.0, 0.3);
        let process = Gbm { rate: inputs.rate, dividend: inputs.dividend, vol: inputs.vol };
        let config = McConfig { paths: 5_000, steps: 16, ..Default::default() };
        let a = european_mc(&process, &inputs, &config, 0.0, true);
        let b = european_mc(&process, &inputs, &config, 0.0, true);
        assert_eq!(a.mean, b.mean);
    }
}
