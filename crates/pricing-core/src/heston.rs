//! Heston in closed form, and calibration to a surface (PRD 5.8).
//!
//! > Calibration: parameters either user-set, fit to history over a chosen
//! > window, or fit to the current option surface (for Heston, via
//! > **differential evolution on the surface fit residual**).
//!
//! Differential evolution over a Monte Carlo surface is noise fitting noise: a
//! population member's score would move by more between evaluations than
//! between parameter sets, and the search would converge on whichever seed
//! happened to look good. So calibration needs a pricer whose only error is
//! quadrature, which for Heston means the characteristic function.
//!
//! ## The branch cut, which is the whole numerical difficulty
//!
//! Heston's characteristic function contains a complex logarithm, and the
//! formulation in the original 1993 paper puts it on a branch that the
//! principal `ln` crosses as maturity grows — the integrand jumps, the integral
//! is wrong, and it is wrong *discontinuously*, so a calibration walking
//! through that region sees a cliff that is not in the model. Albrecher, Mayer,
//! Schoutens and Tistaert named this "the little Heston trap" in 2007 and
//! showed the fix is algebraic rather than numerical: writing
//!
//! ```text
//! g = (kappa - rho sigma i u - d) / (kappa - rho sigma i u + d)
//! ```
//!
//! rather than its reciprocal keeps `|g| <= 1`, which keeps `1 - g e^{-dT}`
//! in the right half plane, which makes the principal branch the correct one
//! for every `u` and every `T`. That is the form below, and
//! `long_maturities_do_not_jump` is the test that would fail on the other one.
//!
//! ## Lewis rather than the two probabilities
//!
//! Heston's own presentation prices through two probabilities `P1` and `P2`,
//! each an integral of `Re[e^{-iu ln K} phi_j(u) / (iu)]`. The `1/(iu)` is
//! removable but the integrand still has to be handled carefully at the origin,
//! and there are two integrals instead of one. Lewis's (2000) formulation
//!
//! ```text
//! C = S e^{-qT} - sqrt(S K) e^{-(r+q)T/2} / pi
//!     * integral over u of Re[e^{i u X} phi(u - i/2)] / (u^2 + 1/4)
//! ```
//!
//! has one integral, no pole, and an integrand that decays like the
//! characteristic function itself. `X` is the log forward moneyness and `phi`
//! is the characteristic function of the *driftless* log return, which is what
//! makes the drift drop out of the integrand entirely.
//!
//! ## Where it stops working, measured
//!
//! The obvious way to check a Heston implementation is to drive the vol of vol
//! to zero with `v0 = theta` and compare against Black-Scholes at
//! `sqrt(theta)`, and it is a trap. `C(u,T)` carries a factor of
//! `kappa theta / sigma^2` multiplying a bracket that vanishes with `sigma^2`,
//! so the two have to cancel, and a double runs out of digits to cancel with.
//! Measured, at S=100 K=120 T=2 r=3% q=1% theta=v0=0.16 kappa=2:
//!
//! ```text
//!      sigma      |heston - bsm|   kappa theta / sigma^2
//!    1.00e-2          1.39e-4            3.2e3
//!    1.00e-3          1.39e-6            3.2e5
//!    1.00e-4          2.20e-7            3.2e7     <- floor
//!    1.00e-5          5.01e-5            3.2e9
//!    1.00e-6          5.02e-4            3.2e11
//!    1.00e-7          4.63e-1            3.2e13
//! ```
//!
//! Down to `sigma = 1e-4` the gap falls exactly as `sigma^2`, which is the
//! model difference and not an error. Below it the gap *grows*, by the same
//! factor of a hundred per decade, which is the cancellation. Refining the
//! quadrature does not touch it — four times the nodes over four times the
//! range moves the `1e-6` case by less than it is wrong by — while at realistic
//! parameters that same refinement changes nothing at all, to the last bit.
//!
//! So the conditioning is reported rather than discovered. `conditioning`
//! returns `kappa theta / sigma^2`; past about `1e7` the price is losing
//! digits, and a caller testing the Black-Scholes limit should do it at
//! `sigma = 1e-3` where the method is sound and the agreement is 1.4e-6.

use crate::bsm::{Inputs, OptionType};
use crate::complex::Complex;
use crate::quad::Legendre;

/// Heston's five parameters, plus the initial variance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HestonParams {
    /// Initial instantaneous variance.
    pub v0: f64,
    /// Long-run variance.
    pub theta: f64,
    /// Mean reversion speed.
    pub kappa: f64,
    /// Volatility of variance.
    pub sigma: f64,
    /// Spot-variance correlation. Negative is the equity case, and is the skew.
    pub rho: f64,
}

