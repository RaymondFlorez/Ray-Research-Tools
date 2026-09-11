//! American exercise (PRD 5.4, Appendix C.2).
//!
//! Appendix C.2 settles the method question with an architecture rather than a
//! preference: a fast approximation on grid and portfolio paths, an exact
//! lattice on detail views, and **a guard that measures the approximation
//! rather than trusting it**.
//!
//!   "Every grid evaluation spot-checks a stratified random 2 percent of cells
//!   against the lattice. If max absolute error exceeds 0.5 ticks or 25bps of
//!   the position's notional Greeks, whichever is tighter, the engine
//!   automatically escalates the affected region of the grid to the lattice and
//!   continues."
//!
//! That guard is the load-bearing part, and it is what makes the choice of
//! approximation an engineering decision instead of an article of faith.
//!
//! **Deviation from the PRD, stated plainly:** C.2 names Andersen-Lake for the
//! fast path. This implements Bjerksund-Stensland (1993), which needs only the
//! univariate normal — Andersen-Lake is a high-order integral-equation method
//! and a research project in its own right, and the 2002 Bjerksund-Stensland
//! refinement needs a bivariate normal CDF. The guard measures whatever
//! approximation sits here, so the substitution is visible in the error
//! statistics rather than hidden; `fast_price` is the single seam to replace.

use crate::bsm::{self, Inputs, OptionType};
use crate::normal::cdf;


/// Terminal spot levels, built by repeated multiplication.
///
/// The obvious `u.powi(i) * d.powi(n - i)` inside the backward induction is an
/// O(n^2) pile of `pow` calls for values that only take n+1 distinct forms, and
/// it leaves the arithmetic order up to the compiler on each target. Building
/// the ladder once is faster and identical everywhere.
fn spot_levels(spot: f64, u: f64, d: f64, steps: usize) -> Vec<f64> {
    let mut levels = Vec::with_capacity(steps + 1);
    let mut level = spot;
    for _ in 0..steps {
        level *= d;
    }
    levels.push(level);
    let ratio = u / d;
    for _ in 0..steps {
        level *= ratio;
        levels.push(level);
    }
    levels
}

#[inline]
fn payoff(inputs: &Inputs, spot: f64) -> f64 {
    exercise_value(inputs, spot).max(0.0)
}

#[inline]
fn exercise_value(inputs: &Inputs, spot: f64) -> f64 {
    match inputs.kind {
        OptionType::Call => spot - inputs.strike,
        OptionType::Put => inputs.strike - spot,
    }
}

/// Cox-Ross-Rubinstein binomial with American exercise. The reference.
///
/// This is the "exact" side of the guard. It is slow by design: correctness
/// here is what the fast path is measured against.
pub fn binomial_price(inputs: &Inputs, steps: usize) -> f64 {
    if inputs.time <= 0.0 {
        return inputs.intrinsic();
    }
    let steps = steps.max(1);
    let dt = inputs.time / steps as f64;
    let u = libm::exp(inputs.vol * dt.sqrt());
    let d = 1.0 / u;
    let disc = libm::exp(-inputs.rate * dt);
    let growth = libm::exp(inputs.carry() * dt);

    // A vol so low, or a step so long, that the tree cannot move past the drift
    // gives a degenerate probability; fall back rather than emit nonsense.
    let p = (growth - d) / (u - d);
    if !(0.0..=1.0).contains(&p) {
        return bsm::price(inputs);
    }

    let levels = spot_levels(inputs.spot, u, d, steps);
    let mut values: Vec<f64> = (0..=steps)
        .map(|i| payoff(inputs, levels[i]))
        .collect();

    // Walking back one layer divides every level by d exactly once.
    let inv_d = 1.0 / d;
    let mut scale = 1.0;
    for step in (0..steps).rev() {
        scale *= inv_d;
        for i in 0..=step {
            let hold = disc * (p * values[i + 1] + (1.0 - p) * values[i]);
            values[i] = hold.max(exercise_value(inputs, levels[i] * scale));
        }
    }
    values[0]
}

