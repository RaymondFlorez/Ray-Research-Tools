//! Hull-White short rate lattice, for OAS on callables (PRD 5.3).
//!
//! A z-spread asks what has to be added to the curve to explain a bond's price.
//! For a callable that question is malformed: part of the price is a short
//! option, and a spread that absorbs it is measuring the option, not the credit.
//! An option-adjusted spread separates the two by pricing the option explicitly
//! on a rate model and asking what spread explains the *rest*.
//!
//! # The construction
//!
//! Hull-White's two-stage trinomial tree. The first stage builds a symmetric
//! tree in a zero-mean process `x`, with the branching flattened above a cutoff
//! level so the probabilities stay positive. The second stage displaces each
//! time slice by `α(t)`, chosen by forward induction so that the tree reprices
//! the initial term structure exactly.
//!
//! "Exactly" is the load-bearing word, and it is checked rather than assumed:
//! `reprices_the_curve_it_was_calibrated_to` walks every slice and compares the
//! tree's zero-coupon bond against the curve's.
//!
//! # Why the branching has to change at the top
//!
//! Mean reversion pulls high nodes downward, and far enough up, the expected
//! next value is below the node beneath — at which point ordinary up/mid/down
//! branching needs a negative probability to match the variance. Hull-White's
//! answer is to switch to down/down-down branching past a cutoff, and the
//! cutoff falls out of requiring the middle probability to stay non-negative:
//! `j·a·Δt ≥ 0.1835`. That constant is not a tuning parameter; it is
//! `1 - sqrt(2/3)`.

use crate::curve::Curve;
use crate::solve;

/// The short rate model: `dr = (θ(t) − a·r)dt + σ dW`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HullWhite {
    /// Mean reversion speed. Higher means the curve's shape decays faster.
    pub mean_reversion: f64,
    /// Absolute (not proportional) short rate volatility, in decimals.
    pub vol: f64,
}

/// A calibrated tree.
#[derive(Clone, Debug)]
pub struct Lattice {
    dt: f64,
    dx: f64,
    /// `exp(-a·Δt) − 1`: the proportional pull towards zero over one step.
    decay: f64,
    /// Largest node index, where the branching flattens.
    j_max: i32,
    /// Displacement per slice, fitted to the curve.
    alpha: Vec<f64>,
    /// Node half-width per slice.
    width: Vec<i32>,
}

/// One node's successors: the centre index, and the three probabilities.
#[derive(Clone, Copy, Debug)]
struct Branch {
    centre: i32,
    up: f64,
    mid: f64,
    down: f64,
}

impl HullWhite {
    /// Builds and fits a tree of `steps` steps of length `dt`.
    ///
    /// The curve is sampled at every slice, so `dt` should divide the cash flow
    /// dates of whatever is being priced — a flow landing between slices would
    /// be discounted from the wrong place.
    pub fn calibrate(&self, curve: &Curve, dt: f64, steps: usize) -> Lattice {
        let a = self.mean_reversion.max(1e-8);
        let dx = self.vol * libm::sqrt(3.0 * dt);
        let decay = libm::exp(-a * dt) - 1.0;
        // 1 - sqrt(2/3), divided by the per-step pull. Above this the middle
        // probability would have to go negative.
        let j_max = (libm::ceil(0.1835 / (a * dt)) as i32).max(1);

        let mut lattice = Lattice {
            dt,
            dx,
            decay,
            j_max,
            alpha: Vec::with_capacity(steps),
            width: (0..=steps).map(|i| (i as i32).min(j_max)).collect(),
        };

        // Forward induction on Arrow-Debreu prices: `q[j]` is the value today
        // of one unit paid at this slice if the tree is at node j.
        let mut q = vec![1.0f64];
        for i in 0..steps {
            let width = lattice.width[i];
            // Fit this slice's displacement so the tree's zero-coupon bond to
            // the *next* slice equals the curve's.
            let target = curve.discount(dt * (i + 1) as f64);
            let weighted: f64 = (-width..=width)
                .map(|j| q[(j + width) as usize] * libm::exp(-(j as f64) * dx * dt))
                .sum();
            let alpha = libm::log(weighted / target) / dt;
            lattice.alpha.push(alpha);

            // Roll the Arrow-Debreu prices forward one slice.
            let next_width = lattice.width[i + 1];
            let mut next = vec![0.0f64; (2 * next_width + 1) as usize];
            for j in -width..=width {
                let value = q[(j + width) as usize];
                if value == 0.0 {
                    continue;
                }
                let discount = libm::exp(-(alpha + (j as f64) * dx) * dt);
                let branch = lattice.branch(j);
                for (offset, probability) in
                    [(1, branch.up), (0, branch.mid), (-1, branch.down)]
                {
                    let target_index = branch.centre + offset;
                    next[(target_index + next_width) as usize] += value * probability * discount;
                }
            }
            q = next;
        }

        lattice
    }
}

