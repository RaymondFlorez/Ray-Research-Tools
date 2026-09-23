//! Pin risk and early-exercise carry (PRD 5.4).
//!
//! "Pin risk and assignment risk are computed and flagged."
//!
//! Both reduce to one number each, and both numbers are compared against a
//! threshold to decide whether the analyst sees a warning. That is why they are
//! here rather than in TypeScript: a comparison against a threshold is exactly
//! where a last-place difference between two math libraries becomes visible,
//! turning a flag on in the browser and off on the server, or the reverse. The
//! analyst then sees a warning that the export does not carry.
//!
//! The arithmetic itself is small. The reason it is in this crate is that it is
//! transcendental — `log`, `sqrt`, `exp` — and this crate is where the
//! transcendentals are the same on both targets.

use libm::{exp, log, sqrt};

/// Distance from spot to a strike, in units of the move still to come.
///
/// `|ln(S/K)| / (sigma*sqrt(T))`. A fixed percentage band cannot do this job:
/// two percent is far on a twelve-vol utility with two days left and close
/// enough to pin on a ninety-vol biotech, so a percentage flags the wrong book
/// in both directions.
///
/// Infinite as expiry approaches for every strike but the one the spot is
/// sitting on, which is what pinning means, and infinite for a zero-vol leg,
/// because nothing is uncertain about where that settles.
pub fn pin_sigmas(spot: f64, strike: f64, vol: f64, time: f64) -> f64 {
    if !(spot > 0.0) || !(strike > 0.0) {
        return f64::INFINITY;
    }
    let move_left = vol * sqrt(if time > 0.0 { time } else { 0.0 });
    if !(move_left > 0.0) {
        return if spot == strike { 0.0 } else { f64::INFINITY };
    }
    let distance = log(spot / strike);
    (if distance < 0.0 { -distance } else { distance }) / move_left
}

/// Present value of a continuous dividend yield paid over the option's life.
///
/// `S * (1 - exp(-q*T))`: the dividends a holder captures by owning the shares
/// rather than the option.
pub fn dividend_value(spot: f64, dividend: f64, time: f64) -> f64 {
    spot * (1.0 - exp(-dividend * time))
}

/// Interest given up by paying a strike now rather than at expiry.
pub fn strike_interest(strike: f64, rate: f64, time: f64) -> f64 {
    strike * (1.0 - exp(-rate * time))
}

/// A plain discount factor, for discounting a dated dividend.
pub fn discount(rate: f64, time: f64) -> f64 {
    exp(-rate * time)
}

/// What exercising an American option early is worth, before time value.
///
/// A call captures the dividends and gives up the interest on the strike; a put
/// earns the interest and gives up the dividends. Compare against the option's
/// extrinsic value: exercise is rational when this exceeds the time value it
/// throws away.
///
/// The sign does the work at the boundaries. A call on a non-dividend-paying
/// underlier has negative carry at every strike and every maturity, so it is
/// never flagged, which is the textbook result — and a rule phrased as "deep in
/// the money and close to expiry" would flag it constantly.
pub fn early_exercise_carry(
    spot: f64,
    strike: f64,
    rate: f64,
    dividend: f64,
    time: f64,
    is_call: bool,
) -> f64 {
    let dividends = dividend_value(spot, dividend, time);
    let interest = strike_interest(strike, rate, time);
    if is_call {
        dividends - interest
    } else {
        interest - dividends
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_strike_on_the_spot_is_zero_sigma() {
        assert_eq!(pin_sigmas(100.0, 100.0, 0.3, 1.0 / 252.0), 0.0);
    }

    #[test]
    fn every_other_strike_runs_away_as_expiry_approaches() {
        let far = pin_sigmas(100.0, 101.0, 0.3, 5.0 / 252.0);
        let near = pin_sigmas(100.0, 101.0, 0.3, 1.0 / 252.0);
        let at_expiry = pin_sigmas(100.0, 101.0, 0.3, 0.0);
        assert!(near > far);
        assert!(at_expiry.is_infinite());
    }

    #[test]
    fn the_same_percentage_is_far_at_low_vol_and_near_at_high() {
        // The property a fixed band cannot have. Two percent away with two
        // days to run is 1.85 sigma on a twelve-vol name and 0.25 on a
        // ninety-vol one: the same band, one flag, opposite answers.
        let utility = pin_sigmas(100.0, 102.0, 0.12, 2.0 / 252.0);
        let biotech = pin_sigmas(100.0, 102.0, 0.90, 2.0 / 252.0);
        assert!((utility - 1.852).abs() < 0.001, "{utility}");
        assert!((biotech - 0.247).abs() < 0.001, "{biotech}");
        // Sigmas scale inversely with vol, exactly.
        assert!((utility / biotech - 0.90 / 0.12).abs() < 1e-12);
    }

    #[test]
    fn a_call_with_no_dividend_never_pays_to_exercise_early() {
        for t in [0.01, 0.1, 0.5, 2.0] {
            for k in [50.0, 100.0, 150.0] {
                assert!(early_exercise_carry(100.0, k, 0.05, 0.0, t, true) <= 0.0);
            }
        }
    }

    #[test]
    fn a_put_with_no_dividend_always_earns_something_at_a_positive_rate() {
        assert!(early_exercise_carry(100.0, 120.0, 0.05, 0.0, 0.5, false) > 0.0);
    }

    #[test]
    fn a_deep_dividend_flips_the_call() {
        // Dividend yield well above the rate: the classic early-exercise case.
        assert!(early_exercise_carry(100.0, 80.0, 0.02, 0.10, 0.25, true) > 0.0);
    }

    #[test]
    fn carry_is_the_difference_of_its_two_parts() {
        let s = 103.5;
        let k = 97.25;
        let (r, q, t) = (0.043, 0.021, 0.37);
        let call = early_exercise_carry(s, k, r, q, t, true);
        let put = early_exercise_carry(s, k, r, q, t, false);
        assert_eq!(call, dividend_value(s, q, t) - strike_interest(k, r, t));
        assert_eq!(put, -call);
    }

    #[test]
    fn a_zero_rate_leaves_only_the_dividend() {
        assert_eq!(
            early_exercise_carry(100.0, 90.0, 0.0, 0.05, 1.0, true),
            dividend_value(100.0, 0.05, 1.0)
        );
    }
}
