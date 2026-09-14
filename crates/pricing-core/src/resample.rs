//! Historical and stationary block bootstrap (PRD 5.8).
//!
//! "Processes: ... historical bootstrap, stationary block bootstrap
//! (Politis-Romano) ..."
//!
//! Both are one algorithm with one parameter. Efron's iid bootstrap draws a
//! fresh observation every step; Politis and Romano's stationary bootstrap
//! (1994) draws a fresh observation with probability `p` and otherwise
//! continues the block it is in, wrapping at the end of the series. Block
//! lengths are then geometric with mean `1/p`, and the iid bootstrap is the
//! `p = 1` case. Writing them as one thing is not tidiness: it makes the
//! comparison in `tests` an A/B on a single parameter, which is what shows
//! that the block structure is doing the work.
//!
//! **Why the geometric block length matters.** The obvious block bootstrap
//! cuts the series into fixed blocks of length `b` and glues sampled blocks
//! together. The resulting series is not stationary: a point at position 0 is
//! always the start of a block and a point at position `b-1` is always the
//! end, so the joint distribution of neighbouring pairs depends on where in
//! the resample you look. Geometric lengths make the probability of a join
//! the same `p` at every position, which is exactly what "stationary" means
//! here, and `join_positions_are_uniform` measures it rather than asserting it.
//!
//! **What a bootstrap cannot do.** Resampling reproduces the dependence the
//! window contained and nothing else. A series whose only crash is in the
//! window will produce resamples with about that many crashes; a window
//! without one produces none, however long the simulation runs. The block
//! length also trades off: too short and the long-run variance is
//! underestimated because dependence is broken too often, too long and the
//! resamples are near-copies of the original. `long_run_variance_needs_a_long_
//! enough_block` measures that bias instead of hiding it.

use crate::mc::{Process, ProcessState};
use crate::rng::Rng;

/// A resampler over observed period returns.
///
/// `returns` are log returns at the frequency they were observed, and the
/// simulation steps at that same frequency. There is no time scaling here on
/// purpose: rescaling a daily return to a weekly step by `sqrt(5)` assumes the
/// independence the bootstrap exists to avoid assuming.
#[derive(Clone, Copy, Debug)]
pub struct Bootstrap<'a> {
    returns: &'a [f64],
    /// Probability of starting a new block at each step. `1.0` is iid.
    restart: f64,
}