impl Lattice {
    pub fn steps(&self) -> usize {
        self.alpha.len()
    }

    pub fn dt(&self) -> f64 {
        self.dt
    }

    /// The short rate at a node.
    pub fn short_rate(&self, step: usize, j: i32) -> f64 {
        self.alpha[step] + (j as f64) * self.dx
    }

    /// Where node `j` branches to, and with what probabilities.
    fn branch(&self, j: i32) -> Branch {
        // Ordinary branching aims at the nearest node to the mean-reverted
        // value; at the edges it is forced inward so the tree stops widening.
        let drifted = (j as f64) * (1.0 + self.decay);
        let centre = if j >= self.j_max {
            j - 1
        } else if j <= -self.j_max {
            j + 1
        } else {
            libm::round(drifted) as i32
        };

        // One derivation covers every branching: match the mean and the
        // variance against whichever centre was chosen. The published
        // special-case formulas for the edge cases are this, with the centre
        // substituted in.
        let e = drifted - (centre as f64);
        Branch {
            centre,
            up: 1.0 / 6.0 + 0.5 * (e * e + e),
            mid: 2.0 / 3.0 - e * e,
            down: 1.0 / 6.0 + 0.5 * (e * e - e),
        }
    }

    /// The tree's own zero-coupon bond price to slice `step`.
    ///
    /// Should equal the curve it was calibrated to. Exposed so that can be
    /// checked rather than trusted.
    pub fn zero_coupon(&self, step: usize) -> f64 {
        self.price(&[], &[], step, 0.0, |_, _| None)
    }

    /// Backward induction.
    ///
    /// `flows[i]` is paid at slice `i`. `call` returns the price at which the
    /// issuer may redeem at that slice, if it may.
    fn price<F>(
        &self,
        flows: &[f64],
        redemption: &[f64],
        horizon: usize,
        spread: f64,
        call: F,
    ) -> f64
    where
        F: Fn(usize, f64) -> Option<f64>,
    {
        let width = self.width[horizon];
        // At the horizon the tree pays whatever is left: a redemption for a
        // bond, one unit for a zero-coupon probe — plus the final coupon, which
        // falls due on the maturity date and is not picked up by the backward
        // loop, since that starts one slice earlier.
        let terminal = if redemption.is_empty() { 1.0 } else { redemption[0] }
            + flows.get(horizon).copied().unwrap_or(0.0);
        let mut values = vec![terminal; (2 * width + 1) as usize];

        for step in (0..horizon).rev() {
            let width = self.width[step];
            let next_width = self.width[step + 1];
            let mut current = vec![0.0f64; (2 * width + 1) as usize];
            for j in -width..=width {
                let branch = self.branch(j);
                let at = |index: i32| values[(index + next_width) as usize];
                let expected = branch.up * at(branch.centre + 1)
                    + branch.mid * at(branch.centre)
                    + branch.down * at(branch.centre - 1);
                let rate = self.short_rate(step, j) + spread;
                let mut value = libm::exp(-rate * self.dt) * expected;

                // The issuer redeems when continuing costs more than calling.
                // Applied before the coupon is added, because a coupon due on
                // the call date is paid either way and cannot influence the
                // decision.
                if let Some(strike) = call(step, self.dt * step as f64) {
                    value = value.min(strike);
                }
                if step < flows.len() {
                    value += flows[step];
                }
                current[(j + width) as usize] = value;
            }
            values = current;
        }
        values[0]
    }
}

/// A bond on the lattice: cash flows aligned to slices, and an optional call
/// schedule.
#[derive(Clone, Debug)]
pub struct LatticeBond {
    /// Amount paid at each slice. Index `i` is time `i·dt`.
    pub flows: Vec<f64>,
    /// Amount repaid at the horizon, on top of the last flow.
    pub redemption: f64,
    /// `(slice, price)` pairs at which the issuer may redeem.
    pub calls: Vec<(usize, f64)>,
}

impl LatticeBond {
    /// A straight bond: `coupon` per slice, redeemed at the horizon.
    pub fn bullet(coupon: f64, redemption: f64, slices: usize) -> LatticeBond {
        LatticeBond {
            flows: vec![coupon; slices + 1],
            redemption,
            calls: Vec::new(),
        }
    }

    /// Callable at `price` from `first` onwards, at every slice.
    pub fn callable_from(mut self, first: usize, price: f64) -> LatticeBond {
        let last = self.flows.len().saturating_sub(1);
        self.calls = (first..last).map(|slice| (slice, price)).collect();
        self
    }

