//! SVI per expiry, with the no-arbitrage conditions checked (PRD 5.4).
//!
//! "Surface fit via SVI per expiry with arbitrage constraints (Gatheral-Jacquier
//! no-butterfly, no-calendar conditions) and an explicit flag when the
//! constraints cannot be satisfied, which is itself information."
//!
//! Raw SVI (Gatheral 2004) in total implied variance `w = sigma_bs^2 * T`
//! against log-moneyness `k = ln(K/F)`:
//!
//! ```text
//! w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
//! ```
//!
//! ## Butterfly: the density, not the parameters
//!
//! A slice is free of butterfly arbitrage exactly when the risk-neutral density
//! it implies is non-negative, which Gatheral and Jacquier (2014, eq. 2.1) write
//! in terms of the slice alone:
//!
//! ```text
//! g(k) = (1 - k w'/(2w))^2 - (w'^2 / 4) (1/w + 1/4) + w''/2  >= 0
//! ```
//!
//! Parameter bounds cannot express this — Axel Vogt's slice, the paper's own
//! counterexample, has perfectly ordinary-looking parameters and a negative
//! density — so `g` is evaluated on a grid wide enough to include the wings,
//! where SVI's arbitrage lives. The test checks `g` against something that does
//! not call it: the convexity of Black-Scholes call prices in strike.
//!
//! ## Two fits, and the difference between them is the flag
//!
//! Every slice is fitted twice: once with only the parameter-validity bounds,
//! and once with the density constraint as a penalty. A fitted slice can always
//! be made arbitrage-free — flatten it — so "the constraints cannot be
//! satisfied" cannot mean "no feasible parameters". It means the *quotes*
//! cannot be fitted without arbitrage: the unconstrained best fit has a negative
//! density, and removing it costs fit quality. That cost, in vol points, is the
//! information the PRD asks for, and it is reported rather than thresholded
//! away; the flag fires when it exceeds what the optimizer's own convergence
//! could account for.
//!
//! ## Calendar: checked between slices, and not repaired
//!
//! Total variance must not decrease with maturity at any fixed `k`. Violations
//! are found and reported with the `k` where they are worst. Repairing them
//! means refitting slices jointly, which trades fit on one expiry against
//! another in a way the analyst should choose, so this reports and does not
//! choose.

use crate::de::{self, Bound, DeConfig};
use libm::sqrt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Svi {
    pub a: f64,
    pub b: f64,
    pub rho: f64,
    pub m: f64,
    pub sigma: f64,
}

impl Svi {
    pub fn w(&self, k: f64) -> f64 {
        let x = k - self.m;
        self.a + self.b * (self.rho * x + sqrt(x * x + self.sigma * self.sigma))
    }

    pub fn w1(&self, k: f64) -> f64 {
        let x = k - self.m;
        self.b * (self.rho + x / sqrt(x * x + self.sigma * self.sigma))
    }

    pub fn w2(&self, k: f64) -> f64 {
        let x = k - self.m;
        let r = x * x + self.sigma * self.sigma;
        self.b * self.sigma * self.sigma / (r * sqrt(r))
    }

    /// Gatheral-Jacquier's density function. Negative means butterfly arbitrage.
    pub fn g(&self, k: f64) -> f64 {
        let w = self.w(k);
        if !(w > 0.0) {
            return f64::NEG_INFINITY;
        }
        let w1 = self.w1(k);
        let w2 = self.w2(k);
        let first = 1.0 - k * w1 / (2.0 * w);
        first * first - 0.25 * w1 * w1 * (1.0 / w + 0.25) + 0.5 * w2
    }

    /// The smallest total variance on the slice: `a + b*sigma*sqrt(1-rho^2)`.
    pub fn min_variance(&self) -> f64 {
        self.a + self.b * self.sigma * sqrt(1.0 - self.rho * self.rho)
    }

    /// Roger Lee's moment bound: neither wing may rise faster than 2 in `k`.
    pub fn lee_ok(&self) -> bool {
        let steep = self.b * (1.0 + if self.rho < 0.0 { -self.rho } else { self.rho });
        steep <= 2.0
    }