impl HestonParams {
    /// `2 kappa theta >= sigma^2`: the variance process stays strictly positive.
    ///
    /// Reported rather than enforced. Fitted equity surfaces routinely violate
    /// it — the skew wants a large `sigma` and the term structure wants a small
    /// `kappa theta` — and a calibrator that refuses every such fit refuses most
    /// real surfaces. What it changes is the simulation scheme, not the
    /// closed-form price, so the honest thing is to say whether it holds.
    pub fn feller(&self) -> f64 {
        2.0 * self.kappa * self.theta - self.sigma * self.sigma
    }

    pub fn satisfies_feller(&self) -> bool {
        self.feller() >= 0.0
    }
}

/// The characteristic function of the driftless log return, `ln(S_T/S_0) - (r-q)T`.
///
/// The "little Heston trap" formulation. `d` is the discriminant and `g` is
/// chosen so its magnitude does not exceed one; see the module docs.
pub fn characteristic(params: &HestonParams, u: Complex, time: f64) -> Complex {
    let HestonParams { v0, theta, kappa, sigma, rho } = *params;
    let iu = Complex::I.mul(u);
    let sigma2 = sigma * sigma;

    // (rho sigma i u - kappa)^2 + sigma^2 (i u + u^2)
    let a = iu.scale(rho * sigma).sub(Complex::real(kappa));
    let u2 = u.mul(u);
    let discriminant = a.mul(a).add(iu.add(u2).scale(sigma2));
    let d = discriminant.sqrt();

    // kappa - rho sigma i u
    let b = Complex::real(kappa).sub(iu.scale(rho * sigma));
    let minus = b.sub(d);
    let plus = b.add(d);

    // |g| <= 1 by construction, which is the point.
    let g = minus.div(plus);

    let exp_dt = d.scale(-time).exp();
    let one_minus_g_exp = Complex::ONE.sub(g.mul(exp_dt));

    let log_term = one_minus_g_exp.div(Complex::ONE.sub(g)).ln();
    let c = minus.scale(time).sub(log_term.scale(2.0)).scale(kappa * theta / sigma2);
    let d_term = minus
        .scale(1.0 / sigma2)
        .mul(Complex::ONE.sub(exp_dt).div(one_minus_g_exp));

    c.add(d_term.scale(v0)).exp()
}

/// `kappa theta / sigma^2`: the factor the series coefficient must cancel.
///
/// Past roughly `CONDITIONING_LIMIT` the price loses significant digits to that
/// cancellation. See the module docs for the measurement.
pub fn conditioning(params: &HestonParams) -> f64 {
    if params.sigma == 0.0 {
        return f64::INFINITY;
    }
    params.kappa * params.theta / (params.sigma * params.sigma)
}

/// Where the measured error stops falling and starts rising.
pub const CONDITIONING_LIMIT: f64 = 1.0e7;

pub fn well_conditioned(params: &HestonParams) -> bool {
    conditioning(params) <= CONDITIONING_LIMIT
}

/// How far out the Lewis integral is truncated, and in how many panels.
///
/// The integrand decays like the characteristic function and the panels are
/// geometric, because almost all of the mass sits in the first few units. The
/// grid is chosen by measurement rather than by taste. Worst absolute price
/// error against a reference at four times everything, over six strike-maturity
/// pairs and four parameter sets *including the corners of the calibration
/// box* — `kappa = 15`, `sigma = 3`, `rho = -0.95`, where the integrand is at
/// its least pleasant:
///
/// ```text
///    nodes   worst error    per price
///     192       2.07e-8       80.6 us
///     120       7.13e-8       36.6 us   <- shipped
///      96       1.13e-5       30.7 us
///      64       4.87e-4       19.1 us
///      48       7.69e-3       15.2 us
/// ```
///
/// 120 rather than 192: 7e-8 on a hundred-dollar option is a hundredth of a
/// cent, a thousand times inside any bid-ask a calibration is fitting, and it
/// costs less than half as much. The cliff below 120 is why it is not fewer —
/// 96 nodes is already 1e-5 and 64 is half a basis point, and both of those are
/// visible in a fitted parameter.
pub const LEWIS_UPPER: f64 = 200.0;
const PANEL_EDGES: [f64; 6] = [0.0, 1.0, 4.0, 16.0, 60.0, LEWIS_UPPER];
const PANEL_NODES: usize = 24;

