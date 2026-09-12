//! Yield curves: construction, fitting, and shocks (PRD 5.3).
//!
//! "`CurveNode` bootstraps from deposits, futures, and swaps, or fits
//! Nelson-Siegel-Svensson to on-the-run governments. Fitting parameters and
//! residuals both output as ports; a fit with poor residuals shows a warning
//! rather than a smooth lie."
//!
//! Two ways to get a curve, and they are not the same kind of object. A
//! bootstrap *reproduces* its inputs exactly — every instrument it was built
//! from reprices to par off it, and `bootstrap_residuals` checks that rather
//! than assuming it. A fit *approximates* its inputs, and the residuals are the
//! whole point: a six-parameter curve through thirty bonds will miss, and an
//! analyst who cannot see by how much is being told a smooth lie.
//!
//! Shocks all compile to one representation. PRD Appendix A gives the wire type
//! as `{ kind: 'curve'; currency: string; tenorDeltasBps: Record<string, number> }`,
//! so parallel, steepener, flattener, butterfly and a shape drawn with the pen
//! are constructors for the same thing — a vector of basis-point deltas at the
//! standard tenors — and not five code paths that can disagree.

use crate::solve;

/// The key-rate buckets, in years. Ten points from three months to thirty years.
pub const STANDARD_TENORS: [f64; 10] =
    [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 20.0, 30.0];

/// A discount curve, pinned at a set of times.
///
/// Held as log discount factors and interpolated linearly between pins, which
/// is piecewise-constant instantaneous forwards — the standard bootstrap curve.
/// Interpolating zero rates instead would put sawteeth in the forwards, and the
/// forwards are what the instruments actually see.
#[derive(Clone, Debug, PartialEq)]
pub struct Curve {
    times: Vec<f64>,
    log_dfs: Vec<f64>,
}

impl Curve {
    /// Builds from pins. Times must be strictly increasing and positive.
    pub fn from_pins(times: Vec<f64>, log_dfs: Vec<f64>) -> Curve {
        debug_assert_eq!(times.len(), log_dfs.len());
        debug_assert!(times.windows(2).all(|w| w[1] > w[0]));
        Curve { times, log_dfs }
    }

    /// A flat curve at a continuously compounded rate.
    pub fn flat(rate: f64, horizon: f64) -> Curve {
        Curve { times: vec![horizon], log_dfs: vec![-rate * horizon] }
    }

    /// From zero rates, continuously compounded.
    pub fn from_zeros(times: &[f64], zeros: &[f64]) -> Curve {
        Curve {
            times: times.to_vec(),
            log_dfs: times.iter().zip(zeros).map(|(t, z)| -z * t).collect(),
        }
    }

    pub fn pins(&self) -> impl Iterator<Item = (f64, f64)> + '_ {
        self.times.iter().zip(&self.log_dfs).map(|(&t, &l)| (t, l))
    }

    pub fn is_empty(&self) -> bool {
        self.times.is_empty()
    }

    pub fn horizon(&self) -> f64 {
        self.times.last().copied().unwrap_or(0.0)
    }

    /// `ln DF(t)`. Zero at `t = 0`; beyond the last pin the final forward rate
    /// continues flat, which is the only extrapolation that does not invent a
    /// shape nobody quoted.
    pub fn log_discount(&self, t: f64) -> f64 {
        if t <= 0.0 || self.times.is_empty() {
            return 0.0;
        }
        let n = self.times.len();
        if t <= self.times[0] {
            // Linear from the implicit pin at the origin: a flat forward out to
            // the first quoted point.
            return self.log_dfs[0] * (t / self.times[0]);
        }
        if t >= self.times[n - 1] {
            if n == 1 {
                return self.log_dfs[0] * (t / self.times[0]);
            }
            let slope = (self.log_dfs[n - 1] - self.log_dfs[n - 2])
                / (self.times[n - 1] - self.times[n - 2]);
            return self.log_dfs[n - 1] + slope * (t - self.times[n - 1]);
        }
        // Binary search for the bracketing segment.
        let mut lo = 0usize;
        let mut hi = n - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.times[mid] <= t {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let w = (t - self.times[lo]) / (self.times[hi] - self.times[lo]);
        self.log_dfs[lo] + w * (self.log_dfs[hi] - self.log_dfs[lo])
    }

    pub fn discount(&self, t: f64) -> f64 {
        libm::exp(self.log_discount(t))
    }

    /// Continuously compounded zero rate.
    pub fn zero_rate(&self, t: f64) -> f64 {
        if t <= 0.0 {
            // The instantaneous short rate, as the limit of the first segment.
            return if self.times.is_empty() { 0.0 } else { -self.log_dfs[0] / self.times[0] };
        }
        -self.log_discount(t) / t
    }

    /// Continuously compounded forward rate over `[t1, t2]`.
    pub fn forward_rate(&self, t1: f64, t2: f64) -> f64 {
        if t2 <= t1 {
            return self.zero_rate(t1);
        }
        (self.log_discount(t1) - self.log_discount(t2)) / (t2 - t1)
    }

    /// Simple-compounded forward rate, which is what a deposit or a future quotes.
    pub fn simple_forward(&self, t1: f64, t2: f64) -> f64 {
        if t2 <= t1 {
            return 0.0;
        }
        (self.discount(t1) / self.discount(t2) - 1.0) / (t2 - t1)
    }

    /// Appends or replaces the final pin. Used by the bootstrap as it walks out.
    fn set_last_pin(&mut self, time: f64, log_df: f64) {
        match self.times.last() {
            Some(&last) if last == time => {
                let n = self.log_dfs.len();
                self.log_dfs[n - 1] = log_df;
            }
            _ => {
                self.times.push(time);
                self.log_dfs.push(log_df);
            }
        }
    }
}