    fn horizon(&self) -> usize {
        self.flows.len().saturating_sub(1)
    }
}

impl Lattice {
    /// Present value of a bond on this lattice, at a constant spread.
    pub fn bond_price(&self, bond: &LatticeBond, spread: f64) -> f64 {
        let horizon = bond.horizon().min(self.steps());
        let calls = &bond.calls;
        self.price(
            &bond.flows,
            &[bond.redemption],
            horizon,
            spread,
            |slice, _| calls.iter().find(|&&(s, _)| s == slice).map(|&(_, price)| price),
        )
    }

    /// The spread that makes this lattice reproduce a market price.
    ///
    /// For a bond with no call schedule this is the z-spread, arrived at by a
    /// completely different route — which is why
    /// `oas_of_a_straight_bond_is_its_z_spread` is the test that matters here.
    pub fn option_adjusted_spread(&self, bond: &LatticeBond, price: f64) -> Option<f64> {
        if !price.is_finite() || price <= 0.0 {
            return None;
        }
        solve::bisect(|s| self.bond_price(bond, s) - price, -0.20, 2.0)
    }

    /// What the embedded option is worth: the straight bond less the callable one.
    pub fn option_value(&self, bond: &LatticeBond, spread: f64) -> f64 {
        let straight = LatticeBond { calls: Vec::new(), ..bond.clone() };
        self.bond_price(&straight, spread) - self.bond_price(bond, spread)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::bond::z_spread;
    use crate::curve::{present_value, Curve, CurveShock};

    fn curve() -> Curve {
        Curve::from_zeros(
            &[0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 20.0, 30.0],
            &[0.0515, 0.0472, 0.0428, 0.0404, 0.0389, 0.0388, 0.0394, 0.0407, 0.0399],
        )
    }

    fn model() -> HullWhite {
        HullWhite { mean_reversion: 0.05, vol: 0.011 }
    }

    const DT: f64 = 0.5;
    const SLICES: usize = 20; // ten years, semiannual

    /// The calibration condition, checked rather than assumed. Everything else
    /// in this file rests on the tree agreeing with the curve.
    #[test]
    fn reprices_the_curve_it_was_calibrated_to() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        for step in 1..=SLICES {
            let tree = lattice.zero_coupon(step);
            let market = curve().discount(DT * step as f64);
            assert!(
                libm::fabs(tree - market) < 1e-12,
                "slice {step}: tree {tree} vs curve {market}",
            );
        }
    }

    #[test]
    fn every_branching_probability_is_a_probability() {
        // A steep tree with slow reversion is where the edge branching has to
        // kick in; without it the middle probability goes negative.
        for &(a, vol, dt) in &[(0.05, 0.011, 0.5), (0.01, 0.02, 0.25), (0.3, 0.005, 1.0)] {
            let model = HullWhite { mean_reversion: a, vol };
            let lattice = model.calibrate(&curve(), dt, 40);
            for j in -lattice.j_max..=lattice.j_max {
                let b = lattice.branch(j);
                for (name, p) in [("up", b.up), ("mid", b.mid), ("down", b.down)] {
                    assert!(
                        (0.0..=1.0).contains(&p),
                        "a={a} vol={vol} dt={dt}, node {j}: {name} = {p}",
                    );
                }
                assert!(libm::fabs(b.up + b.mid + b.down - 1.0) < 1e-12);
            }
        }
    }

    #[test]
    fn the_tree_stops_widening_at_the_cutoff() {
        let lattice = model().calibrate(&curve(), DT, 200);
        assert!(lattice.j_max < 200);
        // Past the cutoff every slice is the same width, which is the whole
        // point: without it a 200-step tree would be 401 nodes wide.
        assert_eq!(lattice.width[199], lattice.j_max);
        assert_eq!(lattice.width[lattice.j_max as usize], lattice.j_max);
    }

    fn bullet() -> LatticeBond {
        // A 4% semiannual ten-year bond, per 100 of notional. The flow at slice
        // zero is today's, and there isn't one.
        let mut flows = vec![2.0; SLICES + 1];
        flows[0] = 0.0;
        LatticeBond { flows, redemption: 100.0, calls: Vec::new() }
    }

    /// Cash flows for the same bond, as the curve module sees them.
    fn bullet_flows() -> Vec<(f64, f64)> {
        let mut flows: Vec<(f64, f64)> = (1..=SLICES).map(|i| (DT * i as f64, 2.0)).collect();
        if let Some(last) = flows.last_mut() {
            last.1 += 100.0;
        }
        flows
    }

