//! Special functions the simulation layer needs and `libm` does not have.
//!
//! Two of them: the log gamma function, and the regularized incomplete beta
//! function. The second is what makes a Student-t CDF possible, and a Student-t
//! CDF is what makes a t-copula a copula rather than a pile of correlated
//! variates — the marginals have to be mapped to uniforms, and that mapping is
//! the CDF.
//!
//! Both are the standard constructions (Lanczos, and Lentz's continued
//! fraction), written out because this crate takes no dependencies: every line
//! here has to compile to WASM and produce the same bits as the native build.

/// Lanczos approximation, g = 7, n = 9. Good to about 15 digits for x > 0.
pub fn ln_gamma(x: f64) -> f64 {
    const COEFFICIENTS: [f64; 9] = [
        0.999_999_999_999_809_93,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];

    if x < 0.5 {
        // Reflection. The gamma function has poles at the non-positive
        // integers, and the caller asking for one is a bug upstream rather
        // than a value to approximate.
        return libm::log(core::f64::consts::PI / libm::sin(core::f64::consts::PI * x)) - ln_gamma(1.0 - x);
    }

    let z = x - 1.0;
    let mut series = COEFFICIENTS[0];
    for (i, c) in COEFFICIENTS.iter().enumerate().skip(1) {
        series += c / (z + i as f64);
    }
    let t = z + 7.5;
    0.5 * libm::log(2.0 * core::f64::consts::PI) + (z + 0.5) * libm::log(t) - t + libm::log(series)
}

/// `ln B(a, b)`.
pub fn ln_beta(a: f64, b: f64) -> f64 {
    ln_gamma(a) + ln_gamma(b) - ln_gamma(a + b)
}

/// The regularized incomplete beta function `I_x(a, b)`.
///
/// Lentz's modified continued fraction, with the symmetry
/// `I_x(a,b) = 1 - I_{1-x}(b,a)` applied so the fraction is always evaluated
/// in the half where it converges quickly. Without the swap the tail costs
/// hundreds of iterations and loses digits; with it, thirty is plenty.
pub fn inc_beta(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let front = libm::exp(a * libm::log(x) + b * libm::log(1.0 - x) - ln_beta(a, b));
    if x < (a + 1.0) / (a + b + 2.0) {
        front * beta_cf(x, a, b) / a
    } else {
        1.0 - libm::exp(b * libm::log(1.0 - x) + a * libm::log(x) - ln_beta(b, a)) * beta_cf(1.0 - x, b, a) / b
    }
}

const TINY: f64 = 1e-300;

fn beta_cf(x: f64, a: f64, b: f64) -> f64 {
    let qab = a + b;
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if libm::fabs(d) < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut result = d;

    for m in 1..=200 {
        let m = m as f64;
        let m2 = 2.0 * m;

        let numerator = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + numerator * d;
        if libm::fabs(d) < TINY {
            d = TINY;
        }
        c = 1.0 + numerator / c;
        if libm::fabs(c) < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        result *= d * c;

        let numerator = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + numerator * d;
        if libm::fabs(d) < TINY {
            d = TINY;
        }
        c = 1.0 + numerator / c;
        if libm::fabs(c) < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let delta = d * c;
        result *= delta;

        if libm::fabs(delta - 1.0) < 1e-15 {
            break;
        }
    }
    result
}

/// The Student-t CDF with `nu` degrees of freedom.
pub fn student_t_cdf(x: f64, nu: f64) -> f64 {
    if nu <= 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return 0.5;
    }
    let tail = 0.5 * inc_beta(nu / (nu + x * x), 0.5 * nu, 0.5);
    if x > 0.0 {
        1.0 - tail
    } else {
        tail
    }
}