/// A European option under Heston, by the Lewis integral.
pub fn price(params: &HestonParams, inputs: &Inputs) -> f64 {
    let Inputs { spot, strike, time, rate, dividend, kind, .. } = *inputs;

    if time <= 0.0 || spot <= 0.0 || strike <= 0.0 {
        return inputs.intrinsic();
    }

    // Log forward moneyness. The driftless characteristic function means the
    // drift appears here and nowhere else.
    let x = libm::log(spot / strike) + (rate - dividend) * time;
    let rule = Legendre::new(PANEL_NODES);

    let mut integral = 0.0;
    for window in PANEL_EDGES.windows(2) {
        let (lo, hi) = (window[0], window[1]);
        integral += rule.integrate(lo, hi, |u| {
            let shifted = Complex::new(u, -0.5);
            let phi = characteristic(params, shifted, time);
            let rotated = Complex::new(0.0, u * x).exp().mul(phi);
            rotated.re / (u * u + 0.25)
        });
    }

    let call = spot * libm::exp(-dividend * time)
        - libm::sqrt(spot * strike) * libm::exp(-(rate + dividend) * time * 0.5)
            * integral
            / core::f64::consts::PI;

    match kind {
        OptionType::Call => call,
        // Put-call parity. Pricing the put through its own integral would be a
        // second place for the quadrature to be wrong, and parity is exact.
        OptionType::Put => {
            call - spot * libm::exp(-dividend * time) + strike * libm::exp(-rate * time)
        }
    }
}

/// The Black-Scholes volatility that reproduces the Heston price.
///
/// NaN where the inversion carries no information — deep in the money near
/// expiry, where vega collapses and every vol in a wide band reproduces the
/// price to the last bit of a double. `implied::implied_vol` reports that case
/// rather than returning the middle of the band, and passing the report along
/// as NaN keeps a surface fit from weighting a number nobody can invert.
pub fn implied_vol(params: &HestonParams, inputs: &Inputs) -> f64 {
    let value = price(params, inputs);
    match crate::implied::implied_vol(inputs, value) {
        Ok(solution) => solution.vol,
        Err(_) => f64::NAN,
    }
}

// ---------------------------------------------------------------------------
// Surface calibration
// ---------------------------------------------------------------------------

use crate::de::{self, Bound, DeConfig};

/// One quote on the surface.
#[derive(Clone, Copy, Debug)]
pub struct Quote {
    pub strike: f64,
    pub time: f64,
    pub kind: OptionType,
    /// The market's implied volatility.
    pub vol: f64,
    /// Relative weight. Vega, open interest, or one — the caller decides.
    pub weight: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Surface<'a> {
    pub spot: f64,
    pub rate: f64,
    pub dividend: f64,
    pub quotes: &'a [Quote],
}

/// What the residual is measured in.
///
/// Implied vol, by default, and the reason is not cosmetic. A price residual is
/// dominated by whichever quotes are most expensive, which on an equity surface
/// means the long-dated at-the-money ones — so a price fit lands the wings
/// wherever they fall, and the wings are the entire reason anybody fits Heston
/// rather than Black-Scholes. In vol terms every quote contributes on the scale
/// a trader reads it in. `fit_in_vol_and_fit_in_price_disagree_about_the_wings`
/// measures the difference rather than asserting it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Residual {
    ImpliedVol,
    Price,
}

#[derive(Clone, Copy, Debug)]
pub struct CalibrationConfig {
    pub residual: Residual,
    pub de: DeConfig,
    /// The search box, in the order `(v0, theta, kappa, sigma, rho)`.
    pub bounds: [Bound; 5],
}

/// Bounds wide enough for an equity surface and no wider.
///
/// `rho` stops short of -1 because the characteristic function's discriminant
/// degenerates there, and a calibrator that walks onto the boundary reports a
/// fit built from a price that lost its digits. `sigma` starts above zero for
/// the conditioning reason in the module docs rather than because a smaller
/// value is meaningless.
pub const DEFAULT_BOUNDS: [Bound; 5] = [
    Bound::new(0.0025, 0.64),  // v0: 5% to 80% vol
    Bound::new(0.0025, 0.64),  // theta
    Bound::new(0.05, 15.0),    // kappa
    Bound::new(0.02, 3.0),     // sigma
    Bound::new(-0.95, 0.95),   // rho
];

