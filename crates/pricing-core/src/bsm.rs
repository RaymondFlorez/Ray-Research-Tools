//! Black-Scholes-Merton, with the full Greek set (PRD 5.4).
//!
//! "full Greeks including vanna, volga, charm, and speed, computed analytically
//! where closed forms exist and by adjoint differentiation otherwise."
//!
//! These all have closed forms, so they are computed directly and share the two
//! transcendentals — `n(d1)` and the two CDF evaluations — across every Greek.
//! On a 15,000-cell grid that sharing is most of the runtime.

use crate::normal::{cdf, pdf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionType {
    Call,
    Put,
}

impl OptionType {
    #[inline]
    fn sign(self) -> f64 {
        match self {
            OptionType::Call => 1.0,
            OptionType::Put => -1.0,
        }
    }
}

/// One option, fully specified. `q` is the continuous dividend yield.
#[derive(Clone, Copy, Debug)]
pub struct Inputs {
    pub spot: f64,
    pub strike: f64,
    /// Year fraction to expiry.
    pub time: f64,
    /// Continuously compounded risk-free rate.
    pub rate: f64,
    /// Continuous dividend yield.
    pub dividend: f64,
    pub vol: f64,
    pub kind: OptionType,
}

impl Inputs {
    /// Cost of carry, which is what the American approximations are written in.
    #[inline]
    pub fn carry(&self) -> f64 {
        self.rate - self.dividend
    }

    /// Value at expiry, ignoring everything but moneyness.
    #[inline]
    pub fn intrinsic(&self) -> f64 {
        match self.kind {
            OptionType::Call => (self.spot - self.strike).max(0.0),
            OptionType::Put => (self.strike - self.spot).max(0.0),
        }
    }

    /// True when the inputs are degenerate: expired, or zero vol.
    #[inline]
    pub fn is_degenerate(&self) -> bool {
        self.time <= 0.0 || self.vol <= 0.0 || self.spot <= 0.0 || self.strike <= 0.0
    }
}

/// Every Greek the PRD names, in one pass.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Greeks {
    pub price: f64,
    pub delta: f64,
    pub gamma: f64,
    /// Per 1.00 of vol (not per vol point).
    pub vega: f64,
    /// Per year.
    pub theta: f64,
    /// Per 1.00 of rate.
    pub rho: f64,
    /// d(delta)/d(vol).
    pub vanna: f64,
    /// d(vega)/d(vol).
    pub volga: f64,
    /// d(delta)/d(time).
    pub charm: f64,
    /// d(gamma)/d(spot).
    pub speed: f64,
}

struct Common {
    d1: f64,
    d2: f64,
    nd1: f64,
    disc_r: f64,
    disc_q: f64,
    sqrt_t: f64,
}

#[inline]
fn common(inputs: &Inputs) -> Common {
    let sqrt_t = inputs.time.sqrt();
    let vol_sqrt_t = inputs.vol * sqrt_t;
    let d1 = (libm::log(inputs.spot / inputs.strike)
        + (inputs.carry() + 0.5 * inputs.vol * inputs.vol) * inputs.time)
        / vol_sqrt_t;
    Common {
        d1,
        d2: d1 - vol_sqrt_t,
        nd1: pdf(d1),
        disc_r: libm::exp(-inputs.rate * inputs.time),
        disc_q: libm::exp(-inputs.dividend * inputs.time),
        sqrt_t,
    }
}

/// European price.
pub fn price(inputs: &Inputs) -> f64 {
    if inputs.is_degenerate() {
        // At expiry, or with no uncertainty left, the option is worth its
        // discounted intrinsic value and nothing more.
        if inputs.time <= 0.0 {
            return inputs.intrinsic();
        }
        let forward = inputs.spot * libm::exp(-inputs.dividend * inputs.time);
        let strike = inputs.strike * libm::exp(-inputs.rate * inputs.time);
        return match inputs.kind {
            OptionType::Call => (forward - strike).max(0.0),
            OptionType::Put => (strike - forward).max(0.0),
        };
    }

    let c = common(inputs);
    let sign = inputs.kind.sign();
    sign * (inputs.spot * c.disc_q * cdf(sign * c.d1)
        - inputs.strike * c.disc_r * cdf(sign * c.d2))
}

/// Price and every Greek, sharing the transcendentals.
pub fn greeks(inputs: &Inputs) -> Greeks {
    if inputs.is_degenerate() {
        let mut g = Greeks {
            price: price(inputs),
            ..Default::default()
        };
        // A degenerate option still has a delta: it is in or out of the money.
        if inputs.time <= 0.0 {
            g.delta = match inputs.kind {
                OptionType::Call => {
                    if inputs.spot > inputs.strike {
                        1.0
                    } else {
                        0.0
                    }
                }
                OptionType::Put => {
                    if inputs.spot < inputs.strike {
                        -1.0
                    } else {
                        0.0
                    }
                }
            };
        }
        return g;
    }

    let c = common(inputs);
    let sign = inputs.kind.sign();
    let n_sign_d1 = cdf(sign * c.d1);
    let n_sign_d2 = cdf(sign * c.d2);
    let vol_sqrt_t = inputs.vol * c.sqrt_t;

    let price = sign * (inputs.spot * c.disc_q * n_sign_d1 - inputs.strike * c.disc_r * n_sign_d2);
    let delta = sign * c.disc_q * n_sign_d1;
    let gamma = c.disc_q * c.nd1 / (inputs.spot * vol_sqrt_t);
    let vega = inputs.spot * c.disc_q * c.nd1 * c.sqrt_t;

    let theta = -inputs.spot * c.disc_q * c.nd1 * inputs.vol / (2.0 * c.sqrt_t)
        + sign * inputs.dividend * inputs.spot * c.disc_q * n_sign_d1
        - sign * inputs.rate * inputs.strike * c.disc_r * n_sign_d2;

    let rho = sign * inputs.strike * inputs.time * c.disc_r * n_sign_d2;
    let vanna = -c.disc_q * c.nd1 * c.d2 / inputs.vol;
    let volga = vega * c.d1 * c.d2 / inputs.vol;

    let charm = sign * inputs.dividend * c.disc_q * n_sign_d1
        - c.disc_q * c.nd1 * (2.0 * inputs.carry() * inputs.time - c.d2 * vol_sqrt_t)
            / (2.0 * inputs.time * vol_sqrt_t);

    let speed = -gamma / inputs.spot * (c.d1 / vol_sqrt_t + 1.0);

    Greeks {
        price,
        delta,
        gamma,
        vega,
        theta,
        rho,
        vanna,
        volga,
        charm,
        speed,
    }
}