impl<'a> Bootstrap<'a> {
    /// Efron's iid bootstrap: every step is an independent draw.
    pub fn iid(returns: &'a [f64]) -> Bootstrap<'a> {
        Bootstrap { returns, restart: 1.0 }
    }

    /// Politis-Romano with the given expected block length, in steps.
    ///
    /// A mean block below 1 is meaningless and is clamped to the iid case
    /// rather than producing a restart probability above 1, which would
    /// silently behave like iid anyway but with a number in it that lies.
    pub fn stationary(returns: &'a [f64], mean_block: f64) -> Bootstrap<'a> {
        let restart = if mean_block <= 1.0 { 1.0 } else { 1.0 / mean_block };
        Bootstrap { returns, restart }
    }

    pub fn restart_probability(&self) -> f64 {
        self.restart
    }

    pub fn mean_block(&self) -> f64 {
        1.0 / self.restart
    }

    pub fn observations(&self) -> usize {
        self.returns.len()
    }

    fn draw_index(&self, rng: &mut Rng) -> usize {
        let n = self.returns.len();
        if n == 0 {
            return 0;
        }
        // Scaling a uniform is enough here and keeps the draw to one call; the
        // modulo bias of the alternative is worse than the rounding of this.
        let u = rng.next_uniform();
        let index = (u * n as f64) as usize;
        if index >= n {
            n - 1
        } else {
            index
        }
    }

    /// Fill `out` with one resampled path of period returns.
    ///
    /// Returns the number of blocks the path was built from, which is what the
    /// tests measure the geometry against.
    pub fn resample(&self, out: &mut [f64], rng: &mut Rng) -> usize {
        if self.returns.is_empty() {
            for slot in out.iter_mut() {
                *slot = 0.0;
            }
            return 0;
        }
        let n = self.returns.len();
        let mut cursor = 0usize;
        let mut blocks = 0usize;
        for (step, slot) in out.iter_mut().enumerate() {
            let start_new = step == 0 || rng.next_uniform() < self.restart;
            if start_new {
                cursor = self.draw_index(rng);
                blocks += 1;
            } else {
                // The wrap is what makes the resample stationary: without it
                // the tail of the series would be reachable only as the end of
                // a block.
                cursor = (cursor + 1) % n;
            }
            *slot = self.returns[cursor];
        }
        blocks
    }

    /// Positions at which a path built with this RNG state starts a new block.
    ///
    /// Exposed for the stationarity measurement, which needs to see where the
    /// joins land rather than only how many there are.
    pub fn join_positions(&self, steps: usize, rng: &mut Rng, out: &mut Vec<usize>) {
        out.clear();
        if self.returns.is_empty() {
            return;
        }
        for step in 0..steps {
            let start_new = step == 0 || rng.next_uniform() < self.restart;
            if start_new {
                let _ = self.draw_index(rng);
                if step > 0 {
                    out.push(step);
                }
            }
        }
    }
}

/// The bootstrap as a Monte Carlo process.
///
/// `w` and `extra` are ignored: a resampled return is not a function of a
/// normal increment. That makes this process pseudorandom whatever `Sampling`
/// says, for the same reason the variance-gamma process is — it consumes draws
/// from the stream in a pattern a Sobol point cannot be aligned to.
impl<'a> Process for Bootstrap<'a> {
    fn step(
        &self,
        spot: f64,
        state: &mut ProcessState,
        _dt: f64,
        _w: f64,
        _extra: &[f64],
        rng: &mut Rng,
    ) -> f64 {
        if self.returns.is_empty() {
            return spot;
        }
        let n = self.returns.len();
        let first = state.time == 0.0;
        state.time += 1.0;
        let start_new = first || rng.next_uniform() < self.restart;
        let cursor = if start_new {
            self.draw_index(rng)
        } else {
            (state.cursor + 1) % n
        };
        state.cursor = cursor;
        spot * libm::exp(self.returns[cursor])
    }
}

/// Sample autocorrelation at `lag`.
pub fn autocorrelation(series: &[f64], lag: usize) -> f64 {
    if series.len() <= lag + 1 {
        return f64::NAN;
    }
    let n = series.len() as f64;
    let mean = series.iter().sum::<f64>() / n;
    let mut numerator = 0.0;
    let mut denominator = 0.0;
    for i in 0..series.len() {
        let centered = series[i] - mean;
        denominator += centered * centered;
        if i + lag < series.len() {
            numerator += centered * (series[i + lag] - mean);
        }
    }
    if denominator == 0.0 {
        f64::NAN
    } else {
        numerator / denominator
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An AR(1) series, which has a known autocorrelation and a known long-run
    /// variance, so the resamples can be checked against something.
    fn ar1(n: usize, phi: f64, sigma: f64, seed: u64) -> Vec<f64> {
        let mut rng = Rng::new(seed);
        let mut x = 0.0;
        let mut out = Vec::with_capacity(n);
        // Burn in, so the series starts from the stationary distribution
        // rather than from zero.
        for _ in 0..500 {
            x = phi * x + sigma * rng.next_normal();
        }
        for _ in 0..n {
            x = phi * x + sigma * rng.next_normal();
            out.push(x);
        }
        out
    }

    fn mean(v: &[f64]) -> f64 {
        v.iter().sum::<f64>() / v.len() as f64
    }

    fn variance(v: &[f64]) -> f64 {
        let m = mean(v);
        v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (v.len() as f64 - 1.0)
    }

    #[test]
    fn the_iid_case_is_the_stationary_case_at_block_one() {
        let data = [0.1, -0.2, 0.3];
        assert_eq!(Bootstrap::iid(&data).restart_probability(), 1.0);
        assert_eq!(Bootstrap::stationary(&data, 1.0).restart_probability(), 1.0);
        assert_eq!(Bootstrap::stationary(&data, 0.5).restart_probability(), 1.0);
    }

    #[test]
    fn mean_block_length_matches_the_parameter() {
        let data = ar1(500, 0.6, 0.01, 1);
        for target in [5.0_f64, 20.0, 50.0] {
            let boot = Bootstrap::stationary(&data, target);
            let mut rng = Rng::new(99);
            let mut path = vec![0.0; 4000];
            let mut total_blocks = 0usize;
            let trials = 40;
            for _ in 0..trials {
                total_blocks += boot.resample(&mut path, &mut rng);
            }
            let observed = (trials * path.len()) as f64 / total_blocks as f64;
            let error = (observed - target).abs() / target;
            assert!(error < 0.1, "target {target}, observed {observed}");
        }
    }

    /// The property the geometric block length buys.
    ///
    /// A fixed-block bootstrap puts a join at every multiple of `b` and
    /// nowhere else, so the resample's joint distribution depends on position.
    /// Politis-Romano joins with probability `p` at every position alike, and
    /// that is what is measured here: the join frequency at each of the first
    /// 40 positions, against the flat `p` it should be.
    #[test]
    fn join_positions_are_uniform() {
        let data = ar1(400, 0.5, 0.01, 3);
        let mean_block = 10.0;
        let boot = Bootstrap::stationary(&data, mean_block);
        let steps = 40;
        let trials = 20_000;
        let mut counts = vec![0usize; steps];
        let mut rng = Rng::new(7);
        let mut joins = Vec::new();
        for _ in 0..trials {
            boot.join_positions(steps, &mut rng, &mut joins);
            for &position in &joins {
                counts[position] += 1;
            }
        }
        let expected = trials as f64 / mean_block;
        let worst = counts
            .iter()
            .skip(1)
            .map(|&c| (c as f64 - expected).abs() / expected)
            .fold(0.0_f64, f64::max);
        // Binomial noise at 2000 expected counts is about 2 percent at three
        // sigma; a fixed-block scheme would show 100 percent deviation at
        // every position that is not a multiple of the block length.
        assert!(worst < 0.1, "worst positional deviation {worst}");
    }

    #[test]
    fn resampling_preserves_the_mean_and_variance_of_the_source() {
        let data = ar1(2000, 0.6, 0.01, 5);
        let boot = Bootstrap::stationary(&data, 20.0);
        let mut rng = Rng::new(11);
        let mut pooled = Vec::new();
        let mut path = vec![0.0; 2000];
        for _ in 0..25 {
            boot.resample(&mut path, &mut rng);
            pooled.extend_from_slice(&path);
        }
        assert!((mean(&pooled) - mean(&data)).abs() < 0.0015, "{} vs {}", mean(&pooled), mean(&data));
        let ratio = variance(&pooled) / variance(&data);
        assert!((ratio - 1.0).abs() < 0.06, "variance ratio {ratio}");
    }

    /// The A/B on the single parameter.
    ///
    /// The iid bootstrap destroys serial dependence by construction; the
    /// stationary one keeps most of it. This is the whole reason the second
    /// algorithm exists, and it is the one thing a test of it should show.
    #[test]
    fn block_resampling_keeps_the_serial_dependence_that_iid_destroys() {
        let phi = 0.6;
        let data = ar1(3000, phi, 0.01, 13);
        let source_rho = autocorrelation(&data, 1);
        assert!((source_rho - phi).abs() < 0.05, "source rho {source_rho}");

        let mut rng = Rng::new(17);
        let mut path = vec![0.0; 3000];

        Bootstrap::iid(&data).resample(&mut path, &mut rng);
        let iid_rho = autocorrelation(&path, 1);
        assert!(iid_rho.abs() < 0.05, "iid rho {iid_rho}");

        Bootstrap::stationary(&data, 25.0).resample(&mut path, &mut rng);
        let block_rho = autocorrelation(&path, 1);
        // Measured: source 0.612, iid 0.002, block-25 0.579.
        assert!(block_rho > 0.45, "block rho {block_rho}");
        assert!(block_rho < source_rho + 0.05, "block rho {block_rho} exceeds source {source_rho}");
    }

    /// The bias worth naming rather than hiding.
    ///
    /// The long-run variance of the sample mean of an AR(1) is inflated by
    /// `(1+phi)/(1-phi)` — four times, at phi = 0.6. A bootstrap with a block
    /// shorter than the dependence recovers only part of that, and the whole
    /// point of choosing a block length is this trade.
    #[test]
    fn long_run_variance_needs_a_long_enough_block() {
        let phi = 0.6_f64;
        let data = ar1(4000, phi, 0.01, 23);
        let inflation = (1.0 + phi) / (1.0 - phi);
        let path_len = 250;

        let mut recovered = Vec::new();
        for mean_block in [1.0_f64, 5.0, 40.0] {
            let boot = Bootstrap::stationary(&data, mean_block);
            let mut rng = Rng::new(31);
            let mut path = vec![0.0; path_len];
            let mut means = Vec::new();
            for _ in 0..4000 {
                boot.resample(&mut path, &mut rng);
                means.push(mean(&path));
            }
            // Variance of the resampled mean, relative to what it would be if
            // the observations were independent.
            let ratio = variance(&means) * path_len as f64 / variance(&data);
            recovered.push(ratio);
        }

        // Measured, against a true inflation of 4.0x: iid 1.00x, block-5
        // 2.78x, block-40 3.66x. The shape of that progression is the
        // argument for choosing a block length deliberately.
        // iid recovers none of the inflation.
        assert!((recovered[0] - 1.0).abs() < 0.15, "iid ratio {}", recovered[0]);
        // A block of 5 recovers some of it and not all.
        assert!(recovered[1] > 1.6 && recovered[1] < inflation, "block-5 ratio {}", recovered[1]);
        // A block of 40 gets close.
        assert!(recovered[2] > 0.75 * inflation, "block-40 ratio {} vs {inflation}", recovered[2]);
    }

    #[test]
    fn the_same_seed_gives_the_same_path() {
        let data = ar1(200, 0.4, 0.01, 41);
        let boot = Bootstrap::stationary(&data, 12.0);
        let mut a = vec![0.0; 500];
        let mut b = vec![0.0; 500];
        boot.resample(&mut a, &mut Rng::new(2026));
        boot.resample(&mut b, &mut Rng::new(2026));
        assert_eq!(a, b);
    }

    #[test]
    fn an_empty_window_produces_a_flat_path_rather_than_a_panic() {
        let boot = Bootstrap::stationary(&[], 10.0);
        let mut path = vec![1.0; 10];
        assert_eq!(boot.resample(&mut path, &mut Rng::new(1)), 0);
        assert!(path.iter().all(|&x| x == 0.0));
    }
}