    #[test]
    fn a_straight_bond_prices_the_same_on_the_tree_as_on_the_curve() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        let tree = lattice.bond_price(&bullet(), 0.0);
        let curve_pv = present_value(&bullet_flows(), &curve());
        // Fixed flows are worth their discounted value whatever the rate model
        // does around them, so this is an identity and not an approximation.
        assert!(libm::fabs(tree - curve_pv) < 1e-10, "tree {tree} vs curve {curve_pv}");
    }

    /// The test this module exists to pass.
    ///
    /// Two entirely separate code paths — a bisection over a closed-form
    /// discounted sum, and a bisection over a backward induction on a
    /// calibrated trinomial tree — have to land on the same number. Nothing
    /// makes them agree except both being right.
    #[test]
    fn oas_of_a_straight_bond_is_its_z_spread() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        for &offset in &[-6.0, -2.0, 0.0, 3.0, 8.0] {
            let price = present_value(&bullet_flows(), &curve()) + offset;
            let oas = lattice.option_adjusted_spread(&bullet(), price).unwrap();
            let z = z_spread(&bullet_flows(), &curve(), price).unwrap();
            assert!(
                libm::fabs(oas - z) < 1e-9,
                "at {offset:+}: oas {oas} vs z-spread {z}",
            );
        }
    }

    #[test]
    fn the_call_makes_the_bond_worth_less() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        let straight = lattice.bond_price(&bullet(), 0.0);
        let callable = lattice.bond_price(&bullet().callable_from(6, 100.0), 0.0);
        assert!(callable < straight, "callable {callable} vs straight {straight}");
        // The holder is short the option, so what they gave up is the gap.
        let option = lattice.option_value(&bullet().callable_from(6, 100.0), 0.0);
        assert!(libm::fabs(option - (straight - callable)) < 1e-12);
        assert!(option > 0.0);
    }

    #[test]
    fn a_call_struck_out_of_reach_is_worth_nothing() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        // Callable at 300 on a bond worth about par: the issuer would never.
        let unreachable = lattice.option_value(&bullet().callable_from(2, 300.0), 0.0);
        assert!(unreachable < 1e-9, "{unreachable}");
    }

    #[test]
    fn more_volatility_makes_the_option_worth_more() {
        let mut previous = 0.0;
        for &vol in &[0.004, 0.008, 0.015, 0.025] {
            let lattice = HullWhite { mean_reversion: 0.05, vol }.calibrate(&curve(), DT, SLICES);
            let option = lattice.option_value(&bullet().callable_from(6, 100.0), 0.0);
            assert!(option > previous, "vol {vol}: {option} after {previous}");
            previous = option;
        }
    }

    /// The reason OAS exists.
    ///
    /// A callable trades cheap to a straight bond because of the option, and a
    /// z-spread charges the whole discount to credit. OAS prices the option out
    /// and reports what is left, which is smaller — and the gap is the option,
    /// not an opinion.
    #[test]
    fn oas_is_tighter_than_the_z_spread_on_a_callable() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        let callable = bullet().callable_from(6, 100.0);
        let market = lattice.bond_price(&callable, 0.0080);

        let oas = lattice.option_adjusted_spread(&callable, market).unwrap();
        let z = z_spread(&bullet_flows(), &curve(), market).unwrap();

        assert!(libm::fabs(oas - 0.0080) < 1e-9, "oas {oas} should recover the 80bp it was priced at");
        assert!(z > oas, "z-spread {z} should be wider than oas {oas}");
        // The difference is the option, expressed in spread.
        assert!(z - oas > 0.0005, "the option is worth {:.1}bp of spread", (z - oas) * 1e4);
    }

    #[test]
    fn a_callable_loses_convexity_when_rates_fall() {
        // The issuer calls into a rally, so the holder's upside is capped: the
        // callable gains less from a rate fall than it loses from a rate rise.
        let callable = bullet().callable_from(4, 100.0);
        let price_on = |shift: f64| {
            let shocked = CurveShock::parallel(shift).apply(&curve());
            model().calibrate(&shocked, DT, SLICES).bond_price(&callable, 0.0)
        };
        let base = price_on(0.0);
        let gain = price_on(-100.0) - base;
        let loss = base - price_on(100.0);
        assert!(gain < loss, "gained {gain} on a rally, lost {loss} on a selloff");
    }

    #[test]
    fn declines_a_price_no_spread_reaches() {
        let lattice = model().calibrate(&curve(), DT, SLICES);
        assert!(lattice.option_adjusted_spread(&bullet(), -1.0).is_none());
        assert!(lattice.option_adjusted_spread(&bullet(), 1e9).is_none());
    }
}
