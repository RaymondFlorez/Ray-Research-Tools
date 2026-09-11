//! Andersen-Lake: the fast American path Appendix C.2 actually names.
//!
//! Bjerksund-Stensland, which `american::fast_price` shipped first, is a closed
//! form built on a *flat* exercise boundary. It is fast and it is wrong by
//! about 2.7 cents a share on average — `examples/error_scan.rs` measured that
//! across 840 parameter combinations against a half-tick tolerance, so the
//! guard escalated nearly everywhere early exercise carried value. This solves
//! for the real boundary instead.
//!
//! # The method
//!
//! An American put is a European put plus the premium earned by exercising
//! early, and Kim's (1990) representation writes that premium as an integral
//! along the exercise boundary `B`:
//!
//! ```text
//! P(S, T) = p(S, T) + ∫₀ᵀ [ rK e^{-ru} N(-d₋(S/B(T-u), u))
//!                          - qS e^{-qu} N(-d₊(S/B(T-u), u)) ] du
//! ```
//!
//! `B` is not known, and setting `S = B(T)` turns the representation into a
//! nonlinear integral equation for it. Rearranging that equation so the
//! boundary appears alone on the left gives a fixed point:
//!
//! ```text
//! B(τ) = K · N(τ) / D(τ)
//! ```
//!
//! where `N` and `D` are the two halves of the value-matching condition, each a
//! direct term plus an integral over the boundary's own history. Iterate, and
//! the boundary converges.
//!
//! # Why the transformations are not optional
//!
//! Two square roots decide whether this is accurate or merely plausible.
//!
//! The boundary meets expiry with a `√(τ ln(1/τ))` cusp, so `B` itself is not
//! worth interpolating. What is interpolated is `H = ln(B/B(0))²` against
//! `√τ` — the square cancels the cusp, and a Chebyshev polynomial of degree
//! five then fits what a polynomial in `τ` could not fit at any degree.
//!
//! The integrand carries its own `√` singularity at the upper limit, where the
//! elapsed time goes to zero: `N(d)` there behaves like `½ + c√u`. Substituting
//! `u = τv²` makes it linear in `v`, and Gauss-Legendre integrates a smooth
//! function instead of straddling a cusp.
//!
//! Both are Andersen-Lake's; neither is an implementation detail.

use crate::bsm::{self, Inputs, OptionType};
use crate::normal::cdf;
use crate::quad::{Chebyshev, Legendre, MAX_NODES};

/// The four numbers that size the solver, in Andersen-Lake's own order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scheme {
    /// Gauss-Legendre nodes for the integral inside the fixed-point equation.
    pub integration: usize,
    /// Fixed-point iterations on the boundary.
    pub iterations: usize,
    /// Chebyshev intervals for the boundary; one more than this is the node count.
    pub collocation: usize,
    /// Gauss-Legendre nodes for the pricing integral, once the boundary is known.
    pub pricing: usize,
}

/// The grid and portfolio scheme, chosen from the measured accuracy-cost curve
/// in `examples/al_sweep.rs` rather than from a table.
///
/// That sweep raises each of the four numbers on its own, and the answer is
/// lopsided: `integration`, `collocation` and `pricing` are all saturated at
/// their smallest useful settings — going from five quadrature nodes to
/// thirty-five changes the mean error in the sixth decimal — while
/// `iterations` moves it by two orders of magnitude between four and eight.
/// The fixed point converges linearly, so iterating is the only thing worth
/// spending on, and everything else is sized just past where it stops
/// mattering.
///
/// Measured over 1,680 cases: mean 1.0e-4, p95 4.9e-4, worst 2.1e-3 per share,
/// against the half-tick tolerance of 5e-3 the guard polices.
pub const FAST: Scheme =
    Scheme { integration: 7, iterations: 8, collocation: 6, pricing: 11 };

/// The scheme the grid guard checks the fast path against: mean 5.0e-5, worst
/// 2.3e-3, at 69µs — about two and a half times `FAST`'s cost.
///
/// Sized by the budget rather than by ambition. The guard prices two percent of
/// cells times every leg, which is 320 prices on the PRD's worked example, so
/// every microsecond here costs a third of a millisecond there. `ACCURATE`
/// would be the better yardstick and takes the grid from 37ms to 96ms, which is
/// over budget for a yardstick that improves the worst case by a factor of two.
pub const GUARD: Scheme =
    Scheme { integration: 7, iterations: 16, collocation: 8, pricing: 15 };