impl Default for CalibrationConfig {
    fn default() -> Self {
        CalibrationConfig {
            residual: Residual::ImpliedVol,
            de: DeConfig { population: 60, generations: 300, ..DeConfig::default() },
            bounds: DEFAULT_BOUNDS,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Calibration {
    pub params: HestonParams,
    /// Weighted RMSE in the residual's units.
    pub rmse: f64,
    /// Largest single-quote residual, and which quote it was.
    pub worst: f64,
    pub worst_quote: usize,
    /// Quotes the pricer could not produce a usable residual for.
    ///
    /// Reported rather than silently dropped: a fit that ignored a third of the
    /// surface is a different claim from one that fitted all of it, and the
    /// count is the only way to tell them apart.
    pub skipped: usize,
    pub generations: usize,
    pub evaluations: usize,
    /// Spread of the final population's scores. Large means it did not converge.
    pub score_spread: f64,
    /// `2 kappa theta - sigma^2` at the fit.
    pub feller: f64,
    /// `kappa theta / sigma^2` at the fit; see `CONDITIONING_LIMIT`.
    pub conditioning: f64,
}

fn params_from(values: &[f64]) -> HestonParams {
    HestonParams {
        v0: values[0],
        theta: values[1],
        kappa: values[2],
        sigma: values[3],
        rho: values[4],
    }
}

/// The weighted residual of one parameter set against the surface.
///
/// Returns the sum of squared weighted residuals and the count of quotes that
/// contributed. A quote whose Heston price cannot be inverted to a vol — deep
/// in the money near expiry, where vega collapses — contributes nothing rather
/// than contributing a NaN, and the caller is told how many there were.
fn residuals(params: &HestonParams, surface: &Surface, residual: Residual) -> (f64, usize, f64, usize) {
    let mut total = 0.0;
    let mut used = 0usize;
    let mut worst = 0.0;
    let mut worst_quote = 0usize;

    for (index, quote) in surface.quotes.iter().enumerate() {
        let inputs = Inputs {
            spot: surface.spot,
            strike: quote.strike,
            time: quote.time,
            rate: surface.rate,
            dividend: surface.dividend,
            vol: quote.vol,
            kind: quote.kind,
        };

        let difference = match residual {
            Residual::Price => {
                let market = crate::bsm::price(&inputs);
                let model = price(params, &inputs);
                model - market
            }
            Residual::ImpliedVol => {
                let model = implied_vol(params, &inputs);
                model - quote.vol
            }
        };

        if !difference.is_finite() {
            continue;
        }
        let weighted = difference * libm::sqrt(quote.weight.max(0.0));
        total += weighted * weighted;
        used += 1;
        if libm::fabs(difference) > worst {
            worst = libm::fabs(difference);
            worst_quote = index;
        }
    }

    (total, used, worst, worst_quote)
}

/// Fit Heston to a surface by differential evolution.
///
/// The objective is the weighted RMSE rather than the sum of squares, so the
/// reported score is in the residual's own units and a target can be stated in
/// vol points instead of in a number nobody can interpret.
pub fn calibrate(surface: &Surface, config: &CalibrationConfig) -> Calibration {
    let mut evaluations = 0usize;

    let result = de::minimize(&config.bounds, &config.de, |values| {
        evaluations += 1;
        let params = params_from(values);
        let (sum, used, _, _) = residuals(&params, surface, config.residual);
        if used == 0 {
            return f64::INFINITY;
        }
        // A parameter set that priced only a fraction of the surface is
        // penalised in proportion to what it skipped, rather than being
        // rewarded for having fewer terms in its sum.
        let coverage = used as f64 / surface.quotes.len().max(1) as f64;
        libm::sqrt(sum / used as f64) / coverage
    });

    let params = params_from(&result.best);
    let (sum, used, worst, worst_quote) = residuals(&params, surface, config.residual);
    let rmse = if used == 0 { f64::NAN } else { libm::sqrt(sum / used as f64) };

    Calibration {
        params,
        rmse,
        worst,
        worst_quote,
        skipped: surface.quotes.len() - used,
        generations: result.generations,
        evaluations: result.evaluations,
        score_spread: result.score_spread,
        feller: params.feller(),
        conditioning: conditioning(&params),
    }
}

/// Generate a surface from a known parameter set, for round-trip testing.
///
/// Lives here rather than in the tests because the round trip is the only
/// honest check of a calibrator: a fit to real quotes has no right answer to
/// compare against, so "the RMSE is small" is the only thing anyone can say
/// about it, and a calibrator that lands in the wrong valley says that too.
pub fn synthetic_surface(
    params: &HestonParams,
    spot: f64,
    rate: f64,
    dividend: f64,
    strikes: &[f64],
    maturities: &[f64],
    out: &mut Vec<Quote>,
) {
    out.clear();
    for &time in maturities {
        for &strike in strikes {
            let kind = if strike >= spot { OptionType::Call } else { OptionType::Put };
            let inputs = Inputs { spot, strike, time, rate, dividend, vol: 0.2, kind };
            let vol = implied_vol(params, &inputs);
            if vol.is_finite() {
                out.push(Quote { strike, time, kind, vol, weight: 1.0 });
            }
        }
    }
}
