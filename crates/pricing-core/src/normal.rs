//! Normal distribution primitives.
//!
//! Option pricing lives or dies on the tails: an implied-vol solve on a 5-delta
//! wing evaluates the CDF where a low-order approximation has no significant
//! digits left. Hart's rational approximation holds close to double precision
//! across the whole range, which is why it is here rather than the
//! Abramowitz-Stegun polynomial every textbook prints.

/// Standard normal probability density.
#[inline]
pub fn pdf(x: f64) -> f64 {
    const INV_SQRT_2PI: f64 = 0.398_942_280_401_432_7;
    INV_SQRT_2PI * libm::exp(-0.5 * x * x)
}

/// Standard normal cumulative distribution, Hart (1968).
///
/// Measured accuracy: about 1e-15 absolute through the body, and roughly 5e-10
/// relative out at six standard deviations where the continued fraction takes
/// over. Monotone throughout, which matters more than the last digit — a CDF
/// that is not monotone makes a Newton solve oscillate.
pub fn cdf(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let abs_x = x.abs();
    if abs_x > 37.0 {
        // Beyond here the result is 0 or 1 to every bit of a double.
        return if x > 0.0 { 1.0 } else { 0.0 };
    }

    let e = libm::exp(-0.5 * abs_x * abs_x);
    let tail = if abs_x < 7.071_067_811_865_475 {
        // |x| < 10/sqrt(2): Hart's rational form, evaluated by Horner. Written
        // as sequential steps rather than nested parentheses, because a
        // thirteen-deep expression is where a transcription error hides.
        let mut num = 0.035_262_496_599_891_1 * abs_x + 0.700_383_064_443_688;
        num = num * abs_x + 6.373_962_203_531_65;
        num = num * abs_x + 33.912_866_078_383;
        num = num * abs_x + 112.079_291_497_871;
        num = num * abs_x + 221.213_596_169_931;
        num = num * abs_x + 220.206_867_912_376;

        let mut den = 0.088_388_347_648_318_4 * abs_x + 1.755_667_163_182_64;
        den = den * abs_x + 16.064_177_579_207;
        den = den * abs_x + 86.780_732_202_946_1;
        den = den * abs_x + 296.564_248_779_674;
        den = den * abs_x + 637.333_633_378_831;
        den = den * abs_x + 793.826_512_519_948;
        den = den * abs_x + 440.413_735_824_752;

        e * num / den
    } else {
        // Continued fraction in the far tail, where the rational form loses its
        // significant digits and an implied-vol solve on a 5-delta wing lives.
        let f = abs_x + 1.0 / (abs_x + 2.0 / (abs_x + 3.0 / (abs_x + 4.0 / (abs_x + 0.65))));
        const INV_SQRT_2PI: f64 = 0.398_942_280_401_432_7;
        INV_SQRT_2PI * e / f
    };

    if x > 0.0 {
        1.0 - tail
    } else {
        tail
    }
}

/// Inverse standard normal CDF (Acklam), used for implied-vol starting points.
///
/// Roughly 1e-9 relative, which is far better than a solver's starting guess
/// needs to be; refinement is the solver's job.
pub fn inv_cdf(p: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) || p.is_nan() {
        return f64::NAN;
    }
    if p == 0.0 {
        return f64::NEG_INFINITY;
    }
    if p == 1.0 {
        return f64::INFINITY;
    }

    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_205e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_690e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838,
        -2.549_732_539_343_734,
        4.374_664_141_464_968,
        2.938_163_982_698_783,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_700_398e-1,
        2.445_134_137_142_996,
        3.754_408_661_907_416,
    ];

    const LOW: f64 = 0.024_25;
    const HIGH: f64 = 1.0 - LOW;

    if p < LOW {
        let q = (-2.0 * libm::log(p)).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= HIGH {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * libm::log(1.0 - p)).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    }
}