/// For a position an analyst pinned as exact: mean 2.4e-5, worst 1.1e-3.
///
/// The worst case barely improves on `FAST` — the remaining error is not the
/// scheme's resolution — so this tier buys a better *typical* answer, not a
/// better guarantee.
pub const ACCURATE: Scheme =
    Scheme { integration: 9, iterations: 24, collocation: 10, pricing: 19 };

#[inline]
fn sq(x: f64) -> f64 {
    x * x
}

/// The solved early-exercise boundary of an American put.
///
/// Held as `H(z) = ln(B/B(0))²` at Chebyshev nodes in `z`, where
/// `τ = T((1+z)/2)²`. Reading a boundary level back out is one barycentric
/// evaluation, an `exp` and a `sqrt`.
///
/// Borrows the solver's tables rather than copying them: a `Boundary` is
/// created once per price and read hundreds of times, and the tables are half a
/// kilobyte.
#[derive(Clone, Copy, Debug)]
pub struct Boundary<'a> {
    /// The boundary at expiry, `K·min(1, r/q)`, which the solver never moves.
    pub at_expiry: f64,
    /// Years to expiry this boundary was solved for.
    pub time: f64,
    cheb: &'a Chebyshev,
    h: [f64; MAX_NODES],
}

impl Boundary<'_> {
    /// `ln(B(τ) / B(0))`, which is what every caller actually wants.
    ///
    /// Since `B = B(0)·exp(-√H)`, this is just `-√H` — and every use of the
    /// boundary is a log-ratio, so the `exp` here and the `log` at the call site
    /// cancel algebraically. Dropping both takes two transcendentals out of the
    /// innermost loop, where they were the dominant cost.
    #[inline]
    pub fn log_level(&self, tau: f64) -> f64 {
        if tau <= 0.0 {
            return 0.0;
        }
        let z = 2.0 * libm::sqrt(tau / self.time) - 1.0;
        // The interpolant can undershoot into negative territory between nodes;
        // H is a square and cannot be negative, so the clamp is a statement
        // about H, not a fudge for the solver.
        -libm::sqrt(self.cheb.eval(&self.h, z).max(0.0))
    }

    /// The exercise boundary with `tau` years still to run.
    pub fn at(&self, tau: f64) -> f64 {
        self.at_expiry * libm::exp(self.log_level(tau))
    }
}

/// `d₋` and `d₊` for a log-ratio that has already been formed.
///
/// Taking the log rather than the ratio keeps the one place that could
/// overflow — `B(τ)/B(s)` for a boundary that has collapsed — out of the
/// caller's arithmetic.
#[inline]
fn d_pair(log_ratio: f64, u: f64, drift: f64, half_var: f64, vol: f64) -> (f64, f64) {
    let sqrt_u = libm::sqrt(u);
    let scale = vol * sqrt_u;
    let base = (log_ratio + drift * u) / scale;
    let spread = half_var * u / scale;
    (base - spread, base + spread)
}

/// The solver, holding the quadrature tables its scheme implies.
///
/// Building a Gauss-Legendre rule is a Newton solve per node, and the grid path
/// prices fifteen thousand times against the same scheme. The tables depend on
/// the scheme alone, so they are built once and the solver is then pure.
#[derive(Clone, Copy, Debug)]
pub struct Solver {
    pub scheme: Scheme,
    equation: Legendre,
    pricing: Legendre,
    cheb: Chebyshev,
}

impl Solver {
    pub fn new(scheme: Scheme) -> Solver {
        Solver {
            scheme,
            equation: Legendre::new(scheme.integration),
            pricing: Legendre::new(scheme.pricing),
            cheb: Chebyshev::new(scheme.collocation),
        }
    }

