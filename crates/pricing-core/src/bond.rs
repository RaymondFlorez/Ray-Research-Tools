//! Bond analytics (PRD 5.3).
//!
//! "yield, duration, modified duration, convexity, DV01, key rate durations at
//! the standard tenor buckets, OAS for callables via a Hull-White short-rate
//! lattice, z-spread, asset swap spread."
//!
//! Two different questions live in this file and it is worth keeping them
//! apart. *Yield* metrics compress a bond to a single number and then describe
//! its behaviour in that number's own terms — useful, conventional, and blind
//! to the shape of the curve. *Spread* metrics keep the curve and ask what has
//! to be added to it, which is the question a relative-value analyst is
//! actually asking.
//!
//! Everything here that solves does so by bisection, for the reason
//! `crate::solve` gives: the control flow depends only on signs, so two targets
//! cannot converge to different answers.

use crate::curve::{present_value, CashFlows, Curve, CurveShock};
use crate::solve;

/// Price per 100 of notional, at a given yield.
///
/// Compounded `frequency` times a year, which is the convention a quoted yield
/// carries — a 5% semiannual yield is not a 5% annual one, and a function that
/// ignores the distinction is wrong by a quarter of a point on a ten-year bond.
pub fn price_at_yield(flows: &CashFlows, y: f64, frequency: f64) -> f64 {
    let f = frequency.max(1e-9);
    flows
        .iter()
        .map(|&(t, amount)| amount * libm::pow(1.0 + y / f, -f * t))
        .sum()
}

/// The yield that reproduces a price.
///
/// `None` when no yield in `(-99%, 1000%)` does — which happens for a cash flow
/// stream that is not a bond, and should be reported rather than approximated.
pub fn yield_to_maturity(flows: &CashFlows, price: f64, frequency: f64) -> Option<f64> {
    if flows.is_empty() || !price.is_finite() || price <= 0.0 {
        return None;
    }
    // Price falls as yield rises, so the bracket is the other way round from
    // the usual convention and bisection needs it stated that way.
    solve::bisect(|y| price_at_yield(flows, y, frequency) - price, -0.99, 10.0)
}

/// The conventional risk numbers, all derived from one yield.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct YieldMetrics {
    pub yield_to_maturity: f64,
    /// Time-weighted average of the discounted cash flows, in years.
    pub macaulay_duration: f64,
    /// Percentage price change per unit of yield.
    pub modified_duration: f64,
    /// Curvature of that relationship; what duration alone gets wrong.
    pub convexity: f64,
    /// Currency change in price for one basis point, per 100 of notional.
    pub dv01: f64,
}

/// Yield, duration and convexity for a price.
pub fn yield_metrics(flows: &CashFlows, price: f64, frequency: f64) -> Option<YieldMetrics> {
    let y = yield_to_maturity(flows, price, frequency)?;
    let f = frequency.max(1e-9);
    let base = 1.0 + y / f;

    let mut weighted = 0.0;
    let mut curvature = 0.0;
    for &(t, amount) in flows {
        let pv = amount * libm::pow(base, -f * t);
        weighted += t * pv;
        // d²P/dy² term: t(t + 1/f) / (1 + y/f)², in the same compounding.
        curvature += t * (t + 1.0 / f) * pv;
    }

    let macaulay = weighted / price;
    let modified = macaulay / base;
    Some(YieldMetrics {
        yield_to_maturity: y,
        macaulay_duration: macaulay,
        modified_duration: modified,
        convexity: curvature / (price * base * base),
        dv01: modified * price * 1e-4,
    })
}

/// The constant spread over the zero curve that reproduces a price.
///
/// Unlike a yield, this keeps the curve's shape and asks what the market is
/// charging on top of it — which is the number that survives a steepener.
/// Continuously compounded, like the curve it is added to.
pub fn z_spread(flows: &CashFlows, curve: &Curve, price: f64) -> Option<f64> {
    if flows.is_empty() || !price.is_finite() || price <= 0.0 {
        return None;
    }
    solve::bisect(
        |s| {
            let pv: f64 = flows
                .iter()
                .map(|&(t, amount)| amount * curve.discount(t) * libm::exp(-s * t))
                .sum();
            pv - price
        },
        -0.20,
        2.0,
    )
}