/// The instruments a curve is built from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Instrument {
    /// Simple-compounded cash deposit maturing at `maturity`.
    Deposit { maturity: f64, rate: f64 },
    /// A futures contract on the forward rate over `[start, end]`.
    ///
    /// `convexity_bps` is subtracted from the quoted rate before use. A futures
    /// contract is margined daily and a forward is not, so the futures rate is
    /// biased above the forward one; the adjustment is a model output elsewhere
    /// and an input here, because pretending it is zero is a decision and should
    /// look like one.
    Future { start: f64, end: f64, rate: f64, convexity_bps: f64 },
    /// A par interest rate swap: fixed against float, `frequency` fixed
    /// payments a year.
    Swap { maturity: f64, rate: f64, frequency: f64 },
}

impl Instrument {
    pub fn maturity(&self) -> f64 {
        match *self {
            Instrument::Deposit { maturity, .. } => maturity,
            Instrument::Future { end, .. } => end,
            Instrument::Swap { maturity, .. } => maturity,
        }
    }

    /// What this instrument is worth on a given curve, in par terms: zero when
    /// the curve reproduces its quote.
    ///
    /// This is both the bootstrap's objective and, afterwards, the check on it.
    pub fn par_residual(&self, curve: &Curve) -> f64 {
        match *self {
            Instrument::Deposit { maturity, rate } => {
                curve.discount(maturity) * (1.0 + rate * maturity) - 1.0
            }
            Instrument::Future { start, end, rate, convexity_bps } => {
                let forward = rate - convexity_bps / 10_000.0;
                curve.simple_forward(start, end) - forward
            }
            Instrument::Swap { maturity, rate, frequency } => {
                let (annuity, _) = swap_annuity(curve, maturity, frequency);
                rate * annuity - (1.0 - curve.discount(maturity))
            }
        }
    }
}

/// Present value of one basis point of fixed coupon, and the final accrual.
fn swap_annuity(curve: &Curve, maturity: f64, frequency: f64) -> (f64, f64) {
    let accrual = 1.0 / frequency;
    let periods = libm::round(maturity * frequency).max(1.0) as usize;
    let mut annuity = 0.0;
    for i in 1..=periods {
        // The last payment lands exactly on the maturity, whatever rounding the
        // period count did — a swap's final fixed payment is on its maturity
        // date by definition, and letting it drift makes the bootstrap solve for
        // a pin the instrument does not actually reference.
        let t = if i == periods { maturity } else { accrual * i as f64 };
        annuity += accrual * curve.discount(t);
    }
    (annuity, accrual)
}

#[derive(Clone, Debug)]
pub struct BootstrapError {
    pub instrument: Instrument,
    pub reason: &'static str,
}

/// Builds a curve that reprices every instrument to par.
///
/// Sequential, shortest first: each instrument adds one pin, solved so that its
/// own quote is reproduced given everything already pinned. Deposits and futures
/// are closed form. A swap is not — its intermediate payments interpolate
/// against the very pin being solved for — so that one is a bracketed solve.
pub fn bootstrap(instruments: &[Instrument]) -> Result<Curve, BootstrapError> {
    let mut sorted: Vec<Instrument> = instruments.to_vec();
    sorted.sort_by(|a, b| a.maturity().partial_cmp(&b.maturity()).unwrap_or(core::cmp::Ordering::Equal));

    let mut curve = Curve { times: Vec::with_capacity(sorted.len()), log_dfs: Vec::with_capacity(sorted.len()) };

    for instrument in sorted {
        let maturity = instrument.maturity();
        if !maturity.is_finite() || maturity <= 0.0 {
            return Err(BootstrapError { instrument, reason: "maturity must be positive" });
        }
        if curve.times.last().is_some_and(|&last| maturity <= last) {
            return Err(BootstrapError {
                instrument,
                reason: "instruments must have strictly increasing maturities",
            });
        }

        let log_df = match instrument {
            Instrument::Deposit { maturity, rate } => {
                let df = 1.0 / (1.0 + rate * maturity);
                if !df.is_finite() || df <= 0.0 {
                    return Err(BootstrapError { instrument, reason: "deposit rate implies a non-positive discount factor" });
                }
                libm::log(df)
            }
            Instrument::Future { start, end, rate, convexity_bps } => {
                let forward = rate - convexity_bps / 10_000.0;
                let growth = 1.0 + forward * (end - start);
                if !growth.is_finite() || growth <= 0.0 {
                    return Err(BootstrapError { instrument, reason: "futures rate implies a non-positive growth factor" });
                }
                // DF(start) comes from the curve so far. When the future starts
                // beyond the last pin this extrapolates flat, which is what the
                // gap in the quotes leaves us with.
                curve.log_discount(start) - libm::log(growth)
            }
            Instrument::Swap { maturity, .. } => {
                // The residual rises with the log discount factor: a higher pin
                // means lower rates, a larger annuity and a smaller float leg.
                // Monotone, so a bracketed solve cannot land on the wrong root.
                let mut probe = curve.clone();
                let residual = |x: f64| {
                    probe.set_last_pin(maturity, x);
                    probe.par_residual_of(&instrument)
                };
                match solve::bisect(residual, -maturity, 0.25 * maturity) {
                    Some(x) => x,
                    None => {
                        return Err(BootstrapError {
                            instrument,
                            reason: "no discount factor between -25% and +100% reprices this swap",
                        })
                    }
                }
            }
        };
        curve.set_last_pin(maturity, log_df);
    }

    Ok(curve)
}