    /// Solves for the boundary of an American put.
    ///
    /// Requires `rate > 0`: at or below zero there is no exercise region for a
    /// put with a non-negative dividend, and the caller handles that before
    /// getting here.
    pub fn put_boundary(
        &self,
        strike: f64,
        rate: f64,
        dividend: f64,
        vol: f64,
        time: f64,
    ) -> Boundary<'_> {
        // Exercise at expiry pays K - S; holding pays the carry on K minus the
        // carry on S, so the boundary sits where rK = qS. Above r/q = 1 the put
        // is exercised at the strike itself.
        let at_expiry =
            if dividend <= 0.0 { strike } else { strike * (rate / dividend).min(1.0) };

        let drift = rate - dividend;
        let half_var = 0.5 * vol * vol;
        let gl = &self.equation;
        let last = self.cheb.len - 1;
        // ln(B(0)/K), the one log the direct term needs.
        let log_expiry_over_strike = libm::log(at_expiry / strike);

        // H ≡ 0 is the flat boundary B ≡ B(0) — the same shape
        // Bjerksund-Stensland assumes, which makes the first iterate a strict
        // improvement on it.
        let mut boundary =
            Boundary { at_expiry, time, cheb: &self.cheb, h: [0.0; MAX_NODES] };

        for _ in 0..self.scheme.iterations {
            // Jacobi, not Gauss-Seidel: every node is updated from the same
            // previous boundary, so the answer cannot depend on node ordering.
            let mut next = boundary.h;
            for i in 0..last {
                let tau = time * sq(0.5 * (1.0 + self.cheb.nodes[i]));
                if tau <= 0.0 {
                    continue;
                }
                // ln(B(τ)/B(0)) at this node, straight out of the state.
                let log_b_tau = -libm::sqrt(boundary.h[i].max(0.0));

                // The direct terms: the boundary against the strike.
                let (dm, dp) =
                    d_pair(log_expiry_over_strike + log_b_tau, tau, drift, half_var, vol);
                let mut numerator = libm::exp(-rate * tau) * cdf(dm);
                let mut denominator = libm::exp(-dividend * tau) * cdf(dp);

                // The history terms: the boundary against itself, all the way back.
                let mut num_integral = 0.0;
                let mut den_integral = 0.0;
                for j in 0..gl.len {
                    let v = 0.5 * (1.0 + gl.nodes[j]);
                    let elapsed = tau * sq(v);
                    // ln(B(τ)/B(s)) with both exponentials and the log gone.
                    let log_ratio = log_b_tau - boundary.log_level(tau - elapsed);
                    let (dm, dp) = d_pair(log_ratio, elapsed, drift, half_var, vol);
                    // dv/dy folds into the weight: u = τv², du = 2τv dv, v = (1+y)/2.
                    let jacobian = gl.weights[j] * tau * v;
                    num_integral += jacobian * libm::exp(-rate * elapsed) * cdf(dm);
                    den_integral += jacobian * libm::exp(-dividend * elapsed) * cdf(dp);
                }
                numerator += rate * num_integral;
                denominator += dividend * den_integral;

                // A vanishing denominator means there is no exercise region at
                // this maturity; leaving the node where it was lets the rest of
                // the boundary carry the answer rather than injecting an
                // infinity.
                // Written as "not positive" rather than "<= 0" because a NaN
                // has to take this branch too: it means the equation has no
                // usable answer at this node, and leaving the node where it was
                // lets the rest of the boundary carry it.
                let usable = denominator.partial_cmp(&0.0) == Some(core::cmp::Ordering::Greater)
                    && numerator.partial_cmp(&0.0) == Some(core::cmp::Ordering::Greater);
                if !usable {
                    continue;
                }

                // The plain fixed point: a ratio of two positive quantities,
                // which is why it cannot overshoot.
                let b_new =
                    (strike * numerator / denominator).clamp(1e-12 * strike, at_expiry);
                next[i] = sq(libm::log(b_new / at_expiry));
                debug_assert!(next[i] >= 0.0);
            }
            boundary.h = next;
        }

