//! Volatility analytics (PRD 5.4).
//!
//! "Vol analytics: term structure, skew and its history, realized vs implied
//! spread, variance risk premium, and event-implied moves backed out of the
//! straddle around a known date."
//!
//! Three of those are one subtraction each once the inputs are right, and
//! getting the inputs right is the whole job. What is here is the part that is
//! arithmetic rather than bookkeeping: realized volatility from a price series,
//! the forward volatility between two expiries, and the volatility the market
//! attributes to a dated event.

use libm::{log, sqrt};

/// Trading days in a year, which is what an implied volatility is quoted in.
pub const TRADING_DAYS: f64 = 252.0;

/// Realized volatility from a close series, annualized.
///
/// Close-to-close log returns, **without subtracting the sample mean**. Over
/// the windows anybody uses this on — twenty days, sixty days — the sample mean
/// is an estimate of drift whose standard error is several times the drift
/// itself, so subtracting it removes more signal than bias. The convention also
/// has to match the one on the other side of the comparison: an implied
/// volatility is a zero-drift diffusion parameter, and a realized number that
/// centred its returns would be measuring something slightly different from the
/// thing it is being differenced against.
///
/// Returns NaN for fewer than two closes, or for a non-positive close: there is
/// no log return to take, and a zero volatility would read as a calm market
/// rather than as missing data.
pub fn realized_vol(closes: &[f64], periods_per_year: f64) -> f64 {
    if closes.len() < 2 {
        return f64::NAN;
    }
    let mut sum_squares = 0.0;
    for window in closes.windows(2) {
        let (previous, current) = (window[0], window[1]);
        if !(previous > 0.0) || !(current > 0.0) {
            return f64::NAN;
        }
        let r = log(current / previous);
        sum_squares += r * r;
    }
    let n = (closes.len() - 1) as f64;
    sqrt(sum_squares / n * periods_per_year)
}

/// Realized variance over the window, annualized, for a variance comparison.
///
/// The square of `realized_vol` by construction, and separate because a
/// variance premium is a difference of *variances* and squaring a rounded
/// volatility is not the same number.
pub fn realized_variance(closes: &[f64], periods_per_year: f64) -> f64 {
    let vol = realized_vol(closes, periods_per_year);
    vol * vol
}

/// The volatility between two expiries, implied by their two total variances.
///
/// `sqrt((v2^2*t2 - v1^2*t1) / (t2 - t1))`. Negative forward variance is not a
/// numerical accident: it means the near expiry's quotes carry more total
/// variance than the far one's, which is a calendar arbitrage in the quotes.
/// Returned as NaN so the caller has to decide what to say about it, rather
/// than clamped to zero — a flat forward curve is a statement about the market
/// and this is a statement about the data.
pub fn forward_vol(t1: f64, v1: f64, t2: f64, v2: f64) -> f64 {
    if !(t2 > t1) || !(t1 >= 0.0) {
        return f64::NAN;
    }
    let total = v2 * v2 * t2 - v1 * v1 * t1;
    if total < 0.0 {
        return f64::NAN;
    }
    sqrt(total / (t2 - t1))
}