/// The Student-t quantile, by bisection on the CDF.
///
/// Bisection rather than Newton for the same reason the implied-vol solver
/// uses it: the control flow depends only on the sign of a difference, so the
/// native and WASM builds take the same branches and return the same bits.
pub fn student_t_inv_cdf(p: f64, nu: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) || nu <= 0.0 {
        return f64::NAN;
    }
    if p == 0.0 {
        return f64::NEG_INFINITY;
    }
    if p == 1.0 {
        return f64::INFINITY;
    }

    let mut low = -1.0;
    let mut high = 1.0;
    while student_t_cdf(low, nu) > p {
        low *= 2.0;
        if low < -1e12 {
            return f64::NEG_INFINITY;
        }
    }
    while student_t_cdf(high, nu) < p {
        high *= 2.0;
        if high > 1e12 {
            return f64::INFINITY;
        }
    }

    for _ in 0..200 {
        let mid = 0.5 * (low + high);
        if student_t_cdf(mid, nu) < p {
            low = mid;
        } else {
            high = mid;
        }
    }
    0.5 * (low + high)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ln_gamma_matches_known_values() {
        // Gamma(5) = 24, Gamma(0.5) = sqrt(pi), Gamma(1) = Gamma(2) = 1.
        assert!((libm::exp(ln_gamma(5.0)) - 24.0).abs() < 1e-9);
        assert!((ln_gamma(0.5) - 0.5 * libm::log(core::f64::consts::PI)).abs() < 1e-12);
        assert!(ln_gamma(1.0).abs() < 1e-12);
        assert!(ln_gamma(2.0).abs() < 1e-12);
    }

    #[test]
    fn ln_gamma_satisfies_the_recurrence() {
        // Gamma(x+1) = x * Gamma(x), which the approximation has no reason to
        // satisfy unless it is actually right.
        for x in [0.3_f64, 1.7, 4.4, 9.1, 30.0] {
            let lhs = ln_gamma(x + 1.0);
            let rhs = libm::log(x) + ln_gamma(x);
            assert!((lhs - rhs).abs() < 1e-11, "x = {x}: {lhs} vs {rhs}");
        }
    }

    #[test]
    fn incomplete_beta_is_symmetric_and_bounded() {
        for &(x, a, b) in &[(0.3, 2.0, 3.0), (0.7, 0.5, 0.5), (0.1, 5.0, 1.5), (0.95, 3.0, 7.0)] {
            let left = inc_beta(x, a, b);
            let right = inc_beta(1.0 - x, b, a);
            assert!((left + right - 1.0).abs() < 1e-12, "{x} {a} {b}: {left} + {right}");
            assert!((0.0..=1.0).contains(&left));
        }
    }

    #[test]
    fn student_t_matches_the_normal_in_the_limit() {
        // t with a million degrees of freedom is a normal to five places.
        for x in [-2.5_f64, -1.0, 0.5, 1.96, 3.0] {
            let t = student_t_cdf(x, 1_000_000.0);
            let n = crate::normal::cdf(x);
            assert!((t - n).abs() < 1e-5, "x = {x}: {t} vs {n}");
        }
    }

    #[test]
    fn student_t_matches_the_cauchy_at_one_degree() {
        // t_1 is Cauchy, whose CDF is 0.5 + atan(x)/pi in closed form.
        for x in [-3.0_f64, -0.5, 0.0, 1.0, 4.0] {
            let t = student_t_cdf(x, 1.0);
            let cauchy = 0.5 + libm::atan(x) / core::f64::consts::PI;
            assert!((t - cauchy).abs() < 1e-12, "x = {x}: {t} vs {cauchy}");
        }
    }

    #[test]
    fn student_t_matches_published_quantiles() {
        // Two-sided 95 percent critical values, from any table.
        for &(nu, expected) in &[(1.0, 12.706), (2.0, 4.3027), (5.0, 2.5706), (10.0, 2.2281), (30.0, 2.0423)] {
            let q = student_t_inv_cdf(0.975, nu);
            assert!((q - expected).abs() < 5e-4, "nu = {nu}: {q} vs {expected}");
        }
    }

    #[test]
    fn student_t_quantile_inverts_the_cdf() {
        for nu in [3.0_f64, 8.0, 25.0] {
            for p in [0.001, 0.05, 0.5, 0.9, 0.9995] {
                let x = student_t_inv_cdf(p, nu);
                assert!((student_t_cdf(x, nu) - p).abs() < 1e-12, "nu {nu} p {p}");
            }
        }
    }
}