        boundary
    }

    /// The boundary for a unit strike.
    ///
    /// The free-boundary problem is homogeneous of degree one in `(S, K)`, so
    /// `B(τ; K) = K·b(τ)` and `b` depends on nothing but the rate, the dividend,
    /// the volatility and the maturity. Not on the strike, and — the part that
    /// matters — not on the spot.
    ///
    /// That is what makes a grid affordable. A 25×15 grid over a 40-leg book is
    /// 15,000 repricings, but only 600 distinct `(leg, volatility)` pairs: the
    /// spot axis moves the option through a boundary that does not move with it.
    pub fn unit_put_boundary(
        &self,
        rate: f64,
        dividend: f64,
        vol: f64,
        time: f64,
    ) -> Boundary<'_> {
        self.put_boundary(1.0, rate, dividend, vol, time)
    }

    /// American price against a boundary solved for a unit strike.
    ///
    /// The caller is responsible for the boundary matching the contract: same
    /// rate, dividend, volatility and maturity, and for a call, the rate and
    /// dividend already swapped. `price` does that bookkeeping; this is for grid
    /// paths that have hoisted the solve out of their inner loop.
    pub fn price_with(&self, inputs: &Inputs, unit: &Boundary<'_>) -> f64 {
        if inputs.is_degenerate() {
            return bsm::price(inputs);
        }
        let put = match inputs.kind {
            OptionType::Put => *inputs,
            OptionType::Call => Inputs {
                spot: inputs.strike,
                strike: inputs.spot,
                rate: inputs.dividend,
                dividend: inputs.rate,
                kind: OptionType::Put,
                ..*inputs
            },
        };
        if put.rate <= 0.0 {
            return bsm::price(inputs);
        }
        self.put_price_scaled(&put, unit, put.strike * unit.at_expiry)
    }

    /// American put, given a boundary this solver produced.
    pub fn put_price_on(&self, inputs: &Inputs, boundary: &Boundary<'_>) -> f64 {
        self.put_price_scaled(inputs, boundary, boundary.at_expiry)
    }

    /// The pricing integral, with the boundary's scale supplied separately so a
    /// unit boundary can serve any strike.
    fn put_price_scaled(&self, inputs: &Inputs, boundary: &Boundary<'_>, at_expiry: f64) -> f64 {
        let spot = inputs.spot;
        let strike = inputs.strike;
        let time = inputs.time;
        let intrinsic = strike - spot;

        // In log space, so the comparison costs a log rather than an exp — and
        // the log is needed a few lines down anyway.
        let log_spot_over_expiry = libm::log(spot / at_expiry);
        if log_spot_over_expiry <= boundary.log_level(time) {
            return intrinsic;
        }

        let european = bsm::price(inputs);
        let gl = &self.pricing;
        let drift = inputs.rate - inputs.dividend;
        let half_var = 0.5 * inputs.vol * inputs.vol;

        let mut premium = 0.0;
        for j in 0..gl.len {
            let v = 0.5 * (1.0 + gl.nodes[j]);
            let elapsed = time * sq(v);
            // ln(S/B(s)) = ln(S/B(0)) - ln(B(s)/B(0)).
            let log_ratio = log_spot_over_expiry - boundary.log_level(time - elapsed);
            let (dm, dp) = d_pair(log_ratio, elapsed, drift, half_var, inputs.vol);
            let integrand = inputs.rate * strike * libm::exp(-inputs.rate * elapsed) * cdf(-dm)
                - inputs.dividend * spot * libm::exp(-inputs.dividend * elapsed) * cdf(-dp);
            premium += gl.weights[j] * time * v * integrand;
        }

        // Two bounds that hold exactly, whatever the quadrature did: an
        // American option is worth at least its European twin, and at least its
        // intrinsic value.
        (european + premium).max(european).max(intrinsic)
    }

    /// American price. Calls go through the put by symmetry.
    ///
    /// `C(S, K, r, q) = P(K, S, q, r)` is exact, not an approximation, so there
    /// is one boundary solver rather than two that can disagree — the same
    /// argument the Bjerksund-Stensland path already makes for its own
    /// transformation.
    pub fn price(&self, inputs: &Inputs) -> f64 {
        if inputs.is_degenerate() {
            return bsm::price(inputs);
        }

        let put = match inputs.kind {
            OptionType::Put => *inputs,
            OptionType::Call => Inputs {
                spot: inputs.strike,
                strike: inputs.spot,
                rate: inputs.dividend,
                dividend: inputs.rate,
                kind: OptionType::Put,
                ..*inputs
            },
        };

        // With a non-negative dividend and a non-positive rate, holding the put
        // always beats exercising it: there is no interest to collect on the
        // strike and the carry works in the holder's favour. The exercise region
        // is empty and the American put *is* the European one.
        //
        // Priced from the original inputs rather than the mirrored ones. The
        // symmetry is exact in algebra but not in floating point: running a call
        // through the put's arithmetic and back lands a bit or two away from
        // pricing the call directly, and the PRD wants an American call on a
        // non-payer to *equal* its European twin, not to round to it.
        if put.rate <= 0.0 {
            return bsm::price(inputs);
        }

        // Through the unit boundary, the same way the grid path does it.
        //
        // Solving at the contract's own strike would be the obvious thing and is
        // mathematically identical, but it rounds differently: the two paths
        // disagree in the last bit, and PRD 7.1 wants an optimistic client price
        // and the server's authoritative one to *agree*, not to nearly agree.
        // One arithmetic path is the only way to get that.
        let unit = self.unit_put_boundary(put.rate, put.dividend, put.vol, put.time);
        self.put_price_scaled(&put, &unit, put.strike * unit.at_expiry)
    }
}