impl Curve {
    fn par_residual_of(&self, instrument: &Instrument) -> f64 {
        instrument.par_residual(self)
    }

    /// What the finished curve says about the instruments it was built from.
    ///
    /// A bootstrap is supposed to reproduce its inputs exactly, so these should
    /// all be at the noise floor. Returned rather than asserted, because "this
    /// curve reprices its own inputs" is a claim a node should be able to show.
    pub fn bootstrap_residuals(&self, instruments: &[Instrument]) -> Vec<f64> {
        instruments.iter().map(|i| i.par_residual(self)).collect()
    }
}

// ---------------------------------------------------------------------------
// Nelson-Siegel-Svensson

/// The six parameters. `beta0` is the long rate, `beta1` the short-minus-long
/// slope, `beta2` and `beta3` two humps with decay times `tau1` and `tau2`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Nss {
    pub beta0: f64,
    pub beta1: f64,
    pub beta2: f64,
    pub beta3: f64,
    pub tau1: f64,
    pub tau2: f64,
}

impl Nss {
    /// The zero rate this parameter set implies at time `t`.
    pub fn zero_rate(&self, t: f64) -> f64 {
        let (f1, f2, f3) = basis(t, self.tau1, self.tau2);
        self.beta0 + self.beta1 * f1 + self.beta2 * f2 + self.beta3 * f3
    }

    /// A curve pinned at the given tenors.
    pub fn to_curve(&self, tenors: &[f64]) -> Curve {
        let zeros: Vec<f64> = tenors.iter().map(|&t| self.zero_rate(t)).collect();
        Curve::from_zeros(tenors, &zeros)
    }
}

/// The three loadings. Linear in the betas, which is what makes the fit
/// tractable: only the two decay times are genuinely nonlinear.
fn basis(t: f64, tau1: f64, tau2: f64) -> (f64, f64, f64) {
    let decay = |tau: f64| -> (f64, f64) {
        if t <= 0.0 || tau <= 0.0 {
            // The limit at the origin: the slope loading is 1, the humps are 0.
            return (1.0, 0.0);
        }
        let x = t / tau;
        let e = libm::exp(-x);
        // (1 - e^-x)/x is 1 - x/2 + ... near zero, where the quotient loses
        // every digit it has. The series is exact to double precision well
        // before the quotient stops being.
        let slope = if x < 1e-6 { 1.0 - 0.5 * x } else { (1.0 - e) / x };
        (slope, e)
    };
    let (s1, e1) = decay(tau1);
    let (s2, e2) = decay(tau2);
    (s1, s1 - e1, s2 - e2)
}

/// A fit, and how well it actually fits.
#[derive(Clone, Debug)]
pub struct NssFit {
    pub params: Nss,
    /// Observed minus fitted, in the same units as the input rates.
    pub residuals: Vec<f64>,
    pub rmse_bps: f64,
    pub max_abs_bps: f64,
    /// The tenor where the fit is worst.
    pub worst_tenor: f64,
    /// Present when the fit is not good enough to be presented as the curve.
    ///
    /// PRD 5.3: "a fit with poor residuals shows a warning rather than a smooth
    /// lie." Six parameters through thirty bonds will miss something; the
    /// failure mode worth guarding against is a chart that looks perfect.
    pub warning: Option<String>,
}

/// Above this the fit is reported as unreliable. Two basis points of RMSE is
/// wider than the bid-ask on an on-the-run government, so a curve missing by
/// more than that is missing something real.
pub const NSS_RMSE_WARN_BPS: f64 = 2.0;
/// A single point this far out is a bond the curve does not explain, even if
/// the rest fit well — usually an off-the-run, a squeeze, or a bad mark.
pub const NSS_MAX_WARN_BPS: f64 = 8.0;

