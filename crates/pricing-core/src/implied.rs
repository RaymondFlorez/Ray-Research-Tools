//! Implied volatility (PRD 5.4).
//!
//! "implied vol computed with a robust solver (Brent with Jaeckel's 'Let's Be
//! Rational' for speed and accuracy at the wings)."
//!
//! What is here is a Newton solve with a guaranteed bracket behind it: Newton
//! for the speed, bisection whenever Newton would leave the bracket or vega
//! collapses. That collapse is exactly what happens at the wings, where a naive
//! Newton solver diverges or returns a number with no digits in it — so the
//! bracket is not a fallback, it is the thing that makes the solver honest.
//!
//! Jäckel's method reaches machine precision in two iterations rather than
//! twenty. This reaches the same answer more slowly, and reports when it
//! cannot.

use crate::bsm::{self, Inputs, OptionType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolveFailure {
    /// Below intrinsic: no volatility produces this price.
    BelowIntrinsic,
    /// At or above the option's upper bound; vol would be unbounded.
    AboveUpperBound,
    /// Expired or otherwise degenerate.
    Degenerate,
    /// Bracketed, but did not converge in the iteration budget.
    NoConvergence,
    /// The price carries no information about volatility.
    ///
    /// Deep in the money and near expiry, vega collapses to zero: every vol in
    /// a wide band reproduces the price to the last bit of a double. A solver
    /// that returns one of them is inventing a number, and an analyst who
    /// charts it will read structure in the noise. A chain shows "--" here, and
    /// so does this.
    NotIdentifiable,
}

/// Below this vega, in currency per unit of vol, the inverse problem is dead.
///
/// Read it as a conditioning bound: at this vega a whole vol point moves the
/// price by 1e-6, so the vol consistent with even an exactly-known price spans
/// a range no analyst could use. Deep in the money and near expiry the price is
/// intrinsic and carries no vol information at all, and a solver that answers
/// anyway is inventing structure.
const MIN_IDENTIFIABLE_VEGA: f64 = 1e-4;

#[derive(Clone, Copy, Debug)]
pub struct Solution {
    pub vol: f64,
    pub iterations: u32,
    /// Absolute price error at the returned vol.
    pub residual: f64,
}

pub const MAX_VOL: f64 = 10.0;
const TOLERANCE: f64 = 1e-10;
const MAX_ITERATIONS: u32 = 100;

/// Solves for the volatility that reproduces `target` price.
pub fn implied_vol(inputs: &Inputs, target: f64) -> Result<Solution, SolveFailure> {
    if inputs.time <= 0.0 || inputs.spot <= 0.0 || inputs.strike <= 0.0 || !target.is_finite() {
        return Err(SolveFailure::Degenerate);
    }

    let disc_r = libm::exp(-inputs.rate * inputs.time);
    let disc_q = libm::exp(-inputs.dividend * inputs.time);
    let forward = inputs.spot * disc_q;
    let strike_pv = inputs.strike * disc_r;

    // No-arbitrage bounds. Outside them there is no volatility to find, and
    // saying so beats returning a number the analyst would trade on.
    let lower = match inputs.kind {
        OptionType::Call => (forward - strike_pv).max(0.0),
        OptionType::Put => (strike_pv - forward).max(0.0),
    };
    let upper = match inputs.kind {
        OptionType::Call => forward,
        OptionType::Put => strike_pv,
    };

    if target < lower - 1e-12 {
        return Err(SolveFailure::BelowIntrinsic);
    }
    if target >= upper - 1e-12 {
        return Err(SolveFailure::AboveUpperBound);
    }

    let mut probe = *inputs;
    let price_at = |vol: f64, probe: &mut Inputs| {
        probe.vol = vol;
        bsm::price(probe)
    };

    // Bracket: price is monotone in vol, so a low and a high vol whose prices
    // straddle the target enclose the answer.
    let mut low = 1e-9;
    let mut high = 1.0;
    let mut price_high = price_at(high, &mut probe);
    let mut guard = 0;
    while price_high < target && high < MAX_VOL {
        high *= 2.0;
        price_high = price_at(high, &mut probe);
        guard += 1;
        if guard > 40 {
            break;
        }
    }
    if price_high < target {
        return Err(SolveFailure::AboveUpperBound);
    }

    // Brenner-Subrahmanyam starting point: exact at the money, close nearby.
    let mut vol = (2.0 * std::f64::consts::PI / inputs.time).sqrt() * target / inputs.spot;
    if !vol.is_finite() || vol <= low || vol >= high {
        vol = 0.5 * (low + high);
    }

    for iteration in 1..=MAX_ITERATIONS {
        probe.vol = vol;
        let g = bsm::greeks(&probe);
        let diff = g.price - target;

        if diff.abs() < TOLERANCE {
            if g.vega < MIN_IDENTIFIABLE_VEGA {
                return Err(SolveFailure::NotIdentifiable);
            }
            return Ok(Solution {
                vol,
                iterations: iteration,
                residual: diff.abs(),
            });
        }

        // Keep the bracket tight as we go: every evaluation narrows it.
        if diff > 0.0 {
            high = vol;
        } else {
            low = vol;
        }

        // Newton, but only when vega is meaningful and the step stays inside
        // the bracket. At the wings vega goes to zero and Newton's step goes
        // to infinity, which is where naive solvers return nonsense.
        let next = if g.vega > 1e-12 {
            let candidate = vol - diff / g.vega;
            if candidate > low && candidate < high && candidate.is_finite() {
                candidate
            } else {
                0.5 * (low + high)
            }
        } else {
            0.5 * (low + high)
        };

        if (next - vol).abs() < 1e-14 {
            probe.vol = next;
            let settled = bsm::greeks(&probe);
            if settled.vega < MIN_IDENTIFIABLE_VEGA {
                return Err(SolveFailure::NotIdentifiable);
            }
            return Ok(Solution {
                vol: next,
                iterations: iteration,
                residual: (settled.price - target).abs(),
            });
        }
        vol = next;
    }

    Err(SolveFailure::NoConvergence)
}