/// The shared grid-path solver.
pub fn fast_solver() -> &'static Solver {
    cached(FAST)
}

/// The cached solver for a scheme that is used over and over.
fn cached(scheme: Scheme) -> &'static Solver {
    use std::sync::OnceLock;
    static FAST_SOLVER: OnceLock<Solver> = OnceLock::new();
    static GUARD_SOLVER: OnceLock<Solver> = OnceLock::new();
    static ACCURATE_SOLVER: OnceLock<Solver> = OnceLock::new();
    if scheme == ACCURATE {
        ACCURATE_SOLVER.get_or_init(|| Solver::new(ACCURATE))
    } else if scheme == GUARD {
        GUARD_SOLVER.get_or_init(|| Solver::new(GUARD))
    } else {
        FAST_SOLVER.get_or_init(|| Solver::new(FAST))
    }
}

/// American price at an arbitrary scheme. Builds tables; prefer `fast_price`
/// or `accurate_price` on any path that runs more than once.
pub fn price(inputs: &Inputs, scheme: Scheme) -> f64 {
    Solver::new(scheme).price(inputs)
}

/// The grid and portfolio price.
pub fn fast_price(inputs: &Inputs) -> f64 {
    cached(FAST).price(inputs)
}

/// The price the grid guard checks against.
pub fn guard_price(inputs: &Inputs) -> f64 {
    cached(GUARD).price(inputs)
}