    /// The minimum of `g` over a grid, and where it falls.
    pub fn min_g(&self, lo: f64, hi: f64, points: usize) -> (f64, f64) {
        let mut worst = f64::INFINITY;
        let mut at = lo;
        let n = points.max(2);
        for i in 0..n {
            let k = lo + (hi - lo) * i as f64 / (n - 1) as f64;
            let g = self.g(k);
            if g < worst {
                worst = g;
                at = k;
            }
        }
        (worst, at)
    }
}

/// One quote on a slice: log-moneyness and total implied variance.
#[derive(Clone, Copy, Debug)]
pub struct SliceQuote {
    pub k: f64,
    pub w: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct SviFit {
    pub params: Svi,
    /// RMSE of implied vol, in vol (0.01 is one vol point).
    pub rmse_vol: f64,
    /// The minimum of `g` over the check grid, and where.
    pub min_g: f64,
    pub min_g_at: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct SliceResult {
    /// Fitted with the density constraint.
    pub constrained: SviFit,
    /// Fitted with parameter validity only.
    pub free: SviFit,
    /// Extra vol RMSE paid to remove the arbitrage. Zero when there was none.
    pub arbitrage_cost_vol: f64,
    /// The quotes cannot be fitted by SVI without butterfly arbitrage.
    pub quotes_admit_arbitrage: bool,
}

/// How far beyond the quoted strikes `g` is checked, in log-moneyness.
///
/// SVI's arbitrage lives in the wings, usually past the last quote, and a
/// check confined to the quoted range passes Vogt's slice.
pub const WING_MARGIN: f64 = 1.0;
pub const CHECK_POINTS: usize = 201;

/// Vol RMSE below which a difference between the two fits is optimizer noise.
///
/// A tenth of a vol point: finer than any quote is marked, coarser than the
/// spread between repeated runs on the fixtures.
pub const COST_TOLERANCE_VOL: f64 = 0.001;

/// What the penalty holds `g` above on the grid, rather than zero.
///
/// The constrained optimum sits on the constraint's edge, and an edge checked
/// at 201 points is not checked between them. Held at zero, the constrained fit
/// to Vogt's quotes measured +5e-11 on the grid and -5.5e-7 on a 200,001-point
/// one: a negative density, small, between samples. A floor of 1e-4 keeps the
/// fine-grid minimum positive (+9.9e-5) and costs a thousandth of a vol point
/// of fit on the same quotes.
pub const DENSITY_FLOOR: f64 = 1e-4;

fn params_from(v: &[f64]) -> Svi {
    Svi { a: v[0], b: v[1], rho: v[2], m: v[3], sigma: v[4] }
}

fn rmse_vol(svi: &Svi, quotes: &[SliceQuote], t: f64) -> f64 {
    let mut sum = 0.0;
    for q in quotes {
        let w = svi.w(q.k);
        if !(w > 0.0) {
            return f64::INFINITY;
        }
        let d = sqrt(w / t) - sqrt(q.w / t);
        sum += d * d;
    }
    sqrt(sum / quotes.len() as f64)
}

fn check_range(quotes: &[SliceQuote]) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for q in quotes {
        if q.k < lo {
            lo = q.k;
        }
        if q.k > hi {
            hi = q.k;
        }
    }
    (lo - WING_MARGIN, hi + WING_MARGIN)
}

fn fit_once(quotes: &[SliceQuote], t: f64, constrained: bool, seed: u64) -> SviFit {
    let (lo, hi) = check_range(quotes);
    let mut w_max: f64 = 0.0;
    for q in quotes {
        if q.w > w_max {
            w_max = q.w;
        }
    }
    let bounds = [
        Bound::new(-w_max, w_max),
        Bound::new(1e-6, 2.0),
        Bound::new(-0.999, 0.999),
        Bound::new(lo, hi),
        Bound::new(1e-4, 2.0),
    ];
    let config = DeConfig { population: 60, generations: 500, seed, ..DeConfig::default() };
    let result = de::minimize(&bounds, &config, |v| {
        let svi = params_from(v);
        if svi.min_variance() < 0.0 || !svi.lee_ok() {
            return f64::INFINITY;
        }
        let fit = rmse_vol(&svi, quotes, t);
        if !constrained {
            return fit;
        }
        // The density constraint as a penalty on its shortfall, weighted so a
        // negative density anywhere on the grid costs more than any fit
        // improvement could buy.
        //
        // On the *same* grid the result is checked on. A coarser penalty grid
        // was tried first, 61 points against the check's 201, and the
        // optimizer found a slice on Vogt's quotes whose negative density sat
        // entirely between penalty points: -0.00053 at check time, invisible
        // to the objective. An optimizer is a search for exactly that gap.
        let mut shortfall = 0.0;
        let n = CHECK_POINTS;
        for i in 0..n {
            let k = lo + (hi - lo) * i as f64 / (n - 1) as f64;
            let g = svi.g(k);
            if g < DENSITY_FLOOR {
                shortfall += DENSITY_FLOOR - g;
            }
        }
        fit + 10.0 * shortfall
    });
    let params = params_from(&result.best);
    let (min_g, min_g_at) = params.min_g(lo, hi, CHECK_POINTS);
    SviFit { params, rmse_vol: rmse_vol(&params, quotes, t), min_g, min_g_at }
}

/// Fit one expiry, twice, and say what removing the arbitrage cost.
pub fn fit_slice(quotes: &[SliceQuote], t: f64) -> Option<SliceResult> {
    if quotes.len() < 5 || !(t > 0.0) || quotes.iter().any(|q| !(q.w > 0.0)) {
        // Five parameters from fewer than five quotes is not a fit.
        return None;
    }
    let free = fit_once(quotes, t, false, 0x5711_F4EE);
    let constrained = fit_once(quotes, t, true, 0x5711_C0DE);
    let cost = constrained.rmse_vol - free.rmse_vol;
    let cost = if cost > 0.0 { cost } else { 0.0 };
    Some(SliceResult {
        constrained,
        free,
        arbitrage_cost_vol: cost,
        quotes_admit_arbitrage: free.min_g < 0.0 && cost > COST_TOLERANCE_VOL,
    })
}

/// Where total variance decreases from one expiry to the next, if anywhere.
///
/// Returns the `k` of the worst decrease and its size in total variance.
pub fn calendar_violation(near: &Svi, far: &Svi, lo: f64, hi: f64, points: usize) -> Option<(f64, f64)> {
    let n = points.max(2);
    let mut worst = 0.0;
    let mut at = None;
    for i in 0..n {
        let k = lo + (hi - lo) * i as f64 / (n - 1) as f64;
        let d = near.w(k) - far.w(k);
        if d > worst {
            worst = d;
            at = Some(k);
        }
    }
    at.map(|k| (k, worst))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bsm::{self, Inputs, OptionType};
    use libm::exp;

    /// Gatheral and Jacquier's counterexample (2014, section 5.1), due to Axel
    /// Vogt: ordinary-looking parameters, a negative density.
    const VOGT: Svi = Svi { a: -0.0410, b: 0.1331, rho: 0.3060, m: 0.3586, sigma: 0.4153 };

    /// A slice of the kind an equity index shows: downward skew, clean wings.
    const CLEAN: Svi = Svi { a: 0.02, b: 0.12, rho: -0.55, m: 0.05, sigma: 0.25 };

    fn quotes_from(svi: &Svi, lo: f64, hi: f64, n: usize) -> Vec<SliceQuote> {
        (0..n)
            .map(|i| {
                let k = lo + (hi - lo) * i as f64 / (n - 1) as f64;
                SliceQuote { k, w: svi.w(k) }
            })
            .collect()
    }

    /// Black-Scholes call on a unit forward, strike `e^k`, total variance `w`.
    fn call(k: f64, w: f64) -> f64 {
        bsm::price(&Inputs {
            spot: 1.0,
            strike: exp(k),
            time: 1.0,
            rate: 0.0,
            dividend: 0.0,
            vol: sqrt(w),
            kind: OptionType::Call,
        })
    }

    #[test]
    fn vogts_slice_has_a_negative_density() {
        let (min_g, at) = VOGT.min_g(-1.5, 1.5, 601);
        assert!(min_g < 0.0, "{min_g} at {at}");
        // Valid parameters by every bound this module imposes, which is why
        // bounds cannot be the check.
        assert!(VOGT.min_variance() > 0.0);
        assert!(VOGT.lee_ok());
    }

    #[test]
    fn g_agrees_with_call_convexity_in_strike() {
        // The check that does not call `g`: a density is the second derivative
        // of the call price in strike, so where `g` is negative the call price
        // must be concave, and where it is positive, convex.
        let (_, at) = VOGT.min_g(-1.5, 1.5, 601);
        let h = 1e-3;
        let second = |svi: &Svi, k: f64| {
            let (k0, k1, k2) = (k - h, k, k + h);
            let (s0, s1, s2) = (exp(k0), exp(k1), exp(k2));
            let (c0, c1, c2) = (call(k0, svi.w(k0)), call(k1, svi.w(k1)), call(k2, svi.w(k2)));
            // Non-uniform in strike, so the three-point second difference.
            2.0 * (c0 / ((s0 - s1) * (s0 - s2)) + c1 / ((s1 - s0) * (s1 - s2)) + c2 / ((s2 - s0) * (s2 - s1)))
        };
        assert!(second(&VOGT, at) < 0.0);
        for k in [-0.8, -0.3, 0.0, 0.3, 0.8] {
            assert!(CLEAN.g(k) > 0.0);
            assert!(second(&CLEAN, k) > 0.0);
        }
    }

    #[test]
    fn a_clean_slice_is_recovered_and_not_flagged() {
        let quotes = quotes_from(&CLEAN, -0.6, 0.4, 15);
        let result = fit_slice(&quotes, 0.5).unwrap();
        assert!(result.constrained.rmse_vol < 0.001, "{}", result.constrained.rmse_vol);
        assert!(result.constrained.min_g >= 0.0);
        assert!(!result.quotes_admit_arbitrage);
    }

    #[test]
    fn vogts_quotes_cannot_be_fitted_without_arbitrage_and_say_so() {
        let quotes = quotes_from(&VOGT, -1.0, 1.0, 21);
        let result = fit_slice(&quotes, 1.0).unwrap();
        // Unconstrained, SVI fits its own slice and inherits its arbitrage.
        assert!(result.free.rmse_vol < 0.002, "{}", result.free.rmse_vol);
        assert!(result.free.min_g < 0.0);
        // Constrained, the density is non-negative and the fit is worse.
        assert!(result.constrained.min_g >= -1e-9, "{}", result.constrained.min_g);
        assert!(result.arbitrage_cost_vol > COST_TOLERANCE_VOL);
        assert!(result.quotes_admit_arbitrage);
        // What removing it costs: 0.44 vol points of RMSE. This is the number
        // the flag carries to the analyst.
        assert!((result.arbitrage_cost_vol - 0.0044).abs() < 0.0002, "{}", result.arbitrage_cost_vol);
        // Where Vogt's density is negative: around k = 0.88.
        assert!((result.free.min_g_at - 0.88).abs() < 0.02, "{}", result.free.min_g_at);
    }

    #[test]
    fn the_constrained_density_stays_positive_between_grid_points() {
        // The grid the penalty sees is 201 points; this is a thousand times
        // finer. Without the floor it measured -5.5e-7 here.
        let quotes = quotes_from(&VOGT, -1.0, 1.0, 21);
        let result = fit_slice(&quotes, 1.0).unwrap();
        let (fine, at) = result.constrained.params.min_g(-2.0, 2.0, 200_001);
        assert!(fine > 0.0, "{fine} at {at}");
    }

    #[test]
    fn too_few_quotes_is_not_a_fit() {
        let quotes = quotes_from(&CLEAN, -0.2, 0.2, 4);
        assert!(fit_slice(&quotes, 0.5).is_none());
    }

    #[test]
    fn calendar_decrease_is_found_where_it_is_worst() {
        let near = CLEAN;
        let far = Svi { a: CLEAN.a + 0.01, ..CLEAN };
        assert!(calendar_violation(&near, &far, -1.0, 1.0, 101).is_none());
        // A far slice with less total variance in the put wing than the near one.
        let crossing = Svi { rho: 0.2, a: 0.04, ..CLEAN };
        let (k, size) = calendar_violation(&near, &crossing, -1.0, 1.0, 101).unwrap();
        assert!(size > 0.0);
        assert!(k < 0.0, "{k}");
    }
}