/// Fits Nelson-Siegel-Svensson to observed zero rates by least squares.
///
/// The betas enter linearly, so for any pair of decay times the best betas are
/// one 4x4 solve. Only `tau1` and `tau2` are nonlinear, and they are found by
/// searching a log-spaced grid and then refining around the best cell — which
/// is slower than a gradient method and does not care where it starts, on a
/// surface that is known to have local minima.
pub fn fit_nss(tenors: &[f64], zeros: &[f64]) -> Option<NssFit> {
    if tenors.len() < 4 || tenors.len() != zeros.len() {
        return None;
    }

    let mut best: Option<(f64, Nss)> = None;
    let search = |tau1: f64, tau2: f64, best: &mut Option<(f64, Nss)>| {
        if let Some(betas) = best_betas(tenors, zeros, tau1, tau2) {
            let params =
                Nss { beta0: betas[0], beta1: betas[1], beta2: betas[2], beta3: betas[3], tau1, tau2 };
            let sse: f64 = tenors
                .iter()
                .zip(zeros)
                .map(|(&t, &z)| {
                    let e = z - params.zero_rate(t);
                    e * e
                })
                .sum();
            if best.as_ref().is_none_or(|(b, _)| sse < *b) {
                *best = Some((sse, params));
            }
        }
    };

    // Log-spaced, because a decay time of 0.3 and one of 0.6 differ far more
    // than 20 and 20.3 do.
    const STEPS: usize = 28;
    let grid = |lo: f64, hi: f64, i: usize| -> f64 {
        libm::exp(libm::log(lo) + (libm::log(hi) - libm::log(lo)) * (i as f64) / ((STEPS - 1) as f64))
    };
    for i in 0..STEPS {
        for j in 0..STEPS {
            let (tau1, tau2) = (grid(0.05, 10.0, i), grid(0.5, 30.0, j));
            // The two humps are interchangeable; fixing an order stops the
            // search wasting half its budget on relabelled duplicates.
            if tau2 <= tau1 {
                continue;
            }
            search(tau1, tau2, &mut best);
        }
    }

    // Refine inside the winning cell, on the same log spacing.
    let (_, coarse) = best?;
    let span1 = libm::exp(libm::log(10.0 / 0.05) / ((STEPS - 1) as f64));
    let span2 = libm::exp(libm::log(30.0 / 0.5) / ((STEPS - 1) as f64));
    for i in 0..=16 {
        for j in 0..=16 {
            let f = |centre: f64, span: f64, k: usize| {
                centre * libm::pow(span, (k as f64 - 8.0) / 8.0)
            };
            let tau1 = f(coarse.tau1, span1, i).max(1e-3);
            let tau2 = f(coarse.tau2, span2, j).max(1e-3);
            if tau2 <= tau1 {
                continue;
            }
            search(tau1, tau2, &mut best);
        }
    }

    let (_, params) = best?;
    let residuals: Vec<f64> =
        tenors.iter().zip(zeros).map(|(&t, &z)| z - params.zero_rate(t)).collect();
    let n = residuals.len() as f64;
    let rmse_bps = libm::sqrt(residuals.iter().map(|r| r * r).sum::<f64>() / n) * 10_000.0;
    let (mut max_abs_bps, mut worst_tenor) = (0.0f64, tenors[0]);
    for (&t, r) in tenors.iter().zip(&residuals) {
        let bps = libm::fabs(*r) * 10_000.0;
        if bps > max_abs_bps {
            max_abs_bps = bps;
            worst_tenor = t;
        }
    }

    let warning = if rmse_bps > NSS_RMSE_WARN_BPS || max_abs_bps > NSS_MAX_WARN_BPS {
        Some(format!(
            "fit misses by {max_abs_bps:.1}bp at {worst_tenor}y (rmse {rmse_bps:.1}bp) — \
             the curve does not explain every quote"
        ))
    } else {
        None
    };

    Some(NssFit { params, residuals, rmse_bps, max_abs_bps, worst_tenor, warning })
}

/// Least-squares betas for fixed decay times, by normal equations.
fn best_betas(tenors: &[f64], zeros: &[f64], tau1: f64, tau2: f64) -> Option<[f64; 4]> {
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [0.0f64; 4];
    for (&t, &z) in tenors.iter().zip(zeros) {
        let (f1, f2, f3) = basis(t, tau1, tau2);
        let row = [1.0, f1, f2, f3];
        for i in 0..4 {
            atb[i] += row[i] * z;
            for j in 0..4 {
                ata[i][j] += row[i] * row[j];
            }
        }
    }
    solve4(ata, atb)
}

