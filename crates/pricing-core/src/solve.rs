//! One-dimensional root finding, sized for determinism rather than speed.
//!
//! Bisection, not Newton or Brent. The curve bootstrap runs this a few dozen
//! times per build and the objective is monotone, so the fast methods buy
//! little — and bisection has a property they do not, which matters for the
//! PRD's bit-identical requirement (7.1).
//!
//! Bisection's control flow depends on nothing but the *sign* of the objective.
//! A last-bit disagreement between two targets can only matter within one ulp
//! of the root, where the bracket still contains it, so the answer moves by
//! bits and the iteration count does not move at all. Newton's step size is the
//! objective's value, so the same last-bit disagreement changes where the next
//! evaluation lands, how many are needed, and what the two targets converge to.
//!
//! Running to the last representable bit rather than to a tolerance costs about
//! three times as much — a bootstrap is 314us where 1e-12 would be near 100us —
//! and stays inside the sub-millisecond budget, so precision is the cheaper
//! thing to spend.

/// Finds a root of `f` in `[lo, hi]`, or `None` if the bracket does not contain
/// one.
///
/// Runs until the bracket cannot be halved again in `f64`, so the answer is the
/// best a double can express rather than whatever a tolerance allowed.
pub fn bisect<F: FnMut(f64) -> f64>(mut f: F, lo: f64, hi: f64) -> Option<f64> {
    let (mut lo, mut hi) = (lo, hi);
    let mut f_lo = f(lo);
    let mut f_hi = f(hi);

    if f_lo == 0.0 {
        return Some(lo);
    }
    if f_hi == 0.0 {
        return Some(hi);
    }
    if !f_lo.is_finite() || !f_hi.is_finite() || (f_lo > 0.0) == (f_hi > 0.0) {
        return None;
    }

    loop {
        let mid = 0.5 * (lo + hi);
        // The bracket is now two adjacent doubles: there is nothing between
        // them to test, and any tolerance-based exit would have stopped earlier
        // and less predictably.
        if mid == lo || mid == hi {
            return Some(mid);
        }
        let f_mid = f(mid);
        if f_mid == 0.0 {
            return Some(mid);
        }
        if (f_mid > 0.0) == (f_lo > 0.0) {
            lo = mid;
            f_lo = f_mid;
        } else {
            hi = mid;
            f_hi = f_mid;
        }
        let _ = f_hi;
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn finds_a_root_to_the_last_representable_bit() {
        let root = bisect(|x| x * x - 2.0, 0.0, 2.0).unwrap();
        // Not "close to" sqrt(2): the nearest double to it, or its neighbour.
        let exact = libm::sqrt(2.0);
        assert!((root - exact).abs() <= f64::EPSILON * 2.0, "{root} vs {exact}");
    }

    #[test]
    fn reports_a_bracket_that_holds_no_root() {
        assert!(bisect(|x| x * x + 1.0, -1.0, 1.0).is_none());
        assert!(bisect(|x| x, 1.0, 2.0).is_none());
    }

    #[test]
    fn takes_an_endpoint_that_is_already_the_root() {
        assert_eq!(bisect(|x| x - 3.0, 3.0, 9.0), Some(3.0));
        assert_eq!(bisect(|x| x - 9.0, 3.0, 9.0), Some(9.0));
    }

    #[test]
    fn refuses_a_bracket_it_cannot_evaluate() {
        assert!(bisect(|_| f64::NAN, 0.0, 1.0).is_none());
    }

    #[test]
    fn handles_a_decreasing_function() {
        let root = bisect(|x| 5.0 - x, 0.0, 10.0).unwrap();
        assert!((root - 5.0).abs() < 1e-15);
    }
}