/// Par-par asset swap spread, in decimals of the notional.
///
/// The bond is bought at its market price and its coupons are swapped for
/// floating; the spread is what makes that package worth par. Which is
/// `(curve value of the coupons − what the bond cost) / the annuity`, so it
/// reads as "the mispricing, amortised over the life of the swap".
///
/// Different from the z-spread on purpose: a z-spread discounts the bond's own
/// flows at a shifted curve, while this one is a *par* trade and picks up the
/// difference between the bond's price and 100 as an upfront that the swap has
/// to carry.
pub fn asset_swap_spread(
    flows: &CashFlows,
    curve: &Curve,
    price: f64,
    frequency: f64,
    notional: f64,
) -> Option<f64> {
    let maturity = flows.iter().map(|&(t, _)| t).fold(0.0f64, f64::max);
    if maturity <= 0.0 {
        return None;
    }
    let f = frequency.max(1e-9);
    let accrual = 1.0 / f;
    let periods = libm::round(maturity * f).max(1.0) as usize;
    let annuity: f64 = (1..=periods)
        .map(|i| {
            let t = if i == periods { maturity } else { accrual * i as f64 };
            accrual * curve.discount(t)
        })
        .sum();
    if annuity <= 0.0 {
        return None;
    }
    // The annuity is per unit of notional and the price difference is in the
    // flows' own units, so the notional has to come in explicitly. Assuming 100
    // would be right for a bond quoted per hundred and a factor of a hundred
    // wrong for anything else, silently.
    if !notional.is_finite() || notional <= 0.0 {
        return None;
    }
    Some((present_value(flows, curve) - price) / (annuity * notional))
}

/// Effective duration and convexity, by shocking the curve rather than the yield.
///
/// The yield-based numbers assume a parallel move in a quantity the bond
/// defines for itself. These move the curve the bond is actually priced off, so
/// they stay meaningful for anything whose cash flows depend on rates — which
/// is every callable, and is why an OAS framework needs them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EffectiveRisk {
    pub duration: f64,
    pub convexity: f64,
    pub dv01: f64,
}