/// Gaussian elimination with partial pivoting. Four unknowns, so the direct
/// method is both the simplest and the fastest thing available.
fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> Option<[f64; 4]> {
    for col in 0..4 {
        let mut pivot = col;
        for row in (col + 1)..4 {
            if libm::fabs(a[row][col]) > libm::fabs(a[pivot][col]) {
                pivot = row;
            }
        }
        // Near-singular normal equations mean these decay times make two
        // loadings indistinguishable over the observed tenors. No betas to
        // report; the search moves on.
        if libm::fabs(a[pivot][col]) < 1e-14 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in (col + 1)..4 {
            let factor = a[row][col] / a[col][col];
            let pivot_row = a[col];
            for (target, &source) in a[row].iter_mut().zip(&pivot_row).skip(col) {
                *target -= factor * source;
            }
            b[row] -= factor * b[col];
        }
    }
    let mut x = [0.0f64; 4];
    for col in (0..4).rev() {
        let mut sum = b[col];
        for k in (col + 1)..4 {
            sum -= a[col][k] * x[k];
        }
        x[col] = sum / a[col][col];
    }
    if x.iter().all(|v| v.is_finite()) {
        Some(x)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Shocks

/// A curve shock, as PRD Appendix A puts it on the wire: basis-point deltas at
/// named tenors, and nothing else.
///
/// The shapes below are all constructors for this. That is deliberate — a
/// steepener and a shape the analyst drew with the pen have to compose, net
/// against each other, and serialize into a `Scenario`, and they cannot do any
/// of that if each one is its own special case downstream.
#[derive(Clone, Debug, PartialEq)]
pub struct CurveShock {
    pub tenors: Vec<f64>,
    pub deltas_bps: Vec<f64>,
}

impl CurveShock {
    /// Every tenor moves the same amount.
    pub fn parallel(bps: f64) -> CurveShock {
        CurveShock {
            tenors: STANDARD_TENORS.to_vec(),
            deltas_bps: vec![bps; STANDARD_TENORS.len()],
        }
    }

    /// The curve rotates about `pivot`: the longest tenor moves by `bps`, the
    /// pivot does not move, and the short end moves the other way.
    ///
    /// Linear in log tenor, because that is how a curve is looked at — the gap
    /// from 2y to 5y is a bigger move than the gap from 20y to 23y, and a
    /// rotation linear in years would put almost all of itself past 10y.
    pub fn steepener(bps: f64, pivot: f64) -> CurveShock {
        let tenors = STANDARD_TENORS.to_vec();
        let long = *tenors.last().expect("STANDARD_TENORS is not empty");
        let scale = libm::log(long / pivot);
        let deltas_bps = tenors
            .iter()
            .map(|&t| bps * libm::log(t / pivot) / scale)
            .collect();
        CurveShock { tenors, deltas_bps }
    }

    /// A steepener run backwards: the short end sells off and the long end rallies.
    pub fn flattener(bps: f64, pivot: f64) -> CurveShock {
        CurveShock::steepener(-bps, pivot)
    }

    /// The belly moves by `bps` and each wing by half that, the other way.
    ///
    /// The three legs net to zero exactly, which is what makes it a
    /// relative-value trade rather than a directional one wearing a hedge. The
    /// wings are the ends of the tenor set; the tent between them is a hedge
    /// ratio, not a quote, and the deltas it implies at 3y or 7y do not net to
    /// anything in particular.
    pub fn butterfly(bps: f64, belly: f64) -> CurveShock {
        let tenors = STANDARD_TENORS.to_vec();
        let short = tenors[0];
        let long = *tenors.last().expect("STANDARD_TENORS is not empty");
        let deltas_bps = tenors
            .iter()
            .map(|&t| {
                // A tent in log tenor, peaked at the belly and zero at the wings.
                let weight = if t <= belly {
                    libm::log(t / short) / libm::log(belly / short)
                } else {
                    libm::log(long / t) / libm::log(long / belly)
                };
                bps * (1.5 * weight - 0.5)
            })
            .collect();
        CurveShock { tenors, deltas_bps }
    }

    /// An arbitrary shape, as the pen-drawn one arrives.
    ///
    /// PRD 5.3: "the analyst can literally draw the shocked curve with the pen
    /// and the ink-to-curve recognizer converts the stroke to tenor-point
    /// deltas." By the time it reaches here it is already tenor-point deltas,
    /// which is the whole reason that sentence works.
    pub fn custom(tenors: Vec<f64>, deltas_bps: Vec<f64>) -> Option<CurveShock> {
        if tenors.len() != deltas_bps.len() || tenors.is_empty() {
            return None;
        }
        Some(CurveShock { tenors, deltas_bps })
    }

    /// The delta at an arbitrary tenor, in basis points.
    ///
    /// Linear in log tenor between the named points, flat outside them. Flat
    /// rather than extrapolated: a shock defined out to 30y says nothing about
    /// 40y, and inventing a slope there would put a made-up number into a
    /// scenario the analyst thinks they specified.
    pub fn delta_bps(&self, t: f64) -> f64 {
        let n = self.tenors.len();
        if n == 1 || t <= self.tenors[0] {
            return self.deltas_bps[0];
        }
        if t >= self.tenors[n - 1] {
            return self.deltas_bps[n - 1];
        }
        let mut lo = 0usize;
        while lo + 1 < n - 1 && self.tenors[lo + 1] <= t {
            lo += 1;
        }
        let (t0, t1) = (self.tenors[lo], self.tenors[lo + 1]);
        let w = libm::log(t / t0) / libm::log(t1 / t0);
        self.deltas_bps[lo] + w * (self.deltas_bps[lo + 1] - self.deltas_bps[lo])
    }

    /// Two shocks applied together, on the union of their tenors.
    pub fn compose(&self, other: &CurveShock) -> CurveShock {
        let mut tenors: Vec<f64> = self.tenors.iter().chain(&other.tenors).copied().collect();
        tenors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        tenors.dedup();
        let deltas_bps = tenors.iter().map(|&t| self.delta_bps(t) + other.delta_bps(t)).collect();
        CurveShock { tenors, deltas_bps }
    }

    /// The shocked curve.
    ///
    /// Re-pinned on the union of the curve's own pins and the shock's tenors, so
    /// neither shape is lost: pinning only where the curve was pinned would drop
    /// a shock's kink, and pinning only at the shock's tenors would flatten the
    /// curve between them.
    pub fn apply(&self, curve: &Curve) -> Curve {
        let mut tenors: Vec<f64> = curve
            .times
            .iter()
            .copied()
            .chain(self.tenors.iter().copied().filter(|&t| t <= curve.horizon()))
            .collect();
        tenors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        tenors.dedup();
        let zeros: Vec<f64> = tenors
            .iter()
            .map(|&t| curve.zero_rate(t) + self.delta_bps(t) / 10_000.0)
            .collect();
        Curve::from_zeros(&tenors, &zeros)
    }
}

// ---------------------------------------------------------------------------
// Analytics

/// A stream of cash flows: `(time, amount)`.
pub type CashFlows = [(f64, f64)];

/// Present value on a curve.
pub fn present_value(flows: &CashFlows, curve: &Curve) -> f64 {
    flows.iter().map(|&(t, amount)| amount * curve.discount(t)).sum()
}

/// Change in present value for a one-basis-point parallel shift, in currency.
///
/// Signed the way a risk system signs it: a positive DV01 means the position
/// gains when yields fall.
pub fn dv01(flows: &CashFlows, curve: &Curve) -> f64 {
    let down = CurveShock::parallel(-1.0).apply(curve);
    present_value(flows, &down) - present_value(flows, curve)
}

/// Sensitivity to each standard tenor moved on its own, in currency per bp.
///
/// A parallel DV01 says what a position loses if the whole curve moves. It says
/// nothing about a flattener, which can leave the total unchanged while every
/// bucket moves — so the buckets are the number that matters for a book hedged
/// on duration.
///
/// Each bucket is a tent in log tenor reaching its neighbours, so the buckets
/// sum to a parallel shift and nothing is double counted.
pub fn key_rate_dv01(flows: &CashFlows, curve: &Curve) -> Vec<(f64, f64)> {
    let base = present_value(flows, curve);
    let tenors = STANDARD_TENORS;
    tenors
        .iter()
        .enumerate()
        .map(|(i, &tenor)| {
            let mut deltas = vec![0.0; tenors.len()];
            deltas[i] = -1.0;
            let shock = CurveShock { tenors: tenors.to_vec(), deltas_bps: deltas };
            (tenor, present_value(flows, &shock.apply(curve)) - base)
        })
        .collect()
}

#[cfg(test)]
mod test {
    use super::*;

    /// A plausible USD curve: cash out to six months, futures through the first
    /// year, swaps beyond.
    fn market() -> Vec<Instrument> {
        vec![
            Instrument::Deposit { maturity: 0.0833, rate: 0.0533 },
            Instrument::Deposit { maturity: 0.25, rate: 0.0528 },
            Instrument::Deposit { maturity: 0.5, rate: 0.0515 },
            Instrument::Future { start: 0.5, end: 0.75, rate: 0.0496, convexity_bps: 0.4 },
            Instrument::Future { start: 0.75, end: 1.0, rate: 0.0471, convexity_bps: 0.7 },
            Instrument::Swap { maturity: 2.0, rate: 0.0428, frequency: 2.0 },
            Instrument::Swap { maturity: 3.0, rate: 0.0401, frequency: 2.0 },
            Instrument::Swap { maturity: 5.0, rate: 0.0388, frequency: 2.0 },
            Instrument::Swap { maturity: 7.0, rate: 0.0387, frequency: 2.0 },
            Instrument::Swap { maturity: 10.0, rate: 0.0392, frequency: 2.0 },
            Instrument::Swap { maturity: 20.0, rate: 0.0407, frequency: 2.0 },
            Instrument::Swap { maturity: 30.0, rate: 0.0396, frequency: 2.0 },
        ]
    }

    /// The only test that really matters for a bootstrap. A curve that does not
    /// reprice the instruments it was built from is not a curve, whatever it
    /// looks like plotted.
    #[test]
    fn reprices_every_instrument_it_was_built_from() {
        let instruments = market();
        let curve = bootstrap(&instruments).expect("bootstrap failed");
        for (instrument, residual) in instruments.iter().zip(curve.bootstrap_residuals(&instruments)) {
            assert!(
                libm::fabs(residual) < 1e-12,
                "{instrument:?} reprices {residual:e} away from par",
            );
        }
    }

    #[test]
    fn discount_factors_fall_and_stay_positive() {
        let curve = bootstrap(&market()).unwrap();
        let mut previous = 1.0;
        for step in 1..=300 {
            let t = step as f64 * 0.1;
            let df = curve.discount(t);
            assert!(df > 0.0 && df < previous, "at {t}y: {df} vs {previous}");
            previous = df;
        }
    }

    #[test]
    fn forwards_are_piecewise_constant_between_pins() {
        let curve = bootstrap(&market()).unwrap();
        // Inside one bootstrapped segment the instantaneous forward does not
        // move: that is what linear-in-log-discount means, and it is why the
        // interpolation was chosen.
        let a = curve.forward_rate(11.0, 11.5);
        let b = curve.forward_rate(13.0, 13.5);
        assert!(libm::fabs(a - b) < 1e-12, "{a} vs {b}");
        // Across a pin it does move.
        let c = curve.forward_rate(9.5, 10.5);
        assert!(libm::fabs(a - c) > 1e-6);
    }

    #[test]
    fn extrapolates_flat_rather_than_inventing_a_slope() {
        let curve = bootstrap(&market()).unwrap();
        let last = curve.forward_rate(29.0, 30.0);
        let beyond = curve.forward_rate(40.0, 41.0);
        assert!(libm::fabs(last - beyond) < 1e-12);
    }

    #[test]
    fn a_flat_curve_gives_back_the_rate_it_was_given() {
        let curve = Curve::flat(0.04, 30.0);
        for t in [0.1, 1.0, 7.5, 30.0, 45.0] {
            assert!(libm::fabs(curve.zero_rate(t) - 0.04) < 1e-14, "at {t}y");
            assert!(libm::fabs(curve.forward_rate(t, t + 1.0) - 0.04) < 1e-14);
        }
    }

    #[test]
    fn refuses_instruments_that_do_not_walk_forwards() {
        let out_of_order = [
            Instrument::Swap { maturity: 5.0, rate: 0.04, frequency: 2.0 },
            Instrument::Deposit { maturity: 5.0, rate: 0.05 },
        ];
        let err = bootstrap(&out_of_order).expect_err("duplicate maturities should fail");
        assert!(err.reason.contains("increasing"));
    }

    #[test]
    fn sorts_instruments_it_was_handed_out_of_order() {
        let mut shuffled = market();
        shuffled.reverse();
        let from_shuffled = bootstrap(&shuffled).unwrap();
        assert_eq!(from_shuffled, bootstrap(&market()).unwrap());
    }

    // -- Nelson-Siegel-Svensson ---------------------------------------------

    #[test]
    fn recovers_a_curve_that_is_exactly_nelson_siegel_svensson() {
        let truth = Nss {
            beta0: 0.042,
            beta1: -0.015,
            beta2: 0.021,
            beta3: -0.011,
            tau1: 1.4,
            tau2: 7.5,
        };
        let tenors: Vec<f64> = STANDARD_TENORS.to_vec();
        let zeros: Vec<f64> = tenors.iter().map(|&t| truth.zero_rate(t)).collect();

        let fit = fit_nss(&tenors, &zeros).expect("fit failed");
        // The parameters need not come back identical — two decay times can
        // trade against each other — but the curve they describe must.
        for &t in &[0.1, 0.25, 1.0, 4.0, 12.0, 30.0, 40.0] {
            let error = libm::fabs(fit.params.zero_rate(t) - truth.zero_rate(t)) * 10_000.0;
            assert!(error < 1.0, "at {t}y the fit is {error:.2}bp out");
        }
        assert!(fit.max_abs_bps < 1.0, "max residual {:.3}bp", fit.max_abs_bps);
        assert!(fit.warning.is_none(), "{:?}", fit.warning);
    }

    #[test]
    fn warns_rather_than_drawing_a_smooth_lie() {
        // A curve with a kink no six-parameter family can follow: one tenor
        // dislocated by 30bp, as an off-the-run or a squeeze would look.
        let tenors: Vec<f64> = STANDARD_TENORS.to_vec();
        let mut zeros: Vec<f64> = tenors.iter().map(|&t| 0.04 + 0.004 * libm::log(1.0 + t)).collect();
        zeros[4] += 0.0030;

        let fit = fit_nss(&tenors, &zeros).expect("fit failed");
        let warning = fit.warning.expect("a 30bp dislocation should warn");
        assert!(warning.contains("does not explain"), "{warning}");
        // And it names where, so the analyst can go and look at that bond.
        assert_eq!(fit.worst_tenor, tenors[4]);
        assert!(fit.max_abs_bps > 5.0, "{:.1}bp", fit.max_abs_bps);
    }

    #[test]
    fn residuals_are_observed_minus_fitted_in_that_order() {
        let tenors: Vec<f64> = STANDARD_TENORS.to_vec();
        let mut zeros: Vec<f64> = tenors.iter().map(|&t| 0.04 + 0.003 * libm::log(1.0 + t)).collect();
        zeros[7] += 0.0050;
        let fit = fit_nss(&tenors, &zeros).unwrap();
        // The dislocated point was marked *up*, so it sits above the fit.
        assert!(fit.residuals[7] > 0.0, "{:?}", fit.residuals);
    }

    #[test]
    fn declines_to_fit_fewer_points_than_it_has_parameters() {
        assert!(fit_nss(&[1.0, 2.0, 3.0], &[0.04, 0.041, 0.042]).is_none());
        assert!(fit_nss(&[1.0, 2.0], &[0.04]).is_none());
    }

    // -- Shocks --------------------------------------------------------------

    #[test]
    fn a_parallel_shock_moves_every_tenor_alike() {
        let curve = bootstrap(&market()).unwrap();
        let shocked = CurveShock::parallel(50.0).apply(&curve);
        for &t in &[0.5, 1.0, 2.0, 5.0, 10.0, 30.0] {
            let moved = (shocked.zero_rate(t) - curve.zero_rate(t)) * 10_000.0;
            assert!(libm::fabs(moved - 50.0) < 1e-9, "at {t}y it moved {moved}bp");
        }
    }

    #[test]
    fn a_steepener_pivots_where_it_says_it_does() {
        let shock = CurveShock::steepener(40.0, 2.0);
        assert!(libm::fabs(shock.delta_bps(2.0)) < 1e-12, "{}", shock.delta_bps(2.0));
        assert!(libm::fabs(shock.delta_bps(30.0) - 40.0) < 1e-12);
        // Short of the pivot the sign flips, which is what makes it a rotation
        // rather than a shift.
        assert!(shock.delta_bps(0.25) < 0.0);
        assert!(shock.delta_bps(10.0) > 0.0);
        // And it is monotone from one end to the other.
        let mut previous = f64::NEG_INFINITY;
        for &t in &STANDARD_TENORS {
            let d = shock.delta_bps(t);
            assert!(d > previous, "at {t}y: {d} after {previous}");
            previous = d;
        }
    }

    #[test]
    fn a_flattener_is_a_steepener_the_other_way_up() {
        let steep = CurveShock::steepener(40.0, 2.0);
        let flat = CurveShock::flattener(40.0, 2.0);
        for &t in &STANDARD_TENORS {
            assert!(libm::fabs(flat.delta_bps(t) + steep.delta_bps(t)) < 1e-12);
        }
    }

    #[test]
    fn a_butterfly_lifts_the_belly_and_sells_the_wings() {
        let shock = CurveShock::butterfly(30.0, 5.0);
        assert!(libm::fabs(shock.delta_bps(5.0) - 30.0) < 1e-9);
        assert!(shock.delta_bps(0.25) < 0.0);
        assert!(shock.delta_bps(30.0) < 0.0);
        // Self-financing on the three legs that define it: belly plus one,
        // each wing minus a half. Summing all ten tenors instead would measure
        // the tent's shape, not the trade — the deltas at 3y and 7y are hedge
        // ratios nobody quoted.
        let legs = shock.delta_bps(0.25) + shock.delta_bps(30.0) + shock.delta_bps(5.0);
        assert!(libm::fabs(legs) < 1e-9, "the three legs net {legs}bp");
        assert!(libm::fabs(shock.delta_bps(0.25) + 15.0) < 1e-9);
        // And it really is a tent: up to the belly, down after it.
        assert!(shock.delta_bps(2.0) < shock.delta_bps(5.0));
        assert!(shock.delta_bps(10.0) < shock.delta_bps(5.0));
    }

    #[test]
    fn a_drawn_shape_composes_with_a_named_one() {
        let drawn = CurveShock::custom(vec![1.0, 5.0, 10.0], vec![10.0, -5.0, 20.0]).unwrap();
        let combined = CurveShock::parallel(25.0).compose(&drawn);
        assert!(libm::fabs(combined.delta_bps(1.0) - 35.0) < 1e-12);
        assert!(libm::fabs(combined.delta_bps(5.0) - 20.0) < 1e-12);
        assert!(libm::fabs(combined.delta_bps(10.0) - 45.0) < 1e-12);
        // Composition keeps both sets of kinks.
        assert!(combined.tenors.contains(&5.0) && combined.tenors.contains(&20.0));
    }

    #[test]
    fn a_shock_says_nothing_past_the_tenors_it_names() {
        let drawn = CurveShock::custom(vec![1.0, 10.0], vec![10.0, 20.0]).unwrap();
        // Flat outside, rather than a slope nobody specified.
        assert_eq!(drawn.delta_bps(0.1), 10.0);
        assert_eq!(drawn.delta_bps(50.0), 20.0);
    }

    #[test]
    fn a_mismatched_drawing_is_rejected() {
        assert!(CurveShock::custom(vec![1.0, 5.0], vec![10.0]).is_none());
        assert!(CurveShock::custom(vec![], vec![]).is_none());
    }

    // -- Analytics -----------------------------------------------------------

    /// A ten-year 4% annual bond on a hundred of notional.
    fn bond() -> Vec<(f64, f64)> {
        let mut flows: Vec<(f64, f64)> = (1..=10).map(|i| (i as f64, 4.0)).collect();
        flows[9].1 += 100.0;
        flows
    }

    #[test]
    fn dv01_is_positive_for_a_long_bond_and_scales_with_maturity() {
        let curve = bootstrap(&market()).unwrap();
        let ten_year = dv01(&bond(), &curve);
        assert!(ten_year > 0.0, "{ten_year}");

        let two_year: Vec<(f64, f64)> = vec![(1.0, 4.0), (2.0, 104.0)];
        assert!(dv01(&two_year, &curve) < ten_year);

        // A basis point on a ten-year par bond is about eight cents per hundred.
        assert!((0.05..0.12).contains(&ten_year), "{ten_year}");
    }

    #[test]
    fn key_rate_buckets_sum_to_the_parallel_number() {
        let curve = bootstrap(&market()).unwrap();
        let flows = bond();
        let buckets = key_rate_dv01(&flows, &curve);
        let total: f64 = buckets.iter().map(|&(_, v)| v).sum();
        let parallel = dv01(&flows, &curve);
        // Second-order terms keep this from being exact; a tenth of a percent
        // of the total is the convexity, not a bookkeeping error.
        assert!(
            libm::fabs(total - parallel) < 0.002 * libm::fabs(parallel),
            "buckets {total} vs parallel {parallel}",
        );
    }

    #[test]
    fn a_bond_has_no_risk_to_tenors_past_its_last_cash_flow() {
        let curve = bootstrap(&market()).unwrap();
        let buckets = key_rate_dv01(&bond(), &curve);
        let thirty = buckets.iter().find(|&&(t, _)| t == 30.0).unwrap().1;
        let ten = buckets.iter().find(|&&(t, _)| t == 10.0).unwrap().1;
        // The 30y bucket reaches back only as far as its tent does, and a bond
        // that pays its last coupon at ten years is not in it.
        assert!(libm::fabs(thirty) < 0.01 * libm::fabs(ten), "30y {thirty} vs 10y {ten}");
        // The weight lands where the principal does.
        assert!(ten > 0.5 * dv01(&bond(), &curve));
    }
}