/// The move the market attributes to a dated event, as a fraction of spot.
///
/// Two expiries bracket the event: `t_before` ends before it and `t_after`
/// spans it. The diffusive variance rate is read off the first and extended
/// over the second, and whatever total variance is left over belongs to the
/// event:
///
/// ```text
/// jump^2 = v_after^2 * t_after - v_before^2 * t_after
/// ```
///
/// The naive reading — straddle price over spot — is the *whole* expected move
/// over those days, including the ordinary diffusion that would have happened
/// with no event at all, and it overstates the event by exactly that amount.
/// On a five-day expiry over a 30-vol name the diffusion alone is 4.2 percent,
/// which is most of what a naive reading would call the earnings move.
///
/// NaN when the event expiry carries no more variance rate than the quiet one:
/// there is no event premium in those quotes, and reporting zero would suggest
/// the market expects nothing rather than that these quotes do not say.
pub fn event_move(t_before: f64, v_before: f64, t_after: f64, v_after: f64) -> f64 {
    if !(t_after > 0.0) || !(t_before > 0.0) {
        return f64::NAN;
    }
    let excess = (v_after * v_after - v_before * v_before) * t_after;
    if excess <= 0.0 {
        return f64::NAN;
    }
    sqrt(excess)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A series whose every log return is the same size: the volatility is
    /// known in closed form without any estimation.
    fn alternating(n: usize, step: f64) -> Vec<f64> {
        let mut closes = vec![100.0];
        for i in 0..n {
            let previous = closes[i];
            closes.push(if i % 2 == 0 { previous * (1.0 + step) } else { previous / (1.0 + step) });
        }
        closes
    }

    #[test]
    fn realized_vol_recovers_a_known_step() {
        let step = 0.01;
        let closes = alternating(40, step);
        let expected = log(1.0 + step) * sqrt(TRADING_DAYS);
        assert!((realized_vol(&closes, TRADING_DAYS) - expected).abs() < 1e-12);
    }

    #[test]
    fn realized_vol_does_not_centre_its_returns() {
        // A pure trend has zero volatility if you subtract the mean and a real
        // one if you do not. The second is what an implied vol is compared to.
        let closes: Vec<f64> = (0..40).map(|i| 100.0 * 1.001_f64.powi(i)).collect();
        let vol = realized_vol(&closes, TRADING_DAYS);
        assert!((vol - log(1.001) * sqrt(TRADING_DAYS)).abs() < 1e-12);
        assert!(vol > 0.0);
    }

    #[test]
    fn realized_variance_is_the_square() {
        let closes = alternating(30, 0.008);
        let vol = realized_vol(&closes, TRADING_DAYS);
        assert_eq!(realized_variance(&closes, TRADING_DAYS), vol * vol);
    }

    #[test]
    fn a_short_or_broken_series_is_not_a_calm_one() {
        assert!(realized_vol(&[100.0], TRADING_DAYS).is_nan());
        assert!(realized_vol(&[], TRADING_DAYS).is_nan());
        assert!(realized_vol(&[100.0, 0.0, 100.0], TRADING_DAYS).is_nan());
    }

    #[test]
    fn a_flat_term_structure_has_a_flat_forward() {
        assert!((forward_vol(0.25, 0.3, 0.5, 0.3) - 0.3).abs() < 1e-12);
    }

    #[test]
    fn forward_vol_exceeds_both_when_the_far_expiry_is_higher() {
        let f = forward_vol(0.25, 0.20, 0.5, 0.30);
        assert!(f > 0.30);
    }

    #[test]
    fn a_calendar_arbitrage_is_not_a_number() {
        // Less total variance at the far expiry than the near one.
        assert!(forward_vol(0.5, 0.40, 1.0, 0.25).is_nan());
        assert!(forward_vol(0.5, 0.3, 0.25, 0.3).is_nan());
    }

    #[test]
    fn the_event_move_strips_the_diffusion_out() {
        // Five trading days, 30 vol quiet, 55 vol over the print.
        let t = 5.0 / TRADING_DAYS;
        let jump = event_move(t, 0.30, t, 0.55);
        let naive = 0.55 * sqrt(t);
        assert!(jump < naive);
        // The diffusion alone over those days is 4.2 percent.
        assert!((0.30 * sqrt(t) - 0.0423).abs() < 1e-3);
        assert!((jump - sqrt((0.55 * 0.55 - 0.30 * 0.30) * t)).abs() < 1e-15);
    }

    #[test]
    fn quotes_with_no_event_premium_say_nothing_rather_than_zero() {
        let t = 5.0 / TRADING_DAYS;
        assert!(event_move(t, 0.30, t, 0.30).is_nan());
        assert!(event_move(t, 0.35, t, 0.30).is_nan());
    }
}