/// `price_on` is asked for a value on a shifted curve, so a callable can
/// reprice its option rather than just re-discounting fixed flows.
pub fn effective_risk<F>(curve: &Curve, bump_bps: f64, mut price_on: F) -> Option<EffectiveRisk>
where
    F: FnMut(&Curve) -> f64,
{
    let base = price_on(curve);
    if !base.is_finite() || base <= 0.0 {
        return None;
    }
    let up = price_on(&CurveShock::parallel(bump_bps).apply(curve));
    let down = price_on(&CurveShock::parallel(-bump_bps).apply(curve));
    let dy = bump_bps * 1e-4;

    let duration = (down - up) / (2.0 * base * dy);
    let convexity = (up + down - 2.0 * base) / (base * dy * dy);
    Some(EffectiveRisk { duration, convexity, dv01: duration * base * 1e-4 })
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::curve::{dv01, Curve};

    /// A `coupon`% bond maturing in `years`, paying `frequency` times a year.
    fn bond(coupon: f64, years: f64, frequency: f64) -> Vec<(f64, f64)> {
        let periods = (years * frequency) as usize;
        let mut flows: Vec<(f64, f64)> = (1..=periods)
            .map(|i| (i as f64 / frequency, 100.0 * coupon / frequency))
            .collect();
        if let Some(last) = flows.last_mut() {
            last.1 += 100.0;
        }
        flows
    }

    #[test]
    fn a_bond_priced_at_par_yields_its_coupon() {
        let flows = bond(0.04, 10.0, 2.0);
        let y = yield_to_maturity(&flows, 100.0, 2.0).unwrap();
        assert!(libm::fabs(y - 0.04) < 1e-12, "{y}");
    }

    #[test]
    fn yield_and_price_are_inverses() {
        let flows = bond(0.05, 7.0, 2.0);
        for &y in &[0.0, 0.01, 0.043, 0.09, 0.25] {
            let price = price_at_yield(&flows, y, 2.0);
            let back = yield_to_maturity(&flows, price, 2.0).unwrap();
            assert!(libm::fabs(back - y) < 1e-12, "{y} -> {price} -> {back}");
        }
    }

    #[test]
    fn price_falls_as_yield_rises() {
        let flows = bond(0.04, 10.0, 2.0);
        let mut previous = f64::INFINITY;
        for step in 0..40 {
            let price = price_at_yield(&flows, step as f64 * 0.005, 2.0);
            assert!(price < previous);
            previous = price;
        }
    }

    #[test]
    fn duration_is_shorter_than_maturity_and_longer_for_a_smaller_coupon() {
        let ten_year_4 = bond(0.04, 10.0, 2.0);
        let m4 = yield_metrics(&ten_year_4, 100.0, 2.0).unwrap();
        assert!(m4.macaulay_duration < 10.0, "{}", m4.macaulay_duration);
        assert!(m4.macaulay_duration > 8.0);
        // Modified is shorter than Macaulay by exactly one compounding factor.
        assert!(libm::fabs(m4.modified_duration - m4.macaulay_duration / 1.02) < 1e-12);

        // A lower coupon pushes weight towards the principal, so it lasts longer.
        let ten_year_2 = bond(0.02, 10.0, 2.0);
        let price = price_at_yield(&ten_year_2, 0.04, 2.0);
        let m2 = yield_metrics(&ten_year_2, price, 2.0).unwrap();
        assert!(m2.macaulay_duration > m4.macaulay_duration);

        // A zero coupon lasts exactly to maturity, by definition.
        let zero = [(10.0, 100.0)];
        let zero_price = price_at_yield(&zero, 0.04, 2.0);
        let mz = yield_metrics(&zero, zero_price, 2.0).unwrap();
        assert!(libm::fabs(mz.macaulay_duration - 10.0) < 1e-12);
    }

    /// Duration and convexity are a Taylor expansion, so they have to predict
    /// the actual repricing — that is the only thing they are for.
    #[test]
    fn duration_and_convexity_predict_a_repricing() {
        let flows = bond(0.04, 10.0, 2.0);
        let m = yield_metrics(&flows, 100.0, 2.0).unwrap();
        let error = |move_bps: f64| {
            let dy = move_bps * 1e-4;
            let predicted = 100.0 * (1.0 - m.modified_duration * dy + 0.5 * m.convexity * dy * dy);
            libm::fabs(predicted - price_at_yield(&flows, 0.04 + dy, 2.0))
        };

        // A hundred basis points leaves about a cent and a half on a hundred of
        // notional, which is the third-order term and not an error.
        assert!(error(100.0) < 0.02, "{}", error(100.0));

        // The claim being tested is that the expansion is right to *second*
        // order, and that is a statement about how the residual shrinks, not
        // about any one tolerance: halve the move and the leftover should fall
        // by eight.
        let ratio = error(100.0) / error(50.0);
        assert!((6.0..10.0).contains(&ratio), "residual fell by {ratio}x, not ~8x");
    }

    #[test]
    fn convexity_is_positive_for_an_ordinary_bond() {
        let flows = bond(0.04, 30.0, 2.0);
        let m = yield_metrics(&flows, 100.0, 2.0).unwrap();
        assert!(m.convexity > 0.0);
        // And a longer bond has more of it.
        let short = yield_metrics(&bond(0.04, 3.0, 2.0), 100.0, 2.0).unwrap();
        assert!(m.convexity > short.convexity * 10.0);
    }

    #[test]
    fn declines_a_price_no_yield_produces() {
        assert!(yield_to_maturity(&[], 100.0, 2.0).is_none());
        assert!(yield_to_maturity(&bond(0.04, 5.0, 2.0), -5.0, 2.0).is_none());
        // A price above the undiscounted sum of the flows needs a yield below
        // -99%, and saying so beats returning the edge of the bracket.
        assert!(yield_to_maturity(&bond(0.04, 5.0, 2.0), 1e9, 2.0).is_none());
    }

    // -- spreads ------------------------------------------------------------

    fn curve() -> Curve {
        Curve::from_zeros(
            &[0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 30.0],
            &[0.0515, 0.0472, 0.0428, 0.0404, 0.0389, 0.0388, 0.0394, 0.0399],
        )
    }

    #[test]
    fn a_bond_priced_off_the_curve_has_no_z_spread() {
        let flows = bond(0.04, 10.0, 2.0);
        let fair = present_value(&flows, &curve());
        let z = z_spread(&flows, &curve(), fair).unwrap();
        assert!(libm::fabs(z) < 1e-12, "{z}");
    }

    #[test]
    fn a_cheaper_bond_has_a_wider_z_spread() {
        let flows = bond(0.04, 10.0, 2.0);
        let fair = present_value(&flows, &curve());
        let wide = z_spread(&flows, &curve(), fair - 3.0).unwrap();
        let tight = z_spread(&flows, &curve(), fair + 3.0).unwrap();
        assert!(wide > 0.0 && tight < 0.0, "{wide} / {tight}");
        // Roughly price difference over duration: three points on a bond of
        // about eight years is around forty basis points.
        assert!((0.0030..0.0060).contains(&wide), "{wide}");
    }

    #[test]
    fn the_z_spread_survives_a_shape_change_that_moves_the_yield() {
        // Two curves with the same 10y point and different shapes. A yield
        // reads the same bond differently under each; a z-spread is measured
        // against the curve, so the cheapness it reports is the same cheapness.
        let flows = bond(0.04, 10.0, 2.0);
        let steep = CurveShock::steepener(60.0, 5.0).apply(&curve());
        let price_flat = present_value(&flows, &curve()) - 2.0;
        let price_steep = present_value(&flows, &steep) - 2.0;

        let z_flat = z_spread(&flows, &curve(), price_flat).unwrap();
        let z_steep = z_spread(&flows, &steep, price_steep).unwrap();
        assert!(libm::fabs(z_flat - z_steep) < 5e-4, "{z_flat} vs {z_steep}");
    }

    #[test]
    fn the_asset_swap_spread_is_zero_for_a_bond_at_its_curve_value() {
        let flows = bond(0.04, 10.0, 2.0);
        let fair = present_value(&flows, &curve());
        let asw = asset_swap_spread(&flows, &curve(), fair, 2.0, 100.0).unwrap();
        assert!(libm::fabs(asw) < 1e-14, "{asw}");
    }

    #[test]
    fn the_asset_swap_spread_widens_as_the_bond_cheapens() {
        let flows = bond(0.04, 10.0, 2.0);
        let fair = present_value(&flows, &curve());
        let cheap = asset_swap_spread(&flows, &curve(), fair - 3.0, 2.0, 100.0).unwrap();
        let rich = asset_swap_spread(&flows, &curve(), fair + 3.0, 2.0, 100.0).unwrap();
        assert!(cheap > 0.0 && rich < 0.0);
        // Near the z-spread for a bond near par, and not identical to it: the
        // par-par package carries the price difference as an upfront.
        let z = z_spread(&flows, &curve(), fair - 3.0).unwrap();
        assert!(libm::fabs(cheap - z) < 0.0010, "asw {cheap} vs z {z}");
    }

    // -- effective risk -----------------------------------------------------

    #[test]
    fn effective_duration_matches_the_analytic_one_for_fixed_flows() {
        let flows = bond(0.04, 10.0, 2.0);
        let base = present_value(&flows, &curve());
        let effective =
            effective_risk(&curve(), 25.0, |c| present_value(&flows, c)).unwrap();

        // Against *Macaulay*, not modified. The curve is continuously
        // compounded, so shocking it is a shock to a continuous rate, and the
        // continuous-compounding modified duration simply is the Macaulay one.
        // Comparing against the semiannual modified duration instead looks
        // nearly right and is off by a factor of (1 + y/2) — two percent on
        // this bond, which is the kind of silent bias a risk system carries for
        // years.
        let analytic = yield_metrics(&flows, base, 2.0).unwrap();
        assert!(
            libm::fabs(effective.duration - analytic.macaulay_duration) < 0.01,
            "effective {} vs macaulay {} (modified was {})",
            effective.duration,
            analytic.macaulay_duration,
            analytic.modified_duration,
        );
        assert!(
            libm::fabs(effective.duration - analytic.modified_duration) > 0.1,
            "the compounding conventions should differ, and visibly",
        );
        // And it agrees with the curve module's own DV01, which computes it a
        // third way.
        assert!(libm::fabs(effective.dv01 - dv01(&flows, &curve())) < 5e-4);
    }

    #[test]
    fn effective_convexity_is_positive_for_fixed_flows() {
        let flows = bond(0.04, 30.0, 2.0);
        let risk = effective_risk(&curve(), 50.0, |c| present_value(&flows, c)).unwrap();
        assert!(risk.convexity > 0.0, "{}", risk.convexity);
    }

    #[test]
    fn declines_to_measure_risk_on_a_worthless_position() {
        assert!(effective_risk(&curve(), 25.0, |_| 0.0).is_none());
    }
}