/// Bjerksund-Stensland (1993) for an American call.
fn bs93_call(s: f64, k: f64, t: f64, r: f64, b: f64, sigma: f64) -> f64 {
    let euro = bsm::price(&Inputs {
        spot: s,
        strike: k,
        time: t,
        rate: r,
        dividend: r - b,
        vol: sigma,
        kind: OptionType::Call,
    });

    // With a cost of carry at or above the rate, early exercise is never
    // optimal and the American call is exactly the European one.
    if b >= r {
        return euro;
    }

    let v2 = sigma * sigma;
    let beta = (0.5 - b / v2) + ((b / v2 - 0.5).powi(2) + 2.0 * r / v2).sqrt();
    if !beta.is_finite() || beta <= 1.0 {
        return euro;
    }

    let b_inf = beta / (beta - 1.0) * k;
    let b_zero = (k).max(r / (r - b) * k);
    let h = -(b * t + 2.0 * sigma * t.sqrt()) * (b_zero / (b_inf - b_zero));
    let trigger = b_zero + (b_inf - b_zero) * (1.0 - libm::exp(h));

    if s >= trigger {
        // Already past the exercise boundary: the option is worth intrinsic.
        return s - k;
    }

    let alpha = (trigger - k) * libm::pow(trigger, -beta);
    let value = alpha * libm::pow(s, beta) - alpha * phi(s, t, beta, trigger, trigger, r, b, sigma)
        + phi(s, t, 1.0, trigger, trigger, r, b, sigma)
        - phi(s, t, 1.0, k, trigger, r, b, sigma)
        - k * phi(s, t, 0.0, trigger, trigger, r, b, sigma)
        + k * phi(s, t, 0.0, k, trigger, r, b, sigma);

    // The American option is worth at least the European one and at least
    // intrinsic; the approximation can violate either at the edges.
    value.max(euro).max(s - k)
}

fn phi(s: f64, t: f64, gamma: f64, h: f64, x: f64, r: f64, b: f64, sigma: f64) -> f64 {
    let v2 = sigma * sigma;
    let sqrt_t = t.sqrt();
    let lambda = -r + gamma * b + 0.5 * gamma * (gamma - 1.0) * v2;
    let kappa = 2.0 * b / v2 + 2.0 * gamma - 1.0;
    let d = -(libm::log(s / h) + (b + (gamma - 0.5) * v2) * t) / (sigma * sqrt_t);
    let d2 = d - 2.0 * libm::log(x / s) / (sigma * sqrt_t);

    libm::exp(lambda * t) * libm::pow(s, gamma) * (cdf(d) - libm::pow(x / s, kappa) * cdf(d2))
}

/// The fast American price used on grid, scenario and portfolio paths.
///
/// The put is priced through the McDonald-Schroder transformation
/// `P(S, K, T, r, b) = C(K, S, T, r - b, -b)`, so there is one implementation
/// of the boundary rather than two that can disagree.
pub fn fast_price(inputs: &Inputs) -> f64 {
    if inputs.is_degenerate() {
        return bsm::price(inputs);
    }
    let b = inputs.carry();
    match inputs.kind {
        OptionType::Call => bs93_call(
            inputs.spot,
            inputs.strike,
            inputs.time,
            inputs.rate,
            b,
            inputs.vol,
        ),
        OptionType::Put => bs93_call(
            inputs.strike,
            inputs.spot,
            inputs.time,
            inputs.rate - b,
            -b,
            inputs.vol,
        ),
    }
}

/// Leisen-Reimer tree with American exercise. The exact reference.
///
/// CRR converges at O(1/n) and, worse, systematically: its nodes fall wherever
/// the geometry puts them, so the strike lands between nodes and the error does
/// not average away. Leisen-Reimer inverts the binomial probabilities so the
/// strike sits at the centre of the terminal distribution, and converges at
/// O(1/n^2) smoothly. On the cases measured here it is roughly two orders of
/// magnitude better than CRR at the same step count.
///
/// The guard's whole credibility rests on this being right: an approximation
/// checked against a sloppy reference is not checked at all.
pub fn leisen_reimer_price(inputs: &Inputs, steps: usize) -> f64 {
    if inputs.time <= 0.0 {
        return inputs.intrinsic();
    }
    if inputs.is_degenerate() {
        return bsm::price(inputs);
    }
    // The method is defined for an odd number of steps.
    let n = if steps % 2 == 0 { steps + 1 } else { steps };
    let dt = inputs.time / n as f64;
    let sqrt_t = inputs.time.sqrt();
    let vol_sqrt_t = inputs.vol * sqrt_t;

    let d1 = (libm::log(inputs.spot / inputs.strike)
        + (inputs.carry() + 0.5 * inputs.vol * inputs.vol) * inputs.time)
        / vol_sqrt_t;
    let d2 = d1 - vol_sqrt_t;

    // Peizer-Pratt inversion, method two.
    let h = |z: f64| -> f64 {
        let nf = n as f64;
        let denom = nf + 1.0 / 3.0 + 0.1 / (nf + 1.0);
        let inner = (z / denom).powi(2) * (nf + 1.0 / 6.0);
        0.5 + z.signum() * (0.25 - 0.25 * libm::exp(-inner)).sqrt()
    };

    let p = h(d2);
    let p_dash = h(d1);
    if !(0.0..=1.0).contains(&p) || p == 0.0 || p == 1.0 {
        return binomial_price(inputs, n);
    }

    let growth = libm::exp(inputs.carry() * dt);
    let u = growth * p_dash / p;
    let d = (growth - p * u) / (1.0 - p);
    let disc = libm::exp(-inputs.rate * dt);

    let levels = spot_levels(inputs.spot, u, d, n);
    let mut values: Vec<f64> = (0..=n).map(|i| payoff(inputs, levels[i])).collect();

    // Walking back one layer divides every level by d exactly once.
    let inv_d = 1.0 / d;
    let mut scale = 1.0;
    for step in (0..n).rev() {
        scale *= inv_d;
        for i in 0..=step {
            let hold = disc * (p * values[i + 1] + (1.0 - p) * values[i]);
            values[i] = hold.max(exercise_value(inputs, levels[i] * scale));
        }
    }
    values[0]
}