/// The pinned-position price.
pub fn accurate_price(inputs: &Inputs) -> f64 {
    cached(ACCURATE).price(inputs)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::american;

    fn put(spot: f64, strike: f64, time: f64, rate: f64, dividend: f64, vol: f64) -> Inputs {
        Inputs { spot, strike, time, rate, dividend, vol, kind: OptionType::Put }
    }

    fn call(spot: f64, strike: f64, time: f64, rate: f64, dividend: f64, vol: f64) -> Inputs {
        Inputs { kind: OptionType::Call, ..put(spot, strike, time, rate, dividend, vol) }
    }

    /// The corpus the accuracy claims are made over, in miniature.
    fn corpus() -> Vec<Inputs> {
        let mut cases = Vec::new();
        for &is_call in &[false, true] {
            for &m in &[0.7, 0.85, 1.0, 1.15, 1.3] {
                for &t in &[0.02, 0.25, 1.0, 2.0] {
                    for &v in &[0.12, 0.3, 0.75] {
                        for &(r, q) in &[(0.045, 0.017), (0.02, 0.06), (0.05, 0.0)] {
                            let i = put(100.0, 100.0 * m, t, r, q, v);
                            cases.push(if is_call { Inputs { kind: OptionType::Call, ..i } } else { i });
                        }
                    }
                }
            }
        }
        cases
    }

    #[test]
    fn never_worth_less_than_european_or_intrinsic() {
        for inputs in corpus() {
            let american = fast_price(&inputs);
            let european = bsm::price(&inputs);
            assert!(american >= european - 1e-12, "{inputs:?}: {american} < {european}");
            assert!(american >= inputs.intrinsic() - 1e-12, "{inputs:?} below intrinsic");
        }
    }

    /// `C(S, K, r, q) = P(K, S, q, r)` is exact, and the solver takes calls
    /// through it, so this checks the transformation is applied consistently
    /// rather than that the identity holds.
    ///
    /// Bit equality only where the boundary solver actually runs. A call on a
    /// non-payer has no exercise region and short-circuits to Black-Scholes on
    /// its *own* inputs, not the mirrored ones — two exactness properties that
    /// cannot both hold, and `an_american_call_on_a_non_payer_is_european` is
    /// the one worth having.
    #[test]
    fn calls_and_puts_agree_through_the_symmetry() {
        for inputs in corpus().into_iter().filter(|i| i.kind == OptionType::Call) {
            let mirrored = put(
                inputs.strike,
                inputs.spot,
                inputs.time,
                inputs.dividend,
                inputs.rate,
                inputs.vol,
            );
            let (direct, through_put) = (fast_price(&inputs), fast_price(&mirrored));
            if inputs.dividend > 0.0 {
                assert_eq!(direct, through_put, "{inputs:?}");
            } else {
                assert!((direct - through_put).abs() < 1e-12, "{inputs:?}");
            }
        }
    }

    #[test]
    fn an_american_call_on_a_non_payer_is_european() {
        for &m in &[0.8, 1.0, 1.2] {
            let inputs = call(100.0, 100.0 * m, 1.0, 0.05, 0.0, 0.3);
            // Early exercise throws away time value and collects no dividend,
            // so it is never optimal and the two prices are the same number.
            assert_eq!(fast_price(&inputs), bsm::price(&inputs));
        }
    }

    #[test]
    fn the_boundary_starts_where_the_carry_balances() {
        let solver = Solver::new(FAST);
        // r above q: exercise at expiry happens at the strike itself.
        assert_eq!(solver.put_boundary(100.0, 0.05, 0.01, 0.3, 1.0).at_expiry, 100.0);
        // r below q: the boundary is pulled down to K·r/q.
        let b = solver.put_boundary(100.0, 0.02, 0.08, 0.3, 1.0);
        assert!((b.at_expiry - 25.0).abs() < 1e-12, "{}", b.at_expiry);
        // No dividend at all: nothing pulls it down.
        assert_eq!(solver.put_boundary(100.0, 0.05, 0.0, 0.3, 1.0).at_expiry, 100.0);
    }

    #[test]
    fn the_boundary_falls_away_from_expiry_and_stays_below_it() {
        let solver = Solver::new(ACCURATE);
        let boundary = solver.put_boundary(100.0, 0.05, 0.02, 0.3, 2.0);
        let mut previous = boundary.at_expiry;
        for step in 1..=40 {
            let tau = 2.0 * step as f64 / 40.0;
            let level = boundary.at(tau);
            // More time to run means more reason to wait, so the boundary only
            // ever falls as tau grows.
            assert!(level <= previous + 1e-9, "tau={tau}: {level} > {previous}");
            assert!(level > 0.0 && level <= boundary.at_expiry);
            previous = level;
        }
    }

    #[test]
    fn below_the_boundary_the_option_is_worth_exercising() {
        let solver = Solver::new(FAST);
        let inputs = put(100.0, 140.0, 1.0, 0.06, 0.0, 0.2);
        let boundary = solver.put_boundary(inputs.strike, inputs.rate, inputs.dividend, inputs.vol, inputs.time);
        let level = boundary.at(inputs.time);
        assert!(level < inputs.strike);

        let inside = Inputs { spot: level * 0.9, ..inputs };
        assert_eq!(solver.price(&inside), inside.strike - inside.spot);
        // And just outside it, the option is worth strictly more than exercising.
        let outside = Inputs { spot: level * 1.1, ..inputs };
        assert!(solver.price(&outside) > outside.intrinsic());
    }

    /// The independent check. Everything else here tests the solver against
    /// itself or against identities; this tests it against a different method
    /// entirely, run out far enough to be trusted.
    ///
    /// Far enough matters: at 255 steps the lattice is still a cent out on the
    /// long-dated in-the-money cases, which is why it cannot be the reference
    /// the guard uses. See `examples/al_scan.rs`.
    #[test]
    fn agrees_with_a_lattice_run_to_convergence() {
        let cases = [
            (put(100.0, 130.0, 2.0, 0.05, 0.0, 0.45), 39.888416),
            (put(100.0, 115.0, 2.0, 0.05, 0.0, 0.30), 21.578972),
            (put(100.0, 100.0, 0.5, 0.045, 0.017, 0.28), 7.226071),
            (put(100.0, 85.0, 0.08, 0.045, 0.017, 0.35), 0.181711),
            (call(100.0, 70.0, 2.0, 0.02, 0.06, 0.45), 34.878819),
            (call(100.0, 100.0, 1.0, 0.02, 0.06, 0.30), 10.102138),
        ];
        let reference = Solver::new(Scheme {
            integration: 35,
            iterations: 128,
            collocation: 24,
            pricing: 39,
        });
        for (inputs, lattice_32767) in cases {
            let got = reference.price(&inputs);
            // The lattice's own remaining error at 32,767 steps dominates this
            // tolerance: it is still climbing towards the solver, so the gap
            // that is left is mostly the lattice's, not the solver's.
            assert!(
                (got - lattice_32767).abs() < 1e-4,
                "{inputs:?}: {got} vs lattice {lattice_32767}",
            );
        }
    }

    #[test]
    fn beats_bjerksund_stensland_everywhere_it_matters() {
        let reference = Solver::new(Scheme {
            integration: 35,
            iterations: 128,
            collocation: 24,
            pricing: 39,
        });
        let mut al_worse = 0;
        for inputs in corpus() {
            let truth = reference.price(&inputs);
            let al = (fast_price(&inputs) - truth).abs();
            let bs = (american::fast_price(&inputs) - truth).abs();
            if al > bs + 1e-9 {
                al_worse += 1;
            }
            // The claim the guard depends on: inside half a tick, always.
            assert!(al < 5e-3, "{inputs:?}: error {al}");
        }
        assert_eq!(al_worse, 0, "{al_worse} cases where the closed form was closer");
    }

    /// The homogeneity claim the grid path is built on, stated as a test: one
    /// boundary solved at a unit strike prices every strike and every spot.
    #[test]
    fn a_unit_boundary_prices_any_contract() {
        let solver = Solver::new(FAST);
        for &(r, q) in &[(0.045, 0.017), (0.02, 0.06), (0.05, 0.0)] {
            for &(vol, time) in &[(0.2, 1.0), (0.45, 0.25), (0.12, 2.0)] {
                let unit = solver.unit_put_boundary(r, q, vol, time);
                let mirrored = solver.unit_put_boundary(q, r, vol, time);
                for &strike in &[60.0, 100.0, 175.0] {
                    for step in 0..12 {
                        let spot = 50.0 + 15.0 * step as f64;
                        let p = put(spot, strike, time, r, q, vol);
                        assert_eq!(solver.price_with(&p, &unit), solver.price(&p), "{p:?}");
                        let c = call(spot, strike, time, r, q, vol);
                        assert_eq!(solver.price_with(&c, &mirrored), solver.price(&c), "{c:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn is_monotone_in_spot() {
        let solver = Solver::new(FAST);
        let base = put(100.0, 100.0, 1.0, 0.045, 0.017, 0.3);
        let mut previous = f64::INFINITY;
        for step in 0..60 {
            let spot = 40.0 + 2.0 * step as f64;
            let value = solver.price(&Inputs { spot, ..base });
            assert!(value <= previous + 1e-9, "spot={spot}: {value} > {previous}");
            previous = value;
        }
    }

    #[test]
    fn degenerate_inputs_fall_through_to_black_scholes() {
        for inputs in [
            put(100.0, 100.0, 0.0, 0.05, 0.01, 0.3),
            put(100.0, 100.0, 1.0, 0.05, 0.01, 0.0),
            put(0.0, 100.0, 1.0, 0.05, 0.01, 0.3),
        ] {
            assert_eq!(fast_price(&inputs), bsm::price(&inputs));
        }
    }

    /// A put with a non-positive rate has no exercise region, and the solver
    /// says so exactly rather than approximately.
    #[test]
    fn a_zero_rate_put_is_european() {
        for &rate in &[0.0, -0.01] {
            let inputs = put(100.0, 120.0, 1.0, rate, 0.0, 0.3);
            assert_eq!(fast_price(&inputs), bsm::price(&inputs));
        }
    }
}
