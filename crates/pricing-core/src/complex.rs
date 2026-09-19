//! The minimum complex arithmetic the Heston characteristic function needs.
//!
//! Written here rather than pulled in, because the crate takes no dependencies
//! beyond `libm` and must produce identical bits natively and on
//! `wasm32-unknown-unknown`. Everything below is `libm` calls and arithmetic on
//! `f64` pairs, so there is nothing for a platform to disagree about.
//!
//! Only what is used: the characteristic function needs multiplication,
//! division, `exp`, `ln` and `sqrt`, and the Lewis integrand needs the real
//! part. A general complex library would be more to get wrong and none of it
//! would be exercised.
//!
//! The two functions worth reading are `sqrt` and `ln`, because both are
//! multivalued and the choice of branch is the whole numerical difficulty of
//! pricing Heston. See `heston.rs` for why the formulation there makes the
//! principal branch the correct one.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}

impl Complex {
    pub const fn new(re: f64, im: f64) -> Complex {
        Complex { re, im }
    }

    pub const fn real(re: f64) -> Complex {
        Complex { re, im: 0.0 }
    }

    pub const ZERO: Complex = Complex { re: 0.0, im: 0.0 };
    pub const ONE: Complex = Complex { re: 1.0, im: 0.0 };
    /// The imaginary unit.
    pub const I: Complex = Complex { re: 0.0, im: 1.0 };

    pub fn add(self, other: Complex) -> Complex {
        Complex::new(self.re + other.re, self.im + other.im)
    }

    pub fn sub(self, other: Complex) -> Complex {
        Complex::new(self.re - other.re, self.im - other.im)
    }

    pub fn neg(self) -> Complex {
        Complex::new(-self.re, -self.im)
    }

    pub fn mul(self, other: Complex) -> Complex {
        Complex::new(
            self.re * other.re - self.im * other.im,
            self.re * other.im + self.im * other.re,
        )
    }

    pub fn scale(self, factor: f64) -> Complex {
        Complex::new(self.re * factor, self.im * factor)
    }

    /// Division by the naive formula, with the denominator scaled first.
    ///
    /// Dividing by `c.re^2 + c.im^2` directly overflows when either part is
    /// past about 1e154 and underflows to zero when both are below 1e-162,
    /// neither of which is exotic inside an exponential. Smith's method scales
    /// by the larger part first, which costs a branch and removes both.
    pub fn div(self, other: Complex) -> Complex {
        if libm::fabs(other.re) >= libm::fabs(other.im) {
            if other.re == 0.0 {
                return Complex::new(f64::NAN, f64::NAN);
            }
            let ratio = other.im / other.re;
            let denominator = other.re + other.im * ratio;
            Complex::new(
                (self.re + self.im * ratio) / denominator,
                (self.im - self.re * ratio) / denominator,
            )
        } else {
            let ratio = other.re / other.im;
            let denominator = other.re * ratio + other.im;
            Complex::new(
                (self.re * ratio + self.im) / denominator,
                (self.im * ratio - self.re) / denominator,
            )
        }
    }

    pub fn abs(self) -> f64 {
        libm::hypot(self.re, self.im)
    }

    pub fn exp(self) -> Complex {
        let magnitude = libm::exp(self.re);
        Complex::new(magnitude * libm::cos(self.im), magnitude * libm::sin(self.im))
    }

    /// Principal logarithm: imaginary part in `(-pi, pi]`.
    pub fn ln(self) -> Complex {
        Complex::new(libm::log(self.abs()), libm::atan2(self.im, self.re))
    }

    /// Principal square root: the one with non-negative real part.
    ///
    /// Computed from the magnitude rather than through `exp(ln(z)/2)`, which
    /// loses a couple of digits near the negative real axis where the
    /// characteristic function's discriminant spends much of its time.
    pub fn sqrt(self) -> Complex {
        if self.re == 0.0 && self.im == 0.0 {
            return Complex::ZERO;
        }
        let magnitude = self.abs();
        let re = libm::sqrt((magnitude + self.re) * 0.5);
        let im = libm::sqrt((magnitude - self.re) * 0.5);
        Complex::new(re, if self.im < 0.0 { -im } else { im })
    }
}