/// Steps for the guard's reference lattice.
///
/// **No longer the guard's reference, because it was not accurate enough.**
///
/// This was chosen from `examples/lr_steps.rs`, on a measured error of 5.6e-4
/// per share — about a ninth of the half-tick tolerance the guard polices. That
/// measurement was taken at the money, and it does not survive contact with the
/// rest of the surface: deep in the money on a two-year maturity the error at
/// 51 steps is 6.2e-2, twelve times the tolerance it was supposed to police.
/// `examples/al_scan.rs` has the full table, and `exact_price` now goes
/// elsewhere.
///
/// Kept, with the step count it was measured at, because the lattice is still
/// the independent cross-check on a method that now has no other.
pub const EXACT_STEPS: usize = 51;

/// Steps for a single position an analyst pinned as exact.
///
/// Worst case 1.3e-2 per share, on the same cases that caught out `EXACT_STEPS`
/// — better, and still not good enough to be a reference. It costs 69us, which
/// is more than the Andersen-Lake scheme that beats it by a factor of six.
pub const DETAIL_STEPS: usize = 255;

/// The reference the guard checks the grid against.
///
/// **This was the lattice, and the lattice was not good enough.** At 51 steps
/// Leisen-Reimer carries a mean error of 2.3e-3 and a worst case of 6.2e-2 per
/// share, against the half-tick tolerance of 5e-3 the guard polices — the
/// yardstick was out by twelve times the thing it was measuring. The 5.6e-4
/// figure this crate used to quote was measured at the money, and the error
/// deep in the money on long maturities is two orders of magnitude larger.
/// `examples/al_scan.rs` has the numbers, and its first table shows the lattice
/// still climbing towards the right answer at 32,767 steps.
///
/// So the reference is now Andersen-Lake at its guard scheme: mean 5.0e-5,
/// worst 2.3e-3, and cheaper than a 255-step lattice besides.
///
/// **What that costs, stated plainly:** the guard's fast path is now
/// Andersen-Lake too, so the guard compares one scheme against a finer scheme of
/// the same method. It measures convergence, not method error, and it would not
/// catch a mistake common to both. The independent check moved to where it can
/// afford to be honest — `andersen_lake`'s test suite, against a lattice run out
/// to 32,767 steps, where a single price may take a second.
pub fn exact_price(inputs: &Inputs) -> f64 {
    crate::andersen_lake::guard_price(inputs)
}

/// The exact American price for a pinned detail view.
pub fn detail_price(inputs: &Inputs) -> f64 {
    crate::andersen_lake::accurate_price(inputs)
}

/// Greeks by central difference on the exact lattice, for a pinned position.
///
/// The PRD calls for adjoint differentiation here. Finite differences on a
/// 512-step lattice are far slower and are what this is: correct, and honest
/// about being the slow path. It runs on single positions, not on grids.
pub fn exact_greeks(inputs: &Inputs) -> bsm::Greeks {
    let ds = inputs.spot * 1e-4;
    let dvol = 1e-4;
    let dt = (inputs.time * 1e-3).min(1.0 / 365.0);

    let bump = |f: &dyn Fn(&mut Inputs)| {
        let mut copy = *inputs;
        f(&mut copy);
        detail_price(&copy)
    };

    let base = detail_price(inputs);
    let up = bump(&|i: &mut Inputs| i.spot += ds);
    let down = bump(&|i: &mut Inputs| i.spot -= ds);
    let vol_up = bump(&|i: &mut Inputs| i.vol += dvol);
    let vol_down = bump(&|i: &mut Inputs| i.vol -= dvol);
    let time_down = bump(&|i: &mut Inputs| i.time = (i.time - dt).max(0.0));

    bsm::Greeks {
        price: base,
        delta: (up - down) / (2.0 * ds),
        gamma: (up - 2.0 * base + down) / (ds * ds),
        vega: (vol_up - vol_down) / (2.0 * dvol),
        theta: if dt > 0.0 { (time_down - base) / dt } else { 0.0 },
        // The remaining Greeks are not differenced here: each costs another
        // pair of lattices, and nothing on the detail path asks for them yet.
        ..Default::default()
    }
}
